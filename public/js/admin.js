/* Staff admin: today's roster, families, CSV import, settings, export. */
(() => {
  Api.setRole('admin');
  const app = $('#app');
  const state = { settings: null, tab: 'today', rosterDate: Api.localDate(), refreshTimer: null, importPreview: null };
  const TABS = [['today', 'Today'], ['stats', 'Stats'], ['families', 'Families'], ['import', 'Import CSV'], ['settings', 'Settings'], ['export', 'Export']];
  const LABEL_PRESETS = [
    ['2.25x1.25', '2.25 × 1.25 in (small)', 2.25, 1.25, false],
    ['3x2', '3 × 2 in', 3, 2, false],
    ['4x2', '4 × 2 in', 4, 2, false],
    ['4x3', '4 × 3 in', 4, 3, false],
    ['2.25x4r', '2.25 × 4 in badge (reads along the long side)', 2.25, 4, true],
    ['custom', 'Custom', null, null, null],
  ];

  function roomStyle(id) {
    const idx = Math.max(0, (state.settings.classrooms || []).findIndex((r) => r.id === id));
    return 'background:var(--room-' + (idx % 6) + ')';
  }
  function fromForm(form) { const o = {}; new FormData(form).forEach((v, k) => { o[k] = String(v).trim(); }); return o; }
  function confirmDialog(message) { return Promise.resolve(window.confirm(message)); }
  function modal(html) {
    const back = el('<div class="modal-backdrop"><div class="modal">' + html + '</div></div>');
    document.body.appendChild(back);
    back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
    return back;
  }
  function download(path, filename) {
    return fetch(path, { headers: { Authorization: 'Bearer ' + Api.token() } }).then(async (r) => {
      if (!r.ok) throw new Error((await r.json()).error || 'Download failed');
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });
  }

  /* ---- boot / auth ----------------------------------------------------- */
  async function init() {
    Api.onUnauthorized(() => showLogin());
    let status;
    try { status = await Api.get('/api/status'); } catch (e) { app.innerHTML = '<div class="admin-shell"><div class="card error">' + esc(e.message) + '</div></div>'; return; }
    if (status.setup_required) return showSetup(status);
    if (!Api.token()) return showLogin(status);
    try { state.settings = await Api.get('/api/settings'); } catch (e) { return; }
    if (state.settings.role !== 'admin') { Api.setToken(''); return showLogin(status); }
    shell();
  }

  function showSetup(status) {
    app.innerHTML = '<div class="pin-card card pad-lg" style="max-width:520px;text-align:left"><h1>Set up Kids Check-In</h1>'
      + '<p class="muted">Choose an <strong>admin PIN</strong> for this staff page. The parent check-in page opens without a PIN.</p>'
      + '<form id="setup" class="stack"><div class="field"><label>Church / ministry name (printed on labels)</label><input class="input" name="org_name" value="' + esc(status.org_name || '') + '" required></div>'
      + '<div class="field"><label>Admin PIN (4+ digits)</label><input class="input" name="admin_pin" type="password" inputmode="numeric" minlength="4" required></div>'
      + '<div class="error" id="err"></div><button class="btn btn-primary btn-lg btn-block" type="submit">Finish setup</button></form></div>';
    $('#setup').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await Api.post('/api/setup', fromForm(e.target));
        Api.setToken(r.token);
        state.settings = await Api.get('/api/settings');
        shell();
      } catch (ex) { $('#err').textContent = ex.message; }
    });
  }

  function showLogin(status) {
    app.innerHTML = '<div class="pin-card card pad-lg">' + logoHtml((status && status.org_name) || 'Kids Check-In', 'brand-img-lg') + '<h1>Admin</h1><p class="muted">Kids Check-In</p>'
      + '<form id="login"><input id="pin" class="input input-lg pin-input" type="password" inputmode="numeric" autocomplete="off" placeholder="Admin PIN" autofocus>'
      + '<div class="error mt" id="err"></div><button class="btn btn-primary btn-lg btn-block mt" type="submit">Sign in</button></form>'
      + '<p class="small muted mt"><a href="/">← Back to the kiosk</a></p></div>';
    $('#pin').focus();
    $('#login').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await Api.post('/api/auth', { role: 'admin', pin: $('#pin').value }, { silent: true });
        Api.setToken(r.token);
        state.settings = await Api.get('/api/settings');
        shell();
      } catch (ex) { $('#err').textContent = ex.message; $('#pin').value = ''; }
    });
  }

  /* ---- shell + tabs ---------------------------------------------------- */
  function shell() {
    app.innerHTML = '<div class="admin-shell">'
      + '<div class="topbar">' + brandHtml(state.settings.org_name, 'Kids Check-In · Admin')
      + '<div class="row"><a class="btn btn-secondary btn-sm" href="/" target="_blank">Open kiosk ↗</a><button class="btn btn-ghost btn-sm" id="logout">Sign out</button></div></div>'
      + '<div class="tabs"><select class="select" id="tabSelect" style="max-width:260px;font-weight:600">' + TABS.map(([id, name]) => '<option value="' + id + '">' + name + '</option>').join('') + '</select></div>'
      + '<div id="view"></div></div>';
    $('#logout').addEventListener('click', () => { Api.setToken(''); location.reload(); });
    $('#tabSelect').addEventListener('change', (e) => go(e.target.value));
    window.addEventListener('hashchange', () => go(location.hash.slice(1) || 'today', true));
    go(location.hash.slice(1) || 'today', true);
  }

  function go(tab, fromHash) {
    if (!TABS.some(([id]) => id === tab)) tab = 'today';
    state.tab = tab;
    if (!fromHash) location.hash = tab;
    const sel = $('#tabSelect');
    if (sel && sel.value !== tab) sel.value = tab;
    $$('.modal-backdrop').forEach((m) => m.remove());
    clearInterval(state.refreshTimer);
    const view = $('#view');
    view.innerHTML = '<div class="center"><span class="spinner"></span></div>';
    ({ today: renderToday, stats: renderStats, families: renderFamilies, import: renderImport, settings: renderSettings, export: renderExport })[tab](view).catch((e) => {
      view.innerHTML = '<div class="card error">' + esc(e.message) + '</div>';
    });
  }

  /* ---- today ----------------------------------------------------------- */
  async function renderToday(view) {
    view.innerHTML = '<div class="toolbar">'
      + '<input class="input" id="pickup" placeholder="Type the parent\'s code" style="max-width:340px" autocomplete="off">'
      + '<button class="btn btn-secondary btn-sm" id="refresh">Refresh</button><span class="muted small" id="updated"></span></div>'
      + '<div id="pickupResult"></div><div class="stats" id="stats"></div><div class="rooms" id="rooms"></div>';
    $('#refresh').addEventListener('click', loadRoster);
    $('#pickup').addEventListener('input', renderPickup);
    await loadRoster();
    state.refreshTimer = setInterval(() => { if (state.tab === 'today') loadRoster(); }, 30000);
  }

  let roster = null;
  async function loadRoster() {
    state.rosterDate = Api.localDate();  // always today (rolls over at midnight)
    roster = await Api.get('/api/roster?date=' + state.rosterDate);
    if (state.tab !== 'today') return;
    const allRows = roster.classrooms.flatMap((r) => r.checkins).concat(roster.unassigned);
    const families = new Set(allRows.map((c) => c.family_id)).size;
    const allergies = allRows.filter((c) => c.allergies).length;
    $('#stats').innerHTML = '<div class="stat"><div class="n">' + roster.present + '</div><div class="l">Kids here now</div></div>'
      + '<div class="stat"><div class="n">' + (roster.total - roster.present) + '</div><div class="l">Checked out</div></div>'
      + '<div class="stat"><div class="n">' + families + '</div><div class="l">Families</div></div>'
      + '<div class="stat"><div class="n">' + allergies + '</div><div class="l">With allergies</div></div>';
    const rooms = roster.classrooms.map((r) => roomBlock(r.name, r.id, r.checkins));
    if (roster.unassigned.length) rooms.push(roomBlock('No classroom', null, roster.unassigned));
    $('#rooms').innerHTML = rooms.join('');
    $('#updated').textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    $('#rooms').onclick = onRosterAction;
    renderPickup();
  }

  function roomBlock(name, id, list) {
    const here = list.filter((c) => !c.checked_out_local).length;
    const count = here === list.length ? list.length + (list.length === 1 ? ' kid' : ' kids') : here + ' here · ' + list.length + ' today';
    return '<div class="room"><div class="room-head" style="' + (id ? roomStyle(id) : 'background:#e5e7eb') + '"><span>' + esc(name) + '</span><span>' + count + '</span></div>'
      + '<div class="room-list">' + (list.length ? list.map(checkinRow).join('') : '<div class="muted small" style="padding:8px">Nobody yet</div>') + '</div></div>';
  }

  function checkinRow(c) {
    const out = !!c.checked_out_local;
    return '<div class="ci' + (out ? ' out' : '') + '" data-id="' + c.id + '"><div class="who"><div class="n">' + esc(c.first_name) + ' ' + esc(c.last_name) + ' <span class="kbd">' + esc(c.code) + '</span>'
      + (c.allergies ? ' <span class="chip chip-danger">⚠ ' + esc(c.allergies) + '</span>' : '') + (out ? ' <span class="chip chip-ok">Out ' + esc(c.checked_out_time) + '</span>' : '') + '</div>'
      + '<div class="m">' + esc([c.age !== null && c.age !== undefined ? 'Age ' + c.age : '', 'In ' + c.checked_in_time, c.family_name, c.family_phone_display].filter(Boolean).join(' · '))
      + (c.notes ? '<div class="chip chip-note" style="margin-top:4px">' + esc(c.notes) + '</div>' : '') + '</div></div>'
      + '<div class="row" style="gap:6px">'
      + (out ? '<button class="btn btn-sm btn-ghost" data-act="undo">Undo</button>' : '<button class="btn btn-sm btn-success" data-act="checkout">Check out</button>')
      + '<button class="btn btn-sm btn-secondary" data-act="reprint" title="Reprint label">Reprint</button></div></div>';
  }

  async function onRosterAction(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const row = btn.closest('.ci');
    const id = row.dataset.id;
    try {
      if (btn.dataset.act === 'checkout') await Api.post('/api/checkins/' + id + '/checkout', { local_time: Api.localTime() });
      if (btn.dataset.act === 'undo') await Api.post('/api/checkins/' + id + '/undo-checkout');
      if (btn.dataset.act === 'reprint') {
        const r = await Api.post('/api/labels/reprint', { checkin_ids: [id], parent: false });
        await Printer.printLabels(r.labels, state.settings.print_method, state.settings.label);
        Toast.show('Label sent to the printer.', 'ok');
        return;
      }
      await loadRoster();
    } catch (ex) { Toast.show(ex.message, 'error', 6000); }
  }

  function renderPickup() {
    const box = $('#pickupResult');
    const code = ($('#pickup').value || '').trim().toUpperCase();
    if (!box) return;
    if (code.length < 2 || !roster) { box.innerHTML = ''; return; }
    const all = roster.classrooms.flatMap((r) => r.checkins.map((c) => Object.assign({ room: r.name }, c))).concat(roster.unassigned.map((c) => Object.assign({ room: 'No classroom' }, c)));
    const matches = all.filter((c) => c.code.startsWith(code));
    if (!matches.length) { box.innerHTML = '<div class="notice bad mb">No check-in today with code ' + esc(code) + '. Do not release a child without a matching code.</div>'; return; }
    const here = matches.filter((c) => !c.checked_out_local);
    box.innerHTML = '<div class="card mb"><div class="card-title"><h3>Code ' + esc(code) + ' → ' + matches.length + (matches.length === 1 ? ' child' : ' children') + '</h3>'
      + (here.length ? '<button class="btn btn-success" id="checkoutAll">Check out ' + (here.length === 1 ? here[0].first_name : 'all ' + here.length) + '</button>' : '<span class="chip chip-ok">All checked out</span>') + '</div>'
      + matches.map((c) => '<div class="ci' + (c.checked_out_local ? ' out' : '') + '" data-id="' + c.id + '"><div class="who"><div class="n">' + esc(c.first_name) + ' ' + esc(c.last_name) + ' <span class="kbd">' + esc(c.code) + '</span> <span class="chip chip-room" style="' + roomStyle(c.classroom) + '">' + esc(c.room) + '</span>'
        + (c.allergies ? ' <span class="chip chip-danger">⚠ ' + esc(c.allergies) + '</span>' : '') + (c.checked_out_local ? ' <span class="chip chip-ok">Out ' + esc(c.checked_out_time) + '</span>' : '') + '</div><div class="m">' + esc(c.family_name + ' · ' + c.family_phone_display + ' · in ' + c.checked_in_time) + '</div></div>'
        + '<div class="row" style="gap:6px">' + (c.checked_out_local ? '<button class="btn btn-sm btn-ghost" data-act="undo">Undo check-out</button>' : '<button class="btn btn-sm btn-success" data-act="checkout">Check out</button>') + '</div></div>').join('')
      + '</div>';
    const b = $('#checkoutAll');
    if (b) b.addEventListener('click', async () => {
      try {
        for (const c of here) await Api.post('/api/checkins/' + c.id + '/checkout', { local_time: Api.localTime() });
        Toast.show('Checked out ' + here.map((c) => c.first_name).join(', '), 'ok');
        await loadRoster();
      } catch (ex) { Toast.show(ex.message, 'error'); }
    });
    box.onclick = onRosterAction;  // per-child Check out / Undo buttons in this panel
  }

  /* ---- families -------------------------------------------------------- */
  async function renderFamilies(view) {
    view.innerHTML = '<div class="toolbar"><input class="input" id="fq" placeholder="Search by family, parent, child or phone" autocomplete="off">'
      + '<button class="btn btn-primary" id="addFamily">+ Add family</button><span class="muted small" id="fcount"></span></div><div id="flist"></div>';
    let timer = null;
    $('#fq').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(loadFamilies, 250); });
    $('#addFamily').addEventListener('click', () => editFamily(null));
    await loadFamilies();
  }

  async function loadFamilies() {
    const q = ($('#fq') || {}).value || '';
    const r = await Api.get('/api/families?q=' + encodeURIComponent(q) + '&limit=100&date=' + Api.localDate());
    if (state.tab !== 'families') return;
    $('#fcount').textContent = r.total + (r.total === 1 ? ' family' : ' families') + (r.total > r.families.length ? ' (showing ' + r.families.length + ')' : '');
    $('#flist').innerHTML = '<table class="table"><thead><tr><th>Family</th><th>Phone</th><th>Parents</th><th>Children</th><th></th></tr></thead><tbody>'
      + r.families.map((f) => '<tr class="clickable" data-id="' + f.id + '"><td><strong>' + esc(f.name) + '</strong>' + (f.email ? '<div class="muted small">' + esc(f.email) + '</div>' : '') + '</td>'
        + '<td>' + esc(f.phone_display) + '</td><td>' + esc(f.parents.map((p) => p.first_name + ' ' + p.last_name).join(', ')) + '</td>'
        + '<td>' + f.children.map((c) => esc(c.first_name) + (c.age !== null ? ' (' + c.age + ')' : ' <span class="chip chip-warn">no birthday</span>') + (c.allergies ? ' <span class="chip chip-danger">⚠</span>' : '')).join(', ') + '</td>'
        + '<td><button class="btn btn-sm btn-secondary">Edit</button></td></tr>').join('')
      + '</tbody></table>';
    $$('#flist tr.clickable').forEach((tr) => tr.addEventListener('click', () => editFamily(r.families.find((f) => f.id === tr.dataset.id))));
  }

  function personRowHtml(p, role) {
    const rooms = state.settings.classrooms;
    return '<div class="person-row" data-id="' + (p.id || '') + '" data-role="' + role + '">'
      + '<div class="field"><label>First</label><input class="input" name="first_name" value="' + esc(p.first_name || '') + '" required></div>'
      + '<div class="field"><label>Last</label><input class="input" name="last_name" value="' + esc(p.last_name || '') + '"></div>'
      + (role === 'child'
        ? '<div class="field"><label>Birthday</label><input class="input" type="date" name="birthdate" value="' + esc(p.birthdate || '') + '"></div>'
          + '<div class="field"><label>Allergies</label><input class="input" name="allergies" value="' + esc(p.allergies || '') + '"></div>'
          + '<div class="field"><label>Notes</label><input class="input" name="notes" value="' + esc(p.notes || '') + '"></div>'
          + '<div class="field"><label>Classroom</label><select class="select" name="classroom_override"><option value="">Auto by age</option>'
          + rooms.map((r) => '<option value="' + r.id + '"' + (p.classroom_override === r.id ? ' selected' : '') + '>' + esc(r.name) + '</option>').join('') + '</select></div>'
        : '<div class="field"><label>Phone</label><input class="input" name="phone" value="' + esc(p.phone_display || p.phone || '') + '"></div>'
          + '<div class="field"><label>Email</label><input class="input" name="email" value="' + esc(p.email || '') + '"></div><div></div>'
          + '<div class="field"><label>Role</label><select class="select" name="role"><option value="adult">Parent</option><option value="child">Child</option></select></div>')
      + '<button type="button" class="btn btn-sm btn-ghost" data-remove title="Remove">✕</button></div>';
  }

  function editFamily(fam) {
    const isNew = !fam;
    fam = fam || { name: '', phone_display: '', email: '', notes: '', parents: [{}], children: [{}] };
    const back = modal('<div class="card-title"><h2>' + (isNew ? 'Add family' : esc(fam.name)) + '</h2><button class="btn btn-sm btn-ghost" data-close>Close</button></div>'
      + '<form id="ff"><div class="form-grid"><div class="field"><label>Family name</label><input class="input" name="name" value="' + esc(fam.name) + '" placeholder="Smith Family"></div>'
      + '<div class="field"><label>Family phone</label><input class="input" name="phone" value="' + esc(fam.phone_display) + '"></div>'
      + '<div class="field"><label>Email</label><input class="input" name="email" value="' + esc(fam.email) + '"></div>'
      + '<div class="field"><label>Notes (staff only)</label><input class="input" name="notes" value="' + esc(fam.notes) + '"></div></div>'
      + '<h3 class="mt">Parents / guardians</h3><div id="parents">' + fam.parents.map((p) => personRowHtml(p, 'adult')).join('') + '</div>'
      + '<button type="button" class="btn btn-ghost btn-sm" id="addP">+ Add parent</button>'
      + '<h3 class="mt">Children</h3><div id="kids">' + fam.children.map((p) => personRowHtml(p, 'child')).join('') + '</div>'
      + '<button type="button" class="btn btn-ghost btn-sm" id="addK">+ Add child</button>'
      + '<div class="error mt" id="ferr"></div>'
      + '<div class="row between mt"><button class="btn btn-primary" type="submit">Save</button>' + (isNew ? '' : '<button type="button" class="btn btn-danger btn-sm" id="deact">Remove family</button>') + '</div></form>'
      + (isNew ? '' : '<h3 class="mt">Connect another family into this one</h3><p class="muted small">For spouses or kids that were imported as separate records. Everyone from the other record (and their check-in history) moves into this family.</p>'
        + '<input class="input" id="mergeQ" placeholder="Search the other family by name or phone" autocomplete="off"><div id="mergeResults" class="stack mt"></div>'));
    if (!isNew) {
      let mt = null;
      $('#mergeQ', back).addEventListener('input', (e) => {
        clearTimeout(mt);
        mt = setTimeout(async () => {
          const q = e.target.value.trim();
          const box = $('#mergeResults', back);
          if (q.length < 2) { box.innerHTML = ''; return; }
          const r = await Api.get('/api/families?q=' + encodeURIComponent(q) + '&limit=10&date=' + Api.localDate());
          const list = r.families.filter((f) => f.id !== fam.id);
          box.innerHTML = list.length ? list.map((f) => '<div class="row between"><div><strong>' + esc(f.name) + '</strong> <span class="muted small">' + esc([f.parents.map((p) => p.first_name).join(', '), f.children.length ? 'kids: ' + f.children.map((c) => c.first_name).join(', ') : '', f.phone_display].filter(Boolean).join(' · ')) + '</span></div>'
            + '<button type="button" class="btn btn-sm btn-primary" data-merge="' + f.id + '">Merge into ' + esc(fam.name) + '</button></div>').join('') : '<div class="muted small">No other family matches.</div>';
          $$('[data-merge]', box).forEach((b) => b.addEventListener('click', async () => {
            if (!(await confirmDialog('Move everyone from that family into ' + fam.name + '? This cannot be undone.'))) return;
            try { await Api.post('/api/families/' + fam.id + '/merge', { other_family_id: b.dataset.merge }); back.remove(); Toast.show('Families merged.', 'ok'); loadFamilies(); }
            catch (ex) { Toast.show(ex.message, 'error', 6000); }
          }));
        }, 250);
      });
    }
    const removed = [];
    back.addEventListener('click', (e) => {
      if (e.target.matches('[data-close]')) back.remove();
      const rm = e.target.closest('[data-remove]');
      if (rm) { const row = rm.closest('.person-row'); if (row.dataset.id) removed.push(row.dataset.id); row.remove(); }
    });
    $('#addP', back).addEventListener('click', () => $('#parents', back).insertAdjacentHTML('beforeend', personRowHtml({}, 'adult')));
    $('#addK', back).addEventListener('click', () => $('#kids', back).insertAdjacentHTML('beforeend', personRowHtml({ last_name: ($('#parents input[name=last_name]', back) || {}).value || '' }, 'child')));
    const deact = $('#deact', back);
    if (deact) deact.addEventListener('click', async () => {
      if (!(await confirmDialog('Remove ' + fam.name + ' from check-in? (Their history is kept.)'))) return;
      await Api.del('/api/families/' + fam.id);
      back.remove(); loadFamilies();
    });
    $('#ff', back).addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#ferr', back);
      err.textContent = '';
      const rows = $$('.person-row', back).map((r) => { const o = { id: r.dataset.id, role: r.dataset.role }; $$('input,select', r).forEach((i) => { o[i.name] = i.value.trim(); }); return o; });
      const famFields = fromForm(e.target);
      try {
        if (isNew) {
          await Api.post('/api/families', { name: famFields.name, phone: famFields.phone, email: famFields.email, notes: famFields.notes,
            parents: rows.filter((r) => r.role === 'adult'), children: rows.filter((r) => r.role === 'child'), date: Api.localDate() });
        } else {
          await Api.put('/api/families/' + fam.id, { name: famFields.name, phone: famFields.phone, email: famFields.email, notes: famFields.notes });
          for (const id of removed) await Api.del('/api/people/' + id);
          for (const r of rows) {
            if (r.id) await Api.put('/api/people/' + r.id, r);
            else await Api.post('/api/people', Object.assign({ family_id: fam.id }, r));
          }
        }
        back.remove();
        Toast.show('Saved.', 'ok');
        loadFamilies();
      } catch (ex) { err.textContent = ex.message; }
    });
  }

  /* ---- import ---------------------------------------------------------- */
  async function renderImport(view) {
    view.innerHTML = '<div class="card"><h2>Import families from a CSV export</h2>'
      + '<p class="muted">Export people from your church software as CSV (first name, last name, email, phone, address…). People who share a phone number or address are grouped into one household, and kids are guessed from the contact info. You can fix roles below before importing. Re-importing the same file later only adds new people.</p>'
      + '<div class="drop" id="drop">Drop the CSV here or <label class="btn btn-secondary btn-sm" style="display:inline-flex">choose a file<input type="file" id="file" accept=".csv,text/csv" hidden></label></div>'
      + '<div id="importStatus" class="mt"></div></div><div id="preview" class="mt"></div>';
    const drop = $('#drop');
    const handle = (file) => { if (file) file.text().then(previewCsv).catch((e) => Toast.show(e.message, 'error')); };
    $('#file').addEventListener('change', (e) => handle(e.target.files[0]));
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => handle(e.dataTransfer.files[0]));
  }

  async function previewCsv(text) {
    $('#importStatus').innerHTML = '<span class="spinner"></span> Reading…';
    try {
      const p = await Api.post('/api/import/preview', { csv: text, local_date: Api.localDate() });
      state.importPreview = p;
      $('#importStatus').innerHTML = '';
      renderPreview(p);
    } catch (e) { $('#importStatus').innerHTML = '<div class="notice bad">' + esc(e.message) + '</div>'; }
  }

  function renderPreview(p) {
    const s = p.stats;
    const box = $('#preview');
    const cols = Object.entries(p.mapping).map(([k, v]) => '<span class="chip">' + esc(k.replace('_', ' ')) + ' ← ' + esc(v) + '</span>').join(' ');
    box.innerHTML = '<div class="stats"><div class="stat"><div class="n">' + s.households + '</div><div class="l">households</div></div>'
      + '<div class="stat"><div class="n">' + s.adults + '</div><div class="l">parents / adults</div></div><div class="stat"><div class="n">' + s.children + '</div><div class="l">children (guessed)</div></div>'
      + '<div class="stat"><div class="n">' + s.review + '</div><div class="l">need a quick look</div></div><div class="stat"><div class="n">' + s.existing + '</div><div class="l">already imported</div></div></div>'
      + '<div class="card mb"><div class="card-title"><div><strong>Columns found:</strong> ' + cols + '</div><button class="btn btn-primary" id="commit">Import</button></div>'
      + '<p class="muted small">Households marked <span class="chip chip-warn">check</span> had uncertain roles — set each person to Parent or Child (or Skip). Birthdays are not in this export; parents add them at the kiosk on their first visit.</p></div>'
      + '<div id="households">' + p.households.map((h, i) => householdHtml(h, i)).join('') + '</div>';
    $('#commit').addEventListener('click', commitImport);
    $('#households').addEventListener('change', (e) => {
      const hh = e.target.closest('.household');
      const idx = Number(hh.dataset.i);
      const h = state.importPreview.households[idx];
      if (e.target.name === 'skip') { h.skip = e.target.checked; hh.classList.toggle('skip', h.skip); }
      if (e.target.name === 'name') h.name = e.target.value;
      if (e.target.name === 'role') h.members[Number(e.target.dataset.m)].role = e.target.value;
    });
  }

  function householdHtml(h, i) {
    return '<div class="household' + (h.review ? ' review' : '') + (h.skip ? ' skip' : '') + '" data-i="' + i + '">'
      + '<div class="row between"><div class="row"><input class="input" name="name" value="' + esc(h.name) + '" style="max-width:260px;min-height:36px;padding:4px 10px">'
      + (h.review ? '<span class="chip chip-warn">check</span>' : '') + '<span class="muted small">' + esc([h.phone, h.email].filter(Boolean).join(' · ')) + '</span></div>'
      + '<label class="check small"><input type="checkbox" name="skip"' + (h.skip ? ' checked' : '') + '> Skip</label></div>'
      + (h.reason ? '<div class="muted small">' + esc(h.reason) + '</div>' : '')
      + '<div class="members">' + h.members.map((m, j) => '<div class="member"><select class="select" name="role" data-m="' + j + '"' + (m.existing ? ' disabled' : '') + '>'
        + '<option value="adult"' + (m.role === 'adult' ? ' selected' : '') + '>Parent</option><option value="child"' + (m.role === 'child' ? ' selected' : '') + '>Child</option><option value="skip">Skip</option></select>'
        + '<div>' + esc(m.first_name + ' ' + m.last_name) + (m.existing ? ' <span class="chip chip-ok">already imported</span>' : '') + (m.birthdate ? ' <span class="chip">' + esc(m.birthdate) + '</span>' : '')
        + '<div class="hint">' + esc([m.hint, m.phone, m.email].filter(Boolean).join(' · ')) + '</div></div><div></div></div>').join('') + '</div></div>';
  }

  async function commitImport() {
    const btn = $('#commit');
    btn.disabled = true; btn.textContent = 'Importing…';
    try {
      const r = await Api.post('/api/import/commit', { households: state.importPreview.households });
      $('#preview').innerHTML = '<div class="notice ok">Imported ' + r.families_created + ' households and ' + r.people_created + ' people' + (r.families_updated ? ', added people to ' + r.families_updated + ' existing households' : '') + (r.skipped ? ' (' + r.skipped + ' skipped)' : '') + '.</div>';
      state.importPreview = null;
    } catch (e) { Toast.show(e.message, 'error', 8000); btn.disabled = false; btn.textContent = 'Import'; }
  }

  /* ---- settings -------------------------------------------------------- */
  async function renderSettings(view) {
    const s = state.settings;
    const l = s.label;
    const preset = LABEL_PRESETS.find((p) => p[2] === l.width_in && p[3] === l.height_in && p[4] === !!l.rotate);
    view.innerHTML = '<div class="settings-grid">'
      + '<form class="card stack" id="general"><h2>General</h2>'
      + '<div class="field"><label>Church / ministry name (on labels and the kiosk)</label><input class="input" name="org_name" value="' + esc(s.org_name) + '" required></div>'
      + '<div class="field"><label>Kiosk returns to the start after (seconds)</label><input class="input" type="number" name="kiosk_auto_return_seconds" min="5" max="120" value="' + esc(s.kiosk_auto_return_seconds) + '"></div>'
      + '<label class="check"><input type="checkbox" name="preselect_children"' + (s.preselect_children !== false ? ' checked' : '') + '> Pre-select all children when a family is found</label>'
      + '<h3 class="mt">Classrooms by age</h3><p class="muted small">A child goes to the first classroom whose maximum age is at or above their age. Older children show “No classroom”. You can override a child\'s classroom on the Families tab.</p>'
      + '<div id="rooms">' + s.classrooms.map(roomRowHtml).join('') + '</div><button type="button" class="btn btn-ghost btn-sm" id="addRoom">+ Add classroom</button>'
      + '<div class="row mt"><button class="btn btn-primary" type="submit">Save general settings</button></div></form>'

      + '<form class="card stack" id="labelForm"><h2>Labels</h2>'
      + '<div class="field"><label>Label size</label><select class="select" name="preset">' + LABEL_PRESETS.map((p) => '<option value="' + p[0] + '"' + ((preset ? preset[0] : 'custom') === p[0] ? ' selected' : '') + '>' + esc(p[1]) + '</option>').join('') + '</select></div>'
      + '<div class="form-grid"><div class="field"><label>Width (in)</label><input class="input" type="number" step="0.01" name="width_in" value="' + l.width_in + '"></div>'
      + '<div class="field"><label>Height (in)</label><input class="input" type="number" step="0.01" name="height_in" value="' + l.height_in + '"></div>'
      + '<div class="field"><label>Printer DPI</label><select class="select" name="dpi">' + [203, 300, 600].map((d) => '<option' + (l.dpi === d ? ' selected' : '') + '>' + d + '</option>').join('') + '</select></div></div>'
      + '<label class="check"><input type="checkbox" name="rotate"' + (l.rotate ? ' checked' : '') + '> Rotate: text reads along the long side (badge stock)</label>'
      + '<label class="check"><input type="checkbox" name="show_org"' + (l.show_org ? ' checked' : '') + '> Print the church name and time</label>'
      + '<label class="check"><input type="checkbox" name="show_allergies"' + (l.show_allergies ? ' checked' : '') + '> Print allergies</label>'
      + '<label class="check"><input type="checkbox" name="show_notes"' + (l.show_notes ? ' checked' : '') + '> Print notes</label>'
      + '<label class="check"><input type="checkbox" name="show_code"' + (l.show_code ? ' checked' : '') + '> Print the pickup code on the child\'s label</label>'
      + '<label class="check"><input type="checkbox" name="parent_receipt"' + (l.parent_receipt ? ' checked' : '') + '> Also print a parent pickup tag</label>'
      + '<div class="row"><button class="btn btn-primary" type="submit">Save label settings</button><button class="btn btn-secondary" type="button" id="labelary">Exact preview (Labelary)</button></div>'
      + '<div class="label-grid mt"><div><div class="label small muted">Child label</div><div class="label-box" id="pvChild"></div></div><div><div class="label small muted">Parent tag</div><div class="label-box" id="pvParent"></div></div></div>'
      + '<div id="labelaryBox"></div></form>'

      + '<div class="card stack" id="printerCard"><h2>Printing</h2>'
      + '<label class="check"><input type="radio" name="print_method" value="browserprint"' + (s.print_method !== 'dialog' ? ' checked' : '') + '> <span><strong>Zebra Browser Print</strong> (recommended) — silent printing. Install Zebra\'s free helper app on the check-in computer.</span></label>'
      + '<label class="check"><input type="radio" name="print_method" value="dialog"' + (s.print_method === 'dialog' ? ' checked' : '') + '> <span><strong>Browser print dialog</strong> — uses the Zebra printer driver like a normal printer.</span></label>'
      + '<h3 class="mt">This device\'s printer</h3><div id="printerStatus" class="muted small">Checking…</div><div id="printerList" class="stack"></div>'
      + '<div class="row"><button class="btn btn-secondary btn-sm" id="detect">Detect printers</button><button class="btn btn-primary btn-sm" id="testPrint">Test print</button></div>'
      + '<p class="muted small">The printer choice is remembered per computer. On a new kiosk computer, open this page once and pick the printer.</p></div>'

      + '<form class="card stack" id="pins"><h2>PINs</h2><p class="muted small">The admin PIN opens this page.</p>'
      + '<label class="check"><input type="checkbox" id="kioskPinRequired"' + (s.kiosk_pin_required ? ' checked' : '') + '> Require a PIN to unlock check-in devices (off: the check-in page opens directly)</label>'
      + '<div class="field"><label>Change</label><select class="select" name="role"><option value="admin">Admin PIN</option><option value="kiosk">Kiosk PIN</option></select></div>'
      + '<div class="field"><label>New PIN (4+ digits)</label><input class="input" name="new_pin" type="password" inputmode="numeric" minlength="4" required></div>'
      + '<div class="row"><button class="btn btn-primary" type="submit">Update PIN</button></div></form>'
      + '</div>';
    $('#kioskPinRequired').addEventListener('change', async (e) => {
      try { state.settings = await Api.put('/api/settings', { kiosk_pin_required: e.target.checked }); Toast.show(e.target.checked ? 'Kiosks now ask for a PIN (the admin PIN works too).' : 'Kiosk PIN switched off.', 'ok'); }
      catch (ex) { Toast.show(ex.message, 'error'); }
    });

    // general
    $('#addRoom').addEventListener('click', () => $('#rooms').insertAdjacentHTML('beforeend', roomRowHtml({ name: '', max_age: '' })));
    $('#rooms').addEventListener('click', (e) => { if (e.target.matches('[data-remove]')) e.target.closest('.room-row').remove(); });
    $('#general').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = fromForm(e.target);
      const rooms = $$('.room-row').map((r) => ({ id: r.dataset.id || undefined, name: $('[name=name]', r).value.trim(), max_age: $('[name=max_age]', r).value }));
      try {
        state.settings = await Api.put('/api/settings', { org_name: f.org_name, kiosk_auto_return_seconds: f.kiosk_auto_return_seconds, preselect_children: !!f.preselect_children, classrooms: rooms });
        Toast.show('Saved.', 'ok'); go('settings');
      } catch (ex) { Toast.show(ex.message, 'error', 6000); }
    });

    // labels
    const lf = $('#labelForm');
    const labelCfg = () => {
      const f = fromForm(lf);
      return { width_in: parseFloat(f.width_in), height_in: parseFloat(f.height_in), dpi: parseInt(f.dpi, 10), rotate: !!f.rotate, show_org: !!f.show_org,
        show_allergies: !!f.show_allergies, show_notes: !!f.show_notes, show_code: !!f.show_code, parent_receipt: !!f.parent_receipt };
    };
    const refreshPreview = () => {
      const cfg = labelCfg();
      if (!(cfg.width_in > 0 && cfg.height_in > 0)) return;
      const orgName = $('#general [name=org_name]').value;
      const child = { kind: 'child', fields: { org: orgName, first_name: 'Emma', last_name: 'Johnson', classroom: s.classrooms[1] ? s.classrooms[1].name : 'PreK-2nd', age_text: 'Age 5', allergies: 'Peanuts', notes: 'Needs inhaler', code: 'K7Q2', stamp_text: 'Sun. 11/2 @ 10:00AM', parent_name: 'Laura Johnson', parent_phone: '(208) 555-0123' } };
      const parent = { kind: 'parent', fields: { org: orgName, code: 'K7Q2', children: ['Emma', 'Noah'], stamp_text: 'Sun. 11/2 @ 10:00AM' } };
      LabelPreview.render($('#pvChild'), child, cfg);
      LabelPreview.render($('#pvParent'), parent, cfg);
      $('#labelaryBox').innerHTML = '';
    };
    lf.addEventListener('change', (e) => {
      if (e.target.name === 'preset') {
        const p = LABEL_PRESETS.find((x) => x[0] === e.target.value);
        if (p && p[2]) { lf.width_in.value = p[2]; lf.height_in.value = p[3]; lf.rotate.checked = p[4]; }
      } else if (['width_in', 'height_in', 'rotate'].includes(e.target.name)) {
        lf.preset.value = 'custom';
      }
      refreshPreview();
    });
    lf.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { state.settings = await Api.put('/api/settings', { label: labelCfg() }); Toast.show('Label settings saved.', 'ok'); }
      catch (ex) { Toast.show(ex.message, 'error', 6000); }
    });
    $('#labelary').addEventListener('click', async () => {
      const cfg = labelCfg();
      try {
        const r = await Api.post('/api/labels/preview', { label: cfg, org_name: $('#general [name=org_name]').value });
        const dpmm = { 203: 8, 300: 12, 600: 24 }[cfg.dpi] || 8;
        const url = (zpl) => 'https://api.labelary.com/v1/printers/' + dpmm + 'dpmm/labels/' + cfg.width_in + 'x' + cfg.height_in + '/0/' + encodeURIComponent(zpl);
        $('#labelaryBox').innerHTML = '<p class="muted small mt">Rendered by labelary.com from the exact ZPL the printer receives (sample data only).</p><div class="label-grid"><img class="label-shadow" style="max-width:100%" src="' + url(r.child.zpl) + '"><img class="label-shadow" style="max-width:100%" src="' + url(r.parent.zpl) + '"></div>';
      } catch (ex) { Toast.show(ex.message, 'error'); }
    });
    refreshPreview();

    // printing
    $$('#printerCard input[name=print_method]').forEach((r) => r.addEventListener('change', async () => {
      try { state.settings = await Api.put('/api/settings', { print_method: r.value }); Toast.show('Print method saved.', 'ok'); } catch (ex) { Toast.show(ex.message, 'error'); }
    }));
    const detect = async () => {
      $('#printerStatus').innerHTML = '<span class="spinner"></span>';
      const st = await Printer.status();
      if (state.tab !== 'settings') return;
      const saved = Printer.savedPrinter();
      if (!st.running) {
        $('#printerStatus').innerHTML = '<div class="notice bad">Zebra Browser Print is not running on this computer, or has not been allowed for this site yet. ' + esc(st.error || '') + '</div>';
        $('#printerList').innerHTML = saved ? '<div class="muted small">Last used printer: ' + esc(saved.name) + '</div>' : '';
        return;
      }
      if (!st.printers.length) { $('#printerStatus').innerHTML = '<div class="notice">Browser Print is running but found no Zebra printers. Check the USB cable / power and try again.</div>'; $('#printerList').innerHTML = ''; return; }
      $('#printerStatus').innerHTML = '<div class="notice ok">Browser Print is running.</div>';
      $('#printerList').innerHTML = st.printers.map((p, i) => '<label class="check"><input type="radio" name="printer" value="' + i + '"' + (saved && saved.uid === p.uid ? ' checked' : (!saved && i === 0 ? ' checked' : '')) + '> ' + esc(p.name) + ' <span class="muted small">(' + esc(p.connection || '') + ')</span></label>').join('');
      $$('#printerList input').forEach((r) => r.addEventListener('change', () => { Printer.savePrinter(st.printers[Number(r.value)]); Toast.show('Printer saved for this device.', 'ok'); }));
      if (!saved) Printer.savePrinter(st.printers[0]);
    };
    $('#detect').addEventListener('click', detect);
    $('#testPrint').addEventListener('click', async () => {
      try {
        const cfg = labelCfg();
        const r = await Api.post('/api/labels/preview', { label: cfg, org_name: $('#general [name=org_name]').value });
        const method = $('#printerCard input[name=print_method]:checked').value;
        await Printer.printLabels([{ kind: 'child', fields: r.child.fields, zpl: r.child.zpl }], method, cfg);
        Toast.show('Test label sent.', 'ok');
      } catch (ex) { Toast.show(ex.message, 'error', 8000); }
    });
    if (s.print_method !== 'dialog') detect(); else $('#printerStatus').textContent = 'Using the browser print dialog.';

    // pins
    $('#pins').addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await Api.post('/api/settings/pin', fromForm(e.target)); Toast.show('PIN updated.', 'ok'); e.target.reset(); }
      catch (ex) { Toast.show(ex.message, 'error'); }
    });
  }

  function roomRowHtml(r) {
    return '<div class="room-row" data-id="' + esc(r.id || '') + '"><input class="input" name="name" value="' + esc(r.name) + '" placeholder="Classroom name" required>'
      + '<input class="input" name="max_age" type="number" min="0" max="25" value="' + esc(r.max_age) + '" placeholder="Max age" required>'
      + '<button type="button" class="btn btn-sm btn-ghost" data-remove>✕</button></div>';
  }

  /* ---- stats ----------------------------------------------------------- */
  async function renderStats(view) {
    const weeks = state.statsWeeks || 12;
    view.innerHTML = '<div class="toolbar"><span class="label">Show the last</span>'
      + [8, 12, 26, 52].map((w) => '<button class="btn btn-sm ' + (w === weeks ? 'btn-primary' : 'btn-secondary') + '" data-weeks="' + w + '">' + w + ' weeks</button>').join('')
      + '</div><div id="statsBody"><div class="center"><span class="spinner"></span></div></div>';
    $$('[data-weeks]', view).forEach((b) => b.addEventListener('click', () => { state.statsWeeks = Number(b.dataset.weeks); go('stats'); }));
    const s = await Api.get('/api/stats?weeks=' + weeks + '&date=' + Api.localDate());
    if (state.tab !== 'stats') return;
    const body = $('#statsBody');
    if (!s.days.length) { body.innerHTML = '<div class="card muted">No check-ins in the last ' + weeks + ' weeks yet.</div>'; return; }
    const max = Math.max(...s.days.map((d) => d.kids), 1);
    const dayLabel = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const roomColor = (id) => (id === 'none' ? '#e5e7eb' : roomStyle(id).replace('background:', ''));

    body.innerHTML = '<div class="stats">'
      + '<div class="stat"><div class="n">' + s.totals.avg_kids + '</div><div class="l">Kids per week (avg)</div></div>'
      + '<div class="stat"><div class="n">' + s.totals.avg_families + '</div><div class="l">Families per week (avg)</div></div>'
      + s.rooms.map((r) => '<div class="stat"><div class="n">' + r.avg + '</div><div class="l">' + esc(r.name) + ' (avg)</div></div>').join('')
      + '</div>'
      + '<div class="card mb"><div class="card-title"><h3>Week by week</h3><div class="row small">'
      + s.rooms.map((r) => '<span class="chip chip-room" style="background:' + roomColor(r.id) + '">' + esc(r.name) + '</span>').join('') + '</div></div>'
      + '<div class="bars">' + s.days.slice().reverse().map((d) => '<div class="bar-row"><div class="bar-label">' + esc(dayLabel(d.date)) + '</div><div class="bar-track">'
        + s.rooms.map((r) => { const n = d.rooms[r.id] || 0; return n ? '<div class="bar-seg" style="width:' + (n / max * 100) + '%;background:' + roomColor(r.id) + '" title="' + esc(r.name) + ': ' + n + '">' + (n / max > 0.08 ? n : '') + '</div>' : ''; }).join('')
        + '</div><div class="bar-total">' + d.kids + '</div></div>').join('') + '</div></div>'
      + '<table class="table"><thead><tr><th>Week</th>' + s.rooms.map((r) => '<th>' + esc(r.name) + '</th>').join('') + '<th>Total kids</th><th>Families</th><th></th></tr></thead><tbody>'
      + s.days.map((d) => '<tr><td><strong>' + esc(dayLabel(d.date)) + '</strong></td>' + s.rooms.map((r) => '<td>' + (d.rooms[r.id] || 0) + '</td>').join('') + '<td><strong>' + d.kids + '</strong></td><td>' + d.families + '</td>'
        + '<td><button class="btn btn-sm btn-ghost" data-delete-day="' + d.date + '" data-n="' + d.kids + '" title="Delete every check-in on this day">Remove day</button></td></tr>').join('')
      + '<tr><td class="muted">Average</td>' + s.rooms.map((r) => '<td class="muted">' + r.avg + '</td>').join('') + '<td class="muted">' + s.totals.avg_kids + '</td><td class="muted">' + s.totals.avg_families + '</td><td></td></tr>'
      + '</tbody></table>';
    $$('[data-delete-day]', body).forEach((b) => b.addEventListener('click', async () => {
      const when = dayLabel(b.dataset.deleteDay);
      if (!(await confirmDialog('Delete all ' + b.dataset.n + ' check-ins from ' + when + '? This cannot be undone.'))) return;
      try {
        const r = await Api.del('/api/days/' + b.dataset.deleteDay);
        Toast.show('Removed ' + r.deleted + ' check-ins from ' + when + '.', 'ok');
        go('stats');
      } catch (ex) { Toast.show(ex.message, 'error', 6000); }
    }));
  }

  /* ---- export ---------------------------------------------------------- */
  async function renderExport(view) {
    const today = Api.localDate();
    view.innerHTML = '<div class="settings-grid"><div class="card stack"><h2>Families</h2><p class="muted">Every family, parent and child on file, with birthdays, allergies and notes.</p><button class="btn btn-primary" id="expFam">Download families CSV</button></div>'
      + '<div class="card stack"><h2>Check-in history</h2><div class="form-grid"><div class="field"><label>From</label><input class="input" type="date" id="from" value="' + today.slice(0, 8) + '01"></div><div class="field"><label>To</label><input class="input" type="date" id="to" value="' + today + '"></div></div>'
      + '<button class="btn btn-primary" id="expCi">Download check-ins CSV</button></div></div>';
    $('#expFam').addEventListener('click', () => download('/api/export/families', 'families.csv').catch((e) => Toast.show(e.message, 'error')));
    $('#expCi').addEventListener('click', () => {
      const from = $('#from').value, to = $('#to').value;
      download('/api/export/checkins?from=' + from + '&to=' + to, 'checkins-' + from + '-to-' + to + '.csv').catch((e) => Toast.show(e.message, 'error'));
    });
  }

  init();
})();
