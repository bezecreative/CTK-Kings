/* Parent-facing check-in kiosk. */
(() => {
  Api.setRole('kiosk');
  const app = $('#app');
  const state = { settings: null, family: null, selected: new Set(), labels: null, code: null, screen: '' };
  let searchTimer = null, idleTimer = null, countdownTimer = null, searchSeq = 0;
  const IDLE_SECONDS = 180;

  /* ---- helpers --------------------------------------------------------- */
  function render(html, screen) {
    state.screen = screen || state.screen;
    app.innerHTML = html;
    window.scrollTo(0, 0);
    resetIdle();
  }
  function resetIdle() {
    clearTimeout(idleTimer);
    if (state.screen && state.screen !== 'home' && state.screen !== 'lock') {
      idleTimer = setTimeout(showHome, IDLE_SECONDS * 1000);
    }
  }
  ['click', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, resetIdle, { passive: true }));

  function org() { return (state.settings && state.settings.org_name) || 'Kids Check-In'; }
  function brand() {
    return brandHtml(org());
  }
  function roomChip(k) {
    if (!k.classroom_name) return '<span class="chip chip-warn">No classroom for age ' + esc(k.age) + '</span>';
    const idx = Math.max(0, (state.settings.classrooms || []).findIndex((r) => r.id === k.classroom));
    return '<span class="chip chip-room" style="background:var(--room-' + (idx % 6) + ')">' + esc(k.classroom_name) + '</span>';
  }
  function initials(name) { return (name || '?').trim().charAt(0).toUpperCase(); }
  function autoRoom(age) {
    if (age === null || age === undefined) return null;
    return (state.settings.classrooms || []).find((r) => age <= Number(r.max_age)) || null;
  }
  /* "Auto by age" plus every classroom, for the child forms. */
  function roomSelect(k) {
    const auto = autoRoom(k.age);
    return '<div class="field"><label>Classroom</label><select class="select" name="classroom_override">'
      + '<option value="">Auto by age' + (auto ? ' (' + esc(auto.name) + ')' : '') + '</option>'
      + (state.settings.classrooms || []).map((r) => '<option value="' + esc(r.id) + '"' + (k.classroom_override === r.id ? ' selected' : '') + '>' + esc(r.name) + '</option>').join('')
      + '</select></div>';
  }
  function fromForm(form) {
    const out = {};
    new FormData(form).forEach((v, k) => { out[k] = String(v).trim(); });
    return out;
  }
  function needsBirthday(k) { return k.age === null && !k.classroom_override; }
  function activeCheckin(k) { return k.checkin && !k.checkin.checked_out_local ? k.checkin : null; }

  /* ---- boot ------------------------------------------------------------ */
  async function init() {
    Api.onUnauthorized(() => showLock());
    let status;
    try { status = await Api.get('/api/status'); } catch (e) { return showError(e.message); }
    if (status.setup_required) {
      return render('<div class="pin-card card pad-lg"><h1>Almost ready</h1><p>This check-in station has not been set up yet. Open the admin page to choose your PINs.</p><a class="btn btn-primary btn-lg" href="/admin">Open Admin</a></div>', 'setup');
    }
    if (status.kiosk_pin_required && !Api.token()) return showLock(status.org_name);
    try { state.settings = await Api.get('/api/settings'); } catch (e) { if (e.status !== 401) showError(e.message); else showLock(status.org_name); return; }
    showHome();
  }

  function showError(message) {
    render('<div class="pin-card card pad-lg"><h2>Something went wrong</h2><p class="error">' + esc(message) + '</p><button class="btn btn-primary" onclick="location.reload()">Try again</button></div>', 'error');
  }

  /* ---- lock screen ----------------------------------------------------- */
  /* Only shown when "require a PIN to unlock kiosks" is switched on in Settings. */
  function showLock(orgName) {
    render('<div class="pin-card card pad-lg">'
      + logoHtml(orgName || org(), 'brand-img-lg') + '<p class="muted">Kids Check-In</p>'
      + '<p>Enter the kiosk PIN to unlock this device.</p>'
      + '<form id="pinForm"><input id="pin" class="input input-lg pin-input" type="password" inputmode="numeric" autocomplete="off" placeholder="••••" autofocus>'
      + '<div class="error mt" id="pinErr"></div><button class="btn btn-primary btn-lg btn-block mt" type="submit">Unlock</button></form>'
      + '<p class="small muted mt">Staff only. The admin PIN also works. <a href="/admin">Admin</a></p></div>', 'lock');
    $('#pin').focus();
    $('#pinForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('#pinErr').textContent = '';
      try {
        const r = await Api.post('/api/auth', { role: 'kiosk', pin: $('#pin').value }, { silent: true });
        Api.setToken(r.token);
        state.settings = await Api.get('/api/settings');
        showHome();
      } catch (err) {
        $('#pinErr').textContent = err.message;
        $('#pin').value = '';
        $('#pin').focus();
      }
    });
  }

  /* ---- home / search --------------------------------------------------- */
  function showHome() {
    state.family = null; state.selected = new Set(); state.labels = null; state.code = null;
    clearInterval(countdownTimer);
    render('<div class="shell">'
      + '<div class="home-menu" id="homeMenu"><button class="menu-btn" id="menuBtn" aria-label="Menu" aria-expanded="false">'
      + '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>'
      + '<div class="menu-list hidden" id="menuList"><button class="menu-item" id="goCheckout">Check out</button><a class="menu-item" href="/admin">Staff admin</a></div></div>'
      + '<div class="topbar center-top">' + brand() + '</div>'
      + '<div class="hero"><h1>Welcome! Let\'s get you checked in.</h1></div>'
      + '<div class="search-wrap"><span class="icon"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.8-3.8"/></svg></span><input id="q" class="input input-lg" placeholder="Last name or phone number" autocomplete="off" autocapitalize="words" enterkeyhint="search"></div>'
      + '<div id="results" class="results"></div>'
      + '<div class="center mt"><button class="btn btn-secondary btn-lg" id="newFamily">First time here? Add your family</button></div>'
      + '</div>', 'home');
    const q = $('#q');
    q.focus();
    q.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => search(q.value.trim()), 220);
    });
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(searchTimer); search(q.value.trim()); } });
    $('#newFamily').addEventListener('click', showNewFamily);
    $('#goCheckout').addEventListener('click', showCheckout);
    const menuBtn = $('#menuBtn'), menuList = $('#menuList');
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menuList.classList.toggle('hidden');
      menuBtn.setAttribute('aria-expanded', String(!open));
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('#homeMenu')) menuList.classList.add('hidden'); });
  }

  /* ---- check out (by pickup code) -------------------------------------- */
  function showCheckout() {
    clearInterval(countdownTimer);
    render('<div class="shell">'
      + '<div class="topbar grid-top"><button class="btn btn-secondary" id="back">‹ Back</button>' + brand() + '<div></div></div>'
      + '<div class="card"><h1>Check out</h1><p class="muted">Type the 4-character code from your parent pickup tag.</p>'
      + '<div class="row"><input id="code" class="input input-lg grow" placeholder="e.g. K7Q2" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" style="letter-spacing:0.2em;text-transform:uppercase;max-width:320px">'
      + '<button class="btn btn-primary btn-lg" id="find">Find</button></div>'
      + '<div id="pickupKids" class="kids mt"></div>'
      + '<div id="pickupActions" class="row mt"></div></div></div>', 'checkout');
    $('#back').addEventListener('click', showHome);
    const input = $('#code');
    input.focus();
    input.addEventListener('input', () => { if (input.value.trim().length === 4) lookupCode(); else { $('#pickupKids').innerHTML = ''; $('#pickupActions').innerHTML = ''; } });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') lookupCode(); });
    $('#find').addEventListener('click', lookupCode);
  }

  async function lookupCode() {
    const code = ($('#code').value || '').trim().toUpperCase();
    const box = $('#pickupKids');
    const actions = $('#pickupActions');
    if (code.length < 3) return;
    try {
      const r = await Api.get('/api/pickup?code=' + encodeURIComponent(code) + '&date=' + Api.localDate());
      if (!r.checkins.length) {
        box.innerHTML = '<div class="notice bad">No check-in today with code ' + esc(code) + '. Please check the tag or see a volunteer.</div>';
        actions.innerHTML = '';
        return;
      }
      box.innerHTML = r.checkins.map((c) => '<div class="kid ' + (c.checked_out_local ? 'checked' : '') + '" data-id="' + c.id + '" style="cursor:default">'
        + '<div class="info"><div class="name">' + esc(c.first_name) + ' ' + esc(c.last_name) + '</div><div class="sub">'
        + '<span class="chip chip-room">' + esc(c.classroom_name || 'No classroom') + '</span>'
        + (c.checked_out_local ? '<span class="chip chip-ok">✓ Checked out ' + esc(c.checked_out_time) + '</span>' : '<span class="chip">Checked in ' + esc(c.checked_in_time) + '</span>')
        + '</div></div><div class="actions">'
        + (c.checked_out_local ? '<button class="btn btn-sm btn-ghost" data-act="undo">Undo</button>' : '<button class="btn btn-sm btn-success" data-act="checkout">Check out</button>')
        + '</div></div>').join('');
      const here = r.checkins.filter((c) => !c.checked_out_local);
      actions.innerHTML = (here.length > 1 ? '<button class="btn btn-success btn-lg" id="checkoutAll">Check out all ' + here.length + '</button>' : '')
        + (here.length ? '' : '<span class="notice ok">All checked out — thank you!</span>')
        + '<button class="btn btn-secondary btn-lg" id="pickupDone">Done</button>';
      box.onclick = async (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const id = btn.closest('.kid').dataset.id;
        try {
          if (btn.dataset.act === 'checkout') await Api.post('/api/checkins/' + id + '/checkout', { local_time: Api.localTime() });
          if (btn.dataset.act === 'undo') await Api.post('/api/checkins/' + id + '/undo-checkout');
          await lookupCode();
        } catch (ex) { Toast.show(ex.message, 'error'); }
      };
      const all = $('#checkoutAll');
      if (all) all.addEventListener('click', async () => {
        try {
          for (const c of here) await Api.post('/api/checkins/' + c.id + '/checkout', { local_time: Api.localTime() });
          Toast.show('Checked out ' + here.map((c) => c.first_name).join(', ') + '. Thank you!', 'ok');
          await lookupCode();
        } catch (ex) { Toast.show(ex.message, 'error'); }
      });
      $('#pickupDone').addEventListener('click', showHome);
    } catch (e) {
      box.innerHTML = '<div class="notice bad">' + esc(e.message) + '</div>';
      actions.innerHTML = '';
    }
  }

  async function search(q) {
    const box = $('#results');
    if (!box) return;
    if (q.length < 2) { box.innerHTML = ''; return; }
    const seq = ++searchSeq;
    try {
      const r = await Api.get('/api/search?q=' + encodeURIComponent(q) + '&date=' + Api.localDate());
      if (seq !== searchSeq) return;
      if (!r.results.length) {
        box.innerHTML = '<div class="card center"><p>No family found for “' + esc(q) + '”.</p><p class="muted small">Try a different spelling or your phone number, or add your family below.</p></div>';
        return;
      }
      box.innerHTML = r.results.map((f) => '<button class="result" data-id="' + f.id + '">'
        + '<div class="avatar">' + esc(initials(f.name)) + '</div><div><div class="name">' + esc(f.name) + '</div>'
        + '<div class="meta">' + esc([f.parents.join(', '), f.children.length ? 'Kids: ' + f.children.join(', ') : 'No children on file yet', f.phone_hint].filter(Boolean).join(' · ')) + '</div></div>'
        + '<span class="arrow">›</span></button>').join('');
      $$('.result', box).forEach((b) => b.addEventListener('click', () => openFamily(b.dataset.id)));
    } catch (e) {
      if (seq === searchSeq) box.innerHTML = '<div class="card error">' + esc(e.message) + '</div>';
    }
  }

  /* ---- family screen --------------------------------------------------- */
  async function openFamily(id, preselectAll) {
    try {
      const fam = await Api.get('/api/families/' + id + '?date=' + Api.localDate());
      showFamily(fam, preselectAll);
    } catch (e) { Toast.show(e.message, 'error'); }
  }

  function showFamily(fam, preselectAll) {
    state.family = fam;
    const pre = preselectAll !== undefined ? preselectAll : state.settings.preselect_children !== false;
    if (pre) {
      state.selected = new Set(fam.children.filter((k) => !activeCheckin(k) && !needsBirthday(k)).map((k) => k.id));
    } else {
      state.selected = new Set([...state.selected].filter((id) => fam.children.some((k) => k.id === id && !activeCheckin(k) && !needsBirthday(k))));
    }
    const parents = fam.parents.map((p) => p.first_name).join(', ');
    render('<div class="shell">'
      + '<div class="topbar grid-top"><button class="btn btn-secondary" id="back">‹ Not you? Go back</button>' + brand() + '<div></div></div>'
      + '<div class="card"><h1>Hi, ' + esc(fam.name) + '!</h1>'
      + '<p class="muted">' + esc([parents ? 'Parents: ' + parents : '', fam.phone_display].filter(Boolean).join(' · ')) + '</p>'
      + '<p>Tap each child who is here today, then press <strong>Check In</strong>.</p>'
      + '<div class="kids" id="kids"></div>'
      + '<div id="newKid"></div>'
      + '<div class="mt row"><button class="btn btn-secondary" id="addChild">+ Add a child</button>'
      + '<button class="btn btn-secondary" id="addSpouse">+ Add spouse / parent</button></div>'
      + '<div id="spousePanel"></div></div>'
      + '<div class="sticky-actions"><div class="inner"><div class="grow muted" id="selSummary"></div><button class="btn btn-primary btn-lg" id="checkin">Check In</button></div></div>'
      + '</div>', 'family');
    $('#back').addEventListener('click', showHome);
    $('#addChild').addEventListener('click', () => {
      const last = (fam.parents[0] && fam.parents[0].last_name) || '';
      $('#newKid').innerHTML = childForm({ last_name: last }, 'new');
      wireChildForm($('#newKid form'), null);
      $('#newKid input[name=first_name]').focus();
    });
    $('#addSpouse').addEventListener('click', showSpousePanel);
    $('#checkin').addEventListener('click', doCheckin);
    $('#kids').addEventListener('click', onKidClick);
    renderKids();
  }

  /* ---- spouse / second parent ----------------------------------------- */
  function showSpousePanel() {
    const panel = $('#spousePanel');
    panel.innerHTML = '<div class="inline-form"><h3>Add a spouse or parent</h3>'
      + '<p class="muted small">If they are already in our records, search their name and tap <strong>Connect</strong> to join the two records into one family. Otherwise add them as new.</p>'
      + '<div class="field"><label>Search by name</label><input class="input" id="spouseQ" placeholder="e.g. Nathan Zanders" autocomplete="off" autocapitalize="words"></div>'
      + '<div id="spouseResults" class="results"></div>'
      + '<div class="row mt"><button type="button" class="btn btn-ghost btn-sm" id="spouseNew">Not in our records — add as new</button>'
      + '<button type="button" class="btn btn-secondary btn-sm" id="spouseCancel">Cancel</button></div><div id="spouseForm"></div></div>';
    const q = $('#spouseQ');
    q.focus();
    let timer = null;
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => searchSpouse(q.value.trim()), 220); });
    $('#spouseCancel').addEventListener('click', () => { panel.innerHTML = ''; });
    $('#spouseNew').addEventListener('click', () => {
      const last = (state.family.parents[0] && state.family.parents[0].last_name) || '';
      $('#spouseForm').innerHTML = '<form class="inline-form" autocomplete="off" style="background:#fff"><div class="form-grid">'
        + '<div class="field"><label>First name</label><input class="input" autocomplete="off" name="first_name" required autocapitalize="words"></div>'
        + '<div class="field"><label>Last name</label><input class="input" autocomplete="off" name="last_name" value="' + esc(last) + '" autocapitalize="words"></div>'
        + '<div class="field"><label>Mobile phone</label><input class="input" autocomplete="off" name="phone" type="tel" inputmode="tel"></div>'
        + '<div class="field"><label>Email (optional)</label><input class="input" autocomplete="off" name="email" type="email"></div></div>'
        + '<div class="row mt"><button class="btn btn-primary" type="submit">Add parent</button></div><div class="error mt" data-err></div></form>';
      const form = $('#spouseForm form');
      $('input', form).focus();
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const r = await Api.post('/api/people', Object.assign({ family_id: state.family.id, role: 'adult', date: Api.localDate() }, fromForm(form)));
          Toast.show(r.person.first_name + ' was added to your family.', 'ok');
          showFamily(r.family, false);
        } catch (ex) { $('[data-err]', form).textContent = ex.message; }
      });
    });
  }

  async function searchSpouse(qs) {
    const box = $('#spouseResults');
    if (!box) return;
    if (qs.length < 2) { box.innerHTML = ''; return; }
    try {
      const r = await Api.get('/api/search?q=' + encodeURIComponent(qs) + '&date=' + Api.localDate());
      const list = r.results.filter((f) => f.id !== state.family.id);
      if (!list.length) { box.innerHTML = '<p class="muted small">No one found by that name. Use “add as new” below.</p>'; return; }
      box.innerHTML = list.map((f) => '<div class="result"><div class="avatar">' + esc(initials(f.name)) + '</div>'
        + '<div class="grow"><div class="name">' + esc(f.parents.length ? f.parents.join(' & ') : f.name) + '</div>'
        + '<div class="meta">' + esc([f.name, f.children.length ? 'Kids: ' + f.children.join(', ') : '', f.phone_hint].filter(Boolean).join(' · ')) + '</div></div>'
        + '<button type="button" class="btn btn-sm btn-primary" data-merge="' + f.id + '">Connect</button></div>').join('');
      $$('[data-merge]', box).forEach((btn) => btn.addEventListener('click', async () => {
        if (!btn.dataset.armed) {
          btn.dataset.armed = '1';
          btn.className = 'btn btn-sm btn-danger';
          btn.textContent = 'Tap again to connect';
          setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.className = 'btn btn-sm btn-primary'; btn.textContent = 'Connect'; } }, 5000);
          return;
        }
        try {
          const fam = await Api.post('/api/families/' + state.family.id + '/merge', { other_family_id: btn.dataset.merge, date: Api.localDate() });
          Toast.show('Connected! Your family records are now one.', 'ok');
          showFamily(fam, false);
        } catch (ex) { Toast.show(ex.message, 'error', 6000); }
      }));
    } catch (e) { box.innerHTML = '<p class="error">' + esc(e.message) + '</p>'; }
  }

  function renderKids() {
    const fam = state.family;
    const box = $('#kids');
    if (!fam.children.length) {
      box.innerHTML = '<div class="notice info">No children on file yet. Tap <strong>Add a child</strong> below.</div>';
    } else {
      box.innerHTML = fam.children.map(kidCard).join('');
    }
    updateSummary();
  }

  function kidCard(k) {
    const ci = activeCheckin(k);
    const needs = needsBirthday(k);
    const sel = state.selected.has(k.id);
    const cls = ci ? 'checked' : needs ? 'needs' : sel ? 'selected' : '';
    const chips = [];
    if (ci) chips.push('<span class="chip chip-ok">✓ Checked in ' + esc(ci.checked_in_time) + (ci.classroom_name ? ' · ' + esc(ci.classroom_name) : '') + '</span>');
    else if (needs) chips.push('<span class="chip chip-warn">Birthday or classroom needed</span>');
    else { chips.push(roomChip(k)); if (k.age !== null) chips.push('<span class="chip">Age ' + esc(k.age) + '</span>'); }
    if (k.allergies) chips.push('<span class="chip chip-danger">⚠ ' + esc(k.allergies) + '</span>');
    if (k.notes) chips.push('<span class="chip chip-note">' + esc(k.notes) + '</span>');
    let actions = '';
    if (ci) actions = '<button class="btn btn-sm btn-secondary" data-act="reprint">Reprint label</button>'
      + '<button class="btn btn-sm btn-ghost" data-act="undo">Undo check-in</button><button class="btn btn-sm btn-ghost" data-act="edit">Edit</button>';
    else actions = (needs ? '<button class="btn btn-sm btn-primary" data-act="birthday">Set birthday / classroom</button>' : '') + '<button class="btn btn-sm btn-ghost" data-act="edit">Edit</button>';
    return '<div class="kid ' + cls + '" data-id="' + k.id + '"><div class="box">' + (ci || sel ? '✓' : '') + '</div>'
      + '<div class="info"><div class="name">' + esc(k.first_name) + ' ' + esc(k.last_name) + '</div><div class="sub">' + chips.join('') + '</div><div class="editor"></div></div>'
      + '<div class="actions">' + actions + '</div></div>';
  }

  function updateSummary() {
    const fam = state.family;
    const chosen = fam.children.filter((k) => state.selected.has(k.id));
    const btn = $('#checkin');
    const sum = $('#selSummary');
    if (!btn) return;
    btn.disabled = chosen.length === 0;
    btn.textContent = chosen.length ? 'Check In ' + chosen.length + (chosen.length === 1 ? ' child' : ' children') : 'Check In';
    sum.innerHTML = chosen.length
      ? chosen.map((k) => esc(k.first_name) + ' → ' + esc(k.classroom_name || 'no classroom')).join('<br>')
      : 'Select the children who are here today.';
  }

  async function onKidClick(e) {
    const card = e.target.closest('.kid');
    if (!card) return;
    if (e.target.closest('.editor')) return;
    const k = state.family.children.find((x) => x.id === card.dataset.id);
    const act = e.target.closest('[data-act]') && e.target.closest('[data-act]').dataset.act;
    if (act === 'edit' || act === 'birthday') {
      const editor = $('.editor', card);
      editor.innerHTML = childForm(k, act);
      wireChildForm($('form', editor), k);
      $('input', editor).focus();
      return;
    }
    if (act === 'reprint') return reprint(k);
    if (act === 'undo') return undoCheckin(k, e.target.closest('[data-act]'));
    if (activeCheckin(k) || needsBirthday(k)) return;
    if (state.selected.has(k.id)) state.selected.delete(k.id); else state.selected.add(k.id);
    renderKids();
  }

  function childForm(k, mode) {
    const full = mode !== 'birthday';
    return '<form class="inline-form" autocomplete="off" data-mode="' + mode + '"><div class="form-grid">'
      + (full ? '<div class="field"><label>First name</label><input class="input" autocomplete="off" name="first_name" value="' + esc(k.first_name || '') + '" required autocapitalize="words"></div>'
        + '<div class="field"><label>Last name</label><input class="input" autocomplete="off" name="last_name" value="' + esc(k.last_name || '') + '" autocapitalize="words"></div>' : '')
      + '<div class="field"><label>Birthday (or pick a classroom)</label><input class="input" autocomplete="off" type="date" name="birthdate" value="' + esc(k.birthdate || '') + '" max="' + Api.localDate() + '"></div>'
      + roomSelect(k)
      + (full ? ''
        + '<div class="field"><label>Allergies</label><input class="input" autocomplete="off" name="allergies" value="' + esc(k.allergies || '') + '" placeholder="e.g. peanuts, dairy"></div>'
        + '<div class="field"><label>Notes for the classroom</label><input class="input" autocomplete="off" name="notes" value="' + esc(k.notes || '') + '" placeholder="e.g. needs inhaler, shy at drop-off"></div>' : '')
      + '</div><div class="row mt"><button class="btn btn-primary" type="submit">Save</button><button class="btn btn-secondary" type="button" data-act="cancel">Cancel</button>'
      + (mode === 'edit' ? '<button class="btn btn-ghost btn-sm" type="button" data-act="adult">This is a parent, not a child</button>' : '')
      + '</div><div class="error mt" data-err></div></form>';
  }

  function wireChildForm(form, k) {
    form.addEventListener('click', async (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act === 'cancel') { e.preventDefault(); form.remove(); return; }
      if (act === 'adult' && k) {
        e.preventDefault();
        try {
          const r = await Api.put('/api/people/' + k.id, { role: 'adult', date: Api.localDate() });
          state.family = r.family; state.selected.delete(k.id); renderKids();
          Toast.show(k.first_name + ' is now listed as a parent.', 'ok');
        } catch (err) { $('[data-err]', form).textContent = err.message; }
      }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = fromForm(form);
      data.date = Api.localDate();
      const err = $('[data-err]', form);
      err.textContent = '';
      if (!data.birthdate && !data.classroom_override && (!k || !k.birthdate)) {
        err.textContent = 'Enter a birthday or choose a classroom.';
        return;
      }
      try {
        let r;
        if (k) r = await Api.put('/api/people/' + k.id, data);
        else r = await Api.post('/api/people', Object.assign({ family_id: state.family.id, role: 'child' }, data));
        state.family = r.family;
        if (r.person && !needsBirthday(r.person) && !activeCheckin(r.person)) state.selected.add(r.person.id);
        if (!k) $('#newKid').innerHTML = '';
        renderKids();
      } catch (ex) { err.textContent = ex.message; }
    });
  }

  /* First tap asks to confirm; second tap (within 5s) removes today's check-in. */
  async function undoCheckin(k, btn) {
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.className = 'btn btn-sm btn-danger';
      btn.textContent = 'Tap again to undo';
      setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.className = 'btn btn-sm btn-ghost'; btn.textContent = 'Undo check-in'; } }, 5000);
      return;
    }
    try {
      await Api.del('/api/checkins/' + k.checkin.id);
      state.family = await Api.get('/api/families/' + state.family.id + '?date=' + Api.localDate());
      state.selected.delete(k.id);
      renderKids();
      Toast.show(k.first_name + '\'s check-in was undone.', 'ok');
    } catch (e) { Toast.show(e.message, 'error'); }
  }

  async function reprint(k) {
    try {
      const r = await Api.post('/api/labels/reprint', { checkin_ids: [k.checkin.id], parent: false });
      await Printer.printLabels(r.labels, state.settings.print_method, state.settings.label);
      Toast.show('Label sent to the printer.', 'ok');
    } catch (e) { Toast.show(e.message, 'error', 6000); }
  }

  /* ---- check in + print ------------------------------------------------ */
  async function doCheckin() {
    const btn = $('#checkin');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="border-top-color:#fff"></span> Checking in…';
    try {
      const r = await Api.post('/api/checkins', {
        family_id: state.family.id, person_ids: [...state.selected], local_date: Api.localDate(), local_time: Api.localTime(),
      });
      state.family = r.family; state.labels = r.labels; state.code = r.code;
      showDone(r);
    } catch (e) {
      Toast.show(e.message, 'error', 6000);
      btn.disabled = false; btn.textContent = 'Check In';
    }
  }

  function showDone(r) {
    const kids = r.checkins.map((c) => esc(c.first_name) + ' → <strong>' + esc(c.classroom_name || 'no classroom') + '</strong>');
    const secs = state.settings.kiosk_auto_return_seconds || 15;
    render('<div class="shell"><div class="card pad-lg center">'
      + '<div class="done-mark">✓</div><h1>You\'re checked in!</h1>'
      + '<p class="muted">Your pickup code is printed on each child\'s label and on your parent tag. Show the tag at pickup.</p>'
      + '<div class="done-code">' + esc(r.code) + '</div>'
      + '<p>' + kids.join('<br>') + '</p>'
      + (r.already_checked_in.length ? '<p class="muted small">Already checked in earlier: ' + esc(r.already_checked_in.join(', ')) + '</p>' : '')
      + '<div id="printStatus" class="print-status"></div>'
      + '<div class="row" style="justify-content:center"><button class="btn btn-secondary" id="reprintAll">Print again</button><button class="btn btn-primary btn-lg" id="finish">Done</button></div>'
      + '<p class="small muted mt">Returning to the start in <span id="countdown">' + secs + '</span>s</p>'
      + '</div><div class="card"><h3>Your labels</h3><div class="label-grid" id="previews"></div></div></div>', 'done');
    $('#finish').addEventListener('click', showHome);
    $('#reprintAll').addEventListener('click', () => printNow(state.labels));
    const grid = $('#previews');
    (state.labels || []).forEach((l) => {
      const box = el('<div class="label-box"></div>');
      grid.appendChild(box);
      LabelPreview.render(box, l, state.settings.label);
    });
    startCountdown(secs);
    if (state.labels && state.labels.length) printNow(state.labels);
    else $('#printStatus').textContent = 'Nothing new to print.';
  }

  function startCountdown(secs) {
    clearInterval(countdownTimer);
    let left = secs;
    countdownTimer = setInterval(() => {
      left -= 1;
      const c = $('#countdown');
      if (!c) { clearInterval(countdownTimer); return; }
      c.textContent = left;
      if (left <= 0) { clearInterval(countdownTimer); showHome(); }
    }, 1000);
  }

  async function printNow(labels) {
    const st = $('#printStatus');
    if (!st) return;
    st.className = 'print-status';
    st.innerHTML = '<span class="spinner"></span> Printing ' + labels.length + ' label' + (labels.length === 1 ? '' : 's') + '…';
    try {
      const r = await Printer.printLabels(labels, state.settings.print_method, state.settings.label);
      if (!$('#printStatus')) return;
      st.innerHTML = '✅ Printed ' + r.printed + ' label' + (r.printed === 1 ? '' : 's') + (r.printer ? ' on ' + esc(r.printer) : '');
    } catch (e) {
      if (!$('#printStatus')) return;
      clearInterval(countdownTimer);
      const c = $('#countdown'); if (c) c.parentElement.textContent = 'Auto-return paused.';
      st.className = 'print-status notice bad';
      st.innerHTML = '<div><div>Couldn\'t print: ' + esc(e.message) + '</div><div class="row mt" style="justify-content:center">'
        + '<button class="btn btn-sm btn-primary" id="retryPrint">Try again</button>'
        + '<button class="btn btn-sm btn-secondary" id="dialogPrint">Use the print dialog instead</button></div></div>';
      $('#retryPrint').addEventListener('click', () => printNow(labels));
      $('#dialogPrint').addEventListener('click', async () => {
        try { await Printer.printLabels(labels, 'dialog', state.settings.label); st.className = 'print-status'; st.textContent = 'Sent to the print dialog.'; }
        catch (ex) { Toast.show(ex.message, 'error'); }
      });
    }
  }

  /* ---- new family ------------------------------------------------------ */
  function showNewFamily() {
    render('<div class="shell">'
      + '<div class="topbar grid-top"><button class="btn btn-secondary" id="back">‹ Back</button>' + brand() + '<div></div></div>'
      + '<div class="card"><h1>Add your family</h1><p class="muted">We\'ll remember you next time — just type your name or phone number.</p>'
      + '<form id="nf" autocomplete="off"><h3>Parent / guardian</h3><div id="parents" class="stack"></div>'
      + '<button type="button" class="btn btn-ghost btn-sm" id="addParent">+ Add another parent</button>'
      + '<h3 class="mt">Children</h3><div id="children" class="stack"></div>'
      + '<button type="button" class="btn btn-ghost btn-sm" id="addKid">+ Add another child</button>'
      + '<div class="error mt" id="nfErr"></div>'
      + '<div class="mt row"><button class="btn btn-primary btn-lg" type="submit">Save and continue</button></div></form></div></div>', 'new');
    $('#back').addEventListener('click', showHome);
    const parents = $('#parents'), children = $('#children');
    const parentRow = () => el('<div class="inline-form"><div class="form-grid">'
      + '<div class="field"><label>First name</label><input class="input" autocomplete="off" name="first_name" required autocapitalize="words"></div>'
      + '<div class="field"><label>Last name</label><input class="input" autocomplete="off" name="last_name" required autocapitalize="words"></div>'
      + '<div class="field"><label>Mobile phone</label><input class="input" autocomplete="off" name="phone" type="tel" inputmode="tel" required placeholder="(208) 555-0123"></div>'
      + '<div class="field"><label>Email (optional)</label><input class="input" autocomplete="off" name="email" type="email" inputmode="email"></div>'
      + '</div><div class="row mt"><button type="button" class="btn btn-ghost btn-sm" data-remove>Remove</button></div></div>');
    const childRow = () => el('<div class="inline-form"><div class="form-grid">'
      + '<div class="field"><label>First name</label><input class="input" autocomplete="off" name="first_name" required autocapitalize="words"></div>'
      + '<div class="field"><label>Last name</label><input class="input" autocomplete="off" name="last_name" autocapitalize="words"></div>'
      + '<div class="field"><label>Birthday (or pick a classroom)</label><input class="input" autocomplete="off" type="date" name="birthdate" max="' + Api.localDate() + '"></div>'
      + roomSelect({})
      + '<div class="field"><label>Allergies</label><input class="input" autocomplete="off" name="allergies" placeholder="e.g. peanuts, dairy"></div>'
      + '<div class="field"><label>Notes for the classroom</label><input class="input" autocomplete="off" name="notes" placeholder="e.g. needs inhaler"></div>'
      + '</div><div class="row mt"><button type="button" class="btn btn-ghost btn-sm" data-remove>Remove</button></div></div>');
    const add = (box, make) => {
      const row = make();
      box.appendChild(row);
      $('[data-remove]', row).addEventListener('click', () => { if (box.children.length > 1) row.remove(); });
      return row;
    };
    add(parents, parentRow);
    add(children, childRow);
    $('#addParent').addEventListener('click', () => add(parents, parentRow));
    $('#addKid').addEventListener('click', () => add(children, childRow));
    // fill a child's last name from the first parent when left blank
    children.addEventListener('focusin', (e) => {
      if (e.target.name === 'last_name' && !e.target.value) e.target.value = $('input[name=last_name]', parents).value;
    });
    $('#nf').addEventListener('submit', async (e) => {
      e.preventDefault();
      const rows = (box) => $$('.inline-form', box).map((r) => { const o = {}; $$('input,select', r).forEach((i) => { o[i.name] = i.value.trim(); }); return o; });
      const body = { parents: rows(parents), children: rows(children), date: Api.localDate() };
      body.children.forEach((c) => { if (!c.last_name) c.last_name = body.parents[0].last_name; });
      const err = $('#nfErr');
      err.textContent = '';
      const missing = body.children.find((c) => c.first_name && !c.birthdate && !c.classroom_override);
      if (missing) { err.textContent = 'Enter a birthday or choose a classroom for ' + missing.first_name + '.'; return; }
      const btn = $('#nf button[type=submit]');
      btn.disabled = true;
      try {
        const fam = await Api.post('/api/families', body);
        Toast.show('Welcome, ' + fam.name + '!', 'ok');
        showFamily(fam, true);
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
    $('input', parents).focus();
  }

  init();
})();
