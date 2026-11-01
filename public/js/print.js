/* Printing.
 *
 * Method "browserprint": talks to Zebra Browser Print, Zebra's free helper app
 * that runs on the check-in computer and exposes the USB/network printer at
 * http://127.0.0.1:9100 (https://localhost:9101). We send raw ZPL to it.
 *
 * Method "dialog": renders the label as a tiny web page sized to the label and
 * opens the browser's print dialog (works with the Zebra driver installed as a
 * normal printer; Chrome's --kiosk-printing flag skips the dialog).
 */
const Printer = (() => {
  /* Zebra's own library uses http://127.0.0.1:9100 everywhere except Safari on an
     https page, which must use the helper's https port. */
  const HOSTS = ['http://127.0.0.1:9100', 'https://127.0.0.1:9101'];
  const SAFARI = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  const HOST_KEY = 'kc.bp.host';
  const PRINTER_KEY = 'kc.printer';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  };

  async function fetchWithTimeout(url, opts, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, Object.assign({ signal: ctrl.signal, mode: 'cors' }, opts));
    } finally {
      clearTimeout(timer);
    }
  }

  /* Try the remembered host first, then the others. */
  async function request(path, opts = {}, timeoutMs = 5000) {
    const remembered = store.get(HOST_KEY);
    let order = HOSTS.slice();
    if (SAFARI && location.protocol === 'https:') order.reverse();
    if (remembered) order = [remembered].concat(order.filter((h) => h !== remembered));
    let lastErr = null;
    for (const host of order) {
      try {
        const res = await fetchWithTimeout(host + path, opts, timeoutMs);
        store.set(HOST_KEY, host);
        return res;
      } catch (e) {
        lastErr = e;
      }
    }
    const err = new Error('Zebra Browser Print is not running on this computer (or has not been allowed for this site yet).');
    err.cause = lastErr;
    err.notRunning = true;
    throw err;
  }

  async function readJson(res) {
    const text = await res.text();
    if (!res.ok) throw new Error('Printer helper error: ' + (text || res.status));
    if (!text.trim()) return null;
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  async function getDefault() {
    return readJson(await request('/default?type=printer'));
  }

  async function available() {
    const data = await readJson(await request('/available'));
    return (data && data.printer) || [];
  }

  async function write(device, data) {
    /* Same fields Zebra's library echoes back; no JSON content-type header so the
       request stays "simple" (no CORS preflight, which the helper doesn't answer). */
    const dev = {
      name: device.name, uid: device.uid, connection: device.connection, deviceType: device.deviceType,
      version: 2, provider: device.provider, manufacturer: device.manufacturer,
    };
    const res = await request('/write', { method: 'POST', body: JSON.stringify({ device: dev, data }) }, 15000);
    const text = await res.text();
    if (!res.ok) throw new Error('The printer helper rejected the job: ' + (text || res.status));
    return text;
  }

  function savedPrinter() {
    try { return JSON.parse(store.get(PRINTER_KEY) || 'null'); } catch (e) { return null; }
  }
  function savePrinter(device) { store.set(PRINTER_KEY, device ? JSON.stringify(device) : null); }

  async function resolvePrinter() {
    const saved = savedPrinter();
    if (saved) return saved;
    const def = await getDefault();
    if (!def || !def.name) {
      const err = new Error('No Zebra printer found. Plug in the printer, then pick it under Admin → Settings → Printer.');
      err.noPrinter = true;
      throw err;
    }
    return def;
  }

  async function printZpl(zpl) {
    const device = await resolvePrinter();
    await write(device, zpl);
    return device;
  }

  /* ---- fallback: the browser's own print dialog ------------------------ */
  function dialogDocument(labels, labelCfg) {
    const w = labelCfg.width_in, h = labelCfg.height_in;
    const rotate = !!labelCfg.rotate;
    const pageW = w, pageH = h;
    const pages = labels.map((l) => {
      const inner = LabelPreview.html(l, labelCfg, { forPrint: true });
      return '<div class="page"><div class="rot">' + inner + '</div></div>';
    }).join('');
    const readW = rotate ? h : w, readH = rotate ? w : h;
    return '<!doctype html><html><head><meta charset="utf-8"><title>Labels</title><style>'
      + '@page{size:' + pageW + 'in ' + pageH + 'in;margin:0}'
      + 'html,body{margin:0;padding:0;background:#fff}'
      + '.page{width:' + pageW + 'in;height:' + pageH + 'in;overflow:hidden;page-break-after:always;position:relative}'
      + '.rot{position:absolute;width:' + readW + 'in;height:' + readH + 'in;'
      + (rotate ? 'left:0;top:0;transform-origin:top left;transform:rotate(90deg) translateY(-100%);' : '')
      + '}'
      + LabelPreview.css(readW, readH)
      + '</style></head><body>' + pages + '</body></html>';
  }

  function printDialog(labels, labelCfg) {
    return new Promise((resolve, reject) => {
      const frame = document.createElement('iframe');
      frame.setAttribute('aria-hidden', 'true');
      frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
      document.body.appendChild(frame);
      const doc = frame.contentDocument || frame.contentWindow.document;
      doc.open();
      doc.write(dialogDocument(labels, labelCfg));
      doc.close();
      const win = frame.contentWindow;
      const done = () => { setTimeout(() => frame.remove(), 1000); resolve(); };
      win.onafterprint = done;
      setTimeout(() => {
        try { win.focus(); win.print(); setTimeout(done, 60000); } catch (e) { frame.remove(); reject(e); }
      }, 150);
    });
  }

  /* ---- public ---------------------------------------------------------- */
  return {
    getDefault, available, write, savedPrinter, savePrinter, printZpl,
    async status() {
      try {
        const printers = await available();
        const saved = savedPrinter();
        return { running: true, printers, selected: saved || printers[0] || null };
      } catch (e) {
        return { running: false, printers: [], selected: savedPrinter(), error: e.message };
      }
    },
    /* labels: [{kind, fields, zpl}] from the API. method: 'browserprint' | 'dialog'. */
    async printLabels(labels, method, labelCfg) {
      if (!labels || !labels.length) return { printed: 0 };
      if (method === 'dialog') {
        await printDialog(labels, labelCfg);
        return { printed: labels.length, method };
      }
      const device = await printZpl(labels.map((l) => l.zpl).join('\n'));
      return { printed: labels.length, method, printer: device.name };
    },
    async testPrint(zpl, method, labelCfg, sampleLabel) {
      if (method === 'dialog') return printDialog([sampleLabel], labelCfg);
      return printZpl(zpl);
    },
  };
})();
