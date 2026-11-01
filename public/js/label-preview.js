/* On-screen (and print-dialog) rendering of a label, mirroring the ZPL layout:
   child = name block with rules on the left, black code bar on the right;
   parent = date/time, code in a black box, footer. */
const LabelPreview = (() => {
  function css(readW, readH) {
    /* sizes are in "em" of a root whose font-size is the label's reading height */
    return '.lbl{box-sizing:border-box;width:' + readW + 'in;height:' + readH + 'in;padding:7% 5%;font-family:"Helvetica Neue",Arial,Helvetica,sans-serif;color:#000;background:#fff;display:flex;overflow:hidden;line-height:1.15;font-weight:700;-webkit-print-color-adjust:exact;print-color-adjust:exact}'
      + '.lbl-child{flex-direction:row;gap:4%}'
      + '.lbl-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column}'
      + '.lbl-main>*{flex-shrink:0}'
      + '.lbl-last{font-size:0.19em;line-height:1.1;white-space:nowrap;overflow:hidden}'
      + '.lbl-first{font-size:0.14em;line-height:1.15;white-space:nowrap;overflow:hidden}'
      + '.lbl-rule{height:0.012em;background:#000;margin:0.015em 0}'
      + '.lbl-room{font-size:0.09em;line-height:1.25;white-space:nowrap;overflow:hidden}'
      + '.lbl-stamp{font-size:0.065em;line-height:1.2;font-weight:600;white-space:nowrap}'
      + '.lbl-allergy{font-size:0.075em;min-height:0.09em;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
      + '.lbl-foot{display:flex;justify-content:space-between;gap:0.3em;font-size:0.065em;margin-top:auto;font-weight:600;white-space:nowrap}'
      + '.lbl-foot span{overflow:hidden;text-overflow:ellipsis}'
      + '.lbl-bar{flex:0 0 16.5%;background:#000;color:#fff;border-radius:0.035em;display:flex;flex-direction:column;align-items:center;padding:0.03em 0;font-size:0.135em;font-weight:800;line-height:1.25}'
      + '.lbl-bar .chk{margin-top:auto;font-size:0.85em}'
      + '.lbl-parent{flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:0.04em}'
      + '.lbl-org{font-size:0.055em;font-weight:600}'
      + '.lbl-pstamp{font-size:0.12em;white-space:nowrap}'
      + '.lbl-pbox{background:#000;color:#fff;border-radius:0.03em;width:88%;padding:0.06em 0;font-size:0.24em;line-height:1;letter-spacing:0.04em;font-weight:800}'
      + '.lbl-pfoot{font-size:0.06em;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}';
  }

  function fitSize(text, maxEm, widthEm, ratio) {
    const n = Math.max((text || '').length, 1);
    return Math.max(Math.min(maxEm, widthEm / (ratio * n)), 0.05);
  }

  function stamp(f) {
    return f.stamp_text || [f.date_text, f.time_text].filter(Boolean).join(' ');
  }

  function html(label, cfg) {
    const f = label.fields || {};
    const readW = cfg.rotate ? cfg.height_in : cfg.width_in;
    const readH = cfg.rotate ? cfg.width_in : cfg.height_in;
    const style = 'font-size:' + readH + 'in;';
    const widthEm = (readW / readH) * 0.9; /* inner width in root ems */
    const showOrg = cfg.show_org !== false && f.org;

    if (label.kind === 'parent') {
      const kids = (f.children || []).join(', ');
      return '<div class="lbl lbl-parent" style="' + style + '">'
        + (showOrg ? '<div class="lbl-org">' + esc(f.org) + '</div>' : '')
        + '<div class="lbl-pstamp" style="font-size:' + fitSize(stamp(f), 0.12, widthEm, 0.56) + 'em">' + esc(stamp(f)) + '</div>'
        + '<div class="lbl-pbox">' + esc(f.code) + '</div>'
        + '<div class="lbl-pfoot">Retain for child pickup' + (kids ? ' · ' + esc(kids) : '') + '</div>'
        + '</div>';
    }

    const showCode = cfg.show_code !== false && f.code;
    const allergies = cfg.show_allergies !== false ? (f.allergies || '') : '';
    const notes = cfg.show_notes ? (f.notes || '') : '';
    let line = allergies ? 'Allergy: ' + allergies : '';
    if (notes) line = (line ? line + ' · ' : '') + notes;
    const colEm = widthEm * (showCode ? 0.78 : 1);
    return '<div class="lbl lbl-child" style="' + style + '">'
      + '<div class="lbl-main">'
      + '<div class="lbl-last" style="font-size:' + fitSize(f.first_name, 0.19, colEm, 0.6) + 'em">' + esc(f.first_name) + '</div>'
      + '<div class="lbl-first" style="font-size:' + fitSize(f.last_name, 0.14, colEm, 0.6) + 'em">' + esc(f.last_name) + '</div>'
      + '<div class="lbl-rule"></div>'
      + '<div class="lbl-room">' + esc(f.classroom || '') + '</div>'
      + '<div class="lbl-stamp">' + esc(stamp(f)) + '</div>'
      + '<div class="lbl-rule"></div>'
      + '<div class="lbl-allergy">' + esc(line) + '</div>'
      + '<div class="lbl-rule"></div>'
      + '<div class="lbl-foot"><span>' + esc(f.parent_name || '') + '</span></div>'
      + '</div>'
      + (showCode ? '<div class="lbl-bar">' + String(f.code).split('').map((ch) => '<span>' + esc(ch) + '</span>').join('') + '<span class="chk">✓</span></div>' : '')
      + '</div>';
  }

  /* Render into a container, scaled to fit its width. */
  function render(container, label, cfg) {
    const readW = cfg.rotate ? cfg.height_in : cfg.width_in;
    const readH = cfg.rotate ? cfg.width_in : cfg.height_in;
    container.innerHTML = '<style>' + css(readW, readH) + '</style><div class="lbl-scale">' + html(label, cfg) + '</div>';
    const scaleBox = container.querySelector('.lbl-scale');
    const fit = () => {
      const avail = container.clientWidth || 300;
      const natural = readW * 96;
      const s = Math.min(1.6, avail / natural);
      scaleBox.style.transform = 'scale(' + s + ')';
      scaleBox.style.transformOrigin = 'top left';
      container.style.height = (readH * 96 * s) + 'px';
    };
    fit();
    if (window.ResizeObserver) new ResizeObserver(fit).observe(container);
  }

  return { css, html, render };
})();
