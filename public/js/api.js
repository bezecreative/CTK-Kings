/* Small fetch wrapper shared by the kiosk and admin pages. */
const Api = (() => {
  let role = 'kiosk';
  let onUnauthorized = null;

  const key = () => 'kc.' + role + '.token';
  const token = () => { try { return localStorage.getItem(key()) || ''; } catch (e) { return ''; } };
  const setToken = (t) => { try { t ? localStorage.setItem(key(), t) : localStorage.removeItem(key()); } catch (e) { /* private mode */ } };

  async function request(method, path, body, opts = {}) {
    const headers = { 'Accept': 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const t = token();
    if (t) headers['Authorization'] = 'Bearer ' + t;
    let res;
    try {
      res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      throw new Error('Could not reach the server. Check the internet connection.');
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text }; }
    if (res.status === 401 && !opts.silent) {
      setToken('');
      if (onUnauthorized) onUnauthorized();
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || ('Request failed (' + res.status + ')'));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  const pad = (n) => String(n).padStart(2, '0');

  return {
    setRole(r) { role = r; },
    role() { return role; },
    token, setToken,
    onUnauthorized(fn) { onUnauthorized = fn; },
    get: (path, opts) => request('GET', path, undefined, opts),
    post: (path, body, opts) => request('POST', path, body || {}, opts),
    put: (path, body, opts) => request('PUT', path, body || {}, opts),
    del: (path, opts) => request('DELETE', path, undefined, opts),
    /* The check-in computer's own calendar date and clock time. */
    localDate() { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); },
    localTime() { const d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); },
    timeText(hhmm) {
      if (!hhmm) return '';
      const h = parseInt(hhmm.slice(0, 2), 10);
      return (h % 12 || 12) + ':' + hhmm.slice(3, 5) + ' ' + (h < 12 ? 'AM' : 'PM');
    },
    dateText(iso) {
      if (!iso) return '';
      const d = new Date(iso.slice(0, 10) + 'T12:00:00');
      return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    },
  };
})();

/* Tiny DOM helpers used by both pages. */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/* Logo: public/img/logo.png (swap the file to change it). */
function logoHtml(orgName, cls) {
  return '<img class="brand-img ' + (cls || '') + '" src="/img/logo.png" alt="' + esc(orgName) + '">';
}
function brandHtml(orgName, sub) {
  return '<div class="brand">' + logoHtml(orgName) + '<span class="brand-sub">' + esc(sub || 'Kids Check-In') + '</span></div>';
}
function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
const Toast = (() => {
  let holder = null;
  return {
    show(message, kind = 'info', ms = 3500) {
      if (!holder) { holder = el('<div class="toasts"></div>'); document.body.appendChild(holder); }
      const t = el('<div class="toast toast-' + kind + '">' + esc(message) + '</div>');
      holder.appendChild(t);
      setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
    },
  };
})();
