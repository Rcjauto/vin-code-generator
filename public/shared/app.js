'use strict';

/* ======================================================================
   SETTINGS
   ====================================================================== */
const API_URL = '/api'; // Netlify function (netlify/functions/api.js). The Apps Script address and key live only on the server.
const COMPANY = 'RCJ AUTO FORGE PVT LTD.';

/* ======================================================================
   THIS PRODUCT
   Everything that differs between products (name, card wording, checklist, model and colour
   suggestions) lives in that product's own folder, in product.js. This file is shared.
   ====================================================================== */
const PRODUCT = window.PRODUCT;
if (!PRODUCT || !PRODUCT.id || !PRODUCT.card) throw new Error('product.js is missing or incomplete.');
let CARD_LANGS = PRODUCT.card; // { en: {...}, hi: {...} }
const TOKEN_KEY = 'hc-token-' + PRODUCT.id; // each product page keeps its own login

/* Called with the product the server says the login belongs to. */
function setProduct(p) {
  if (p && p.id && p.id !== PRODUCT.id) {
    throw new Error('This login is for another product. Open that product\'s own page.');
  }
  state.product = { id: PRODUCT.id, name: PRODUCT.name, digits: (p && Number(p.serialDigits)) || PRODUCT.serialDigits || 5 };
  const opts = list => (list || []).map(v => '<option value="' + esc(v) + '">').join('');
  $('#dl-colour').innerHTML = opts(PRODUCT.colours);
  $('#dl-model').innerHTML = opts(PRODUCT.models);
  $('#brand-sub').textContent = 'VIN and vehicle history card - ' + PRODUCT.name;
  document.title = 'VIN & Vehicle History Card - ' + PRODUCT.name;
}

/* Row heights in points, copied from the Excel sheet; column widths are per language (in characters) */
const ROWH = [25.5, 25.5, 25.5, 25.5, 25.5, 37.5, 22.9, 18.6, 16.9, 17.45, 22.9, 16.15, 17.45, 19.15, 18.0, 23.25, 23.25, 23.25, 23.25, 23.25, 23.25, 23.25, 20.25, 22.5, 23.25, 6.0, 15.0, 38.25, 17.25, 17.25, 17.25, 17.25, 17.25, 17.25, 17.25, 17.25, 5.45, 15.0, 37.9, 25.5, 21.6, 23.25, 23.25, 22.5, 19.15, 16.9, 15.0, 27.6];
const mmCol = (L, i) => (L.colw[i] * 7 * 0.26458 * L.k).toFixed(2) + 'mm';
const mmRow = (L, n) => (ROWH[n - 1] * 0.35278 * L.k).toFixed(2) + 'mm';
const cardWidth = L => (L.colw.reduce((a, b) => a + b, 0) * 7 * 0.26458 * L.k).toFixed(2) + 'mm';

/* ======================================================================
   HELPERS
   ====================================================================== */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} },
  del(k) { try { sessionStorage.removeItem(k); } catch (e) {} },
};

const state = { id: '', token: '', lang: 'hi', product: { id: PRODUCT.id, name: PRODUCT.name, digits: PRODUCT.serialDigits || 5 }, cards: new Map(), records: [], busy: false };
const REQUIRED = []; // battery, charger, motor and controller numbers are optional: the officer can write them by hand

function toast(text, type) {
  const t = document.createElement('div');
  t.className = 'toast' + (type ? ' ' + type : '');
  t.textContent = text;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), type === 'bad' ? 6500 : 3200);
}

function setBusy(btn, on) {
  btn.disabled = on;
  btn.classList.toggle('busy', on);
}

/* ======================================================================
   SERVER
   ====================================================================== */
const apiReady = () => API_URL && !API_URL.startsWith('PASTE_');

async function api(action, payload) {
  if (!apiReady()) throw new Error('The server address (API_URL) is not set in index.html.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // keeps it a simple request, no CORS preflight
      body: JSON.stringify(Object.assign({ token: state.token, action }, payload || {})),
      signal: ctrl.signal,
      redirect: 'follow',
    });
    const raw = await res.text();
    let data;
    try { data = JSON.parse(raw); }
    catch (parseErr) {
      if (!raw.trim()) throw new Error('The server sent an empty reply (HTTP ' + res.status + '). The Netlify function /api may be missing, crashing, or timing out, or the Apps Script is not returning JSON.');
      throw new Error('The server did not return valid data (HTTP ' + res.status + '). ' + raw.trim().slice(0, 120));
    }
    if (!data.ok && data.code === 'AUTH' && action !== 'login') {
      lockApp(data.error || 'Session expired. Please log in again.', true); // login ended or revoked on the server
    }
    if (!data.ok) throw new Error(data.error || 'The server rejected the request.');
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('The server took too long. Check the connection, then check the Records tab before retrying.');
    if (e instanceof TypeError) throw new Error('Cannot reach the server. Check the internet connection and the API_URL.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ======================================================================
   LOGIN
   ====================================================================== */
function showLogin(message) {
  $('#app').hidden = true;
  $('#login-screen').hidden = false;
  $('#setup-warn').hidden = apiReady();
  $('#login-err').textContent = message || '';
  $('#login-id').value = state.id || '';
  $('#login-key').value = '';
  ($('#login-id').value ? $('#login-key') : $('#login-id')).focus();
}

function showApp() {
  $('#login-screen').hidden = true;
  $('#app').hidden = false;
}

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('#login-btn');
  state.id = $('#login-id').value.trim();
  const password = $('#login-key').value;
  $('#login-key').value = ''; // the password is never kept in the page or in the browser
  $('#login-err').textContent = '';
  setBusy(btn, true);
  try {
    const data = await api('login', { id: state.id, password, site: PRODUCT.id });
    setProduct(data.product || state.product); // refuses a login that belongs to another product
    state.token = data.token;
    store.set(TOKEN_KEY, state.token);
    startIdleTimer();
    showApp();
  } catch (err) {
    state.token = '';
    $('#login-err').textContent = err.message;
  } finally {
    setBusy(btn, false);
  }
});

/* Ends the session in this browser and clears everything on screen. */
function lockApp(message, keepId) {
  store.del(TOKEN_KEY);
  state.token = '';
  if (!keepId) state.id = '';
  state.records = [];
  state.cards.clear();
  clearTimeout(idleTimer);
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
  document.body.classList.remove('armed');
  $('#print-root').innerHTML = '';
  $('#queue').innerHTML = '';
  syncEmpty();
  showLogin(message);
}

$('#lock-btn').addEventListener('click', () => lockApp());

/* Locks itself after a period without use, so a screen left open cannot be used by someone else. */
const IDLE_MINUTES = 30;
let idleTimer = null;
function startIdleTimer() {
  clearTimeout(idleTimer);
  if (!state.token) return;
  idleTimer = setTimeout(() => {
    if (state.token) lockApp('Locked after ' + IDLE_MINUTES + ' minutes without use. Please log in again.', true);
  }, IDLE_MINUTES * 60000);
}
['pointerdown', 'keydown', 'touchstart'].forEach(ev =>
  window.addEventListener(ev, () => { if (state.token) startIdleTimer(); }, { passive: true }));

/* ======================================================================
   TABS
   ====================================================================== */
function selectTab(name) {
  ['generate', 'records'].forEach(n => {
    $('#tab-' + n).setAttribute('aria-selected', String(n === name));
    $('#panel-' + n).hidden = n !== name;
  });
  if (name === 'records') loadRecords();
}
$('#tab-generate').addEventListener('click', () => selectTab('generate'));
$('#tab-records').addEventListener('click', () => selectTab('records'));

/* ======================================================================
   GENERATE
   ====================================================================== */
$('#gen-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('#gen-btn');
  const qty = parseInt($('#qty').value, 10);
  if (!Number.isInteger(qty) || qty < 1 || qty > 10) {
    toast('Enter a quantity from 1 to 10.', 'bad');
    return;
  }
  if (state.busy) return;
  const sure = await ask({
    title: 'Generate VIN?',
    body: qty === 1
      ? 'This will create 1 new VIN and save it in the sheet. A VIN cannot be undone once created.'
      : 'This will create ' + qty + ' new VINs and save them in the sheet. VINs cannot be undone once created.',
    confirm: qty === 1 ? 'Generate VIN' : 'Generate ' + qty + ' VINs',
  });
  if (!sure) return;
  setBusy(btn, true);
  try {
    const { records } = await api('generate', { qty });
    records.slice().reverse().forEach(r => mountCard(r, true));
    toast(records.length === 1 ? 'VIN generated.' : records.length + ' VINs generated.', 'ok');
    const first = state.cards.get(records[0].vin);
    if (first) first.el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    setBusy(btn, false);
  }
});

function syncEmpty() {
  $('#queue-empty').hidden = state.cards.size > 0;
}

/* ---------- Vehicle card in the queue ---------- */
function fieldHTML(label, name, value, opts) {
  opts = opts || {};
  return '<label class="field"><span>' + label + (opts.req ? ' <i class="req" aria-hidden="true">*</i>' : '') + '</span>' +
    '<input name="' + name + '" value="' + esc(value) + '"' + (opts.req ? ' required' : '') +
    (opts.list ? ' list="' + opts.list + '"' : '') + (opts.locked ? ' disabled' : '') +
    ' maxlength="60" autocomplete="off" spellcheck="false"></label>';
}

function cardTemplate(r) {
  const lk = r.printCount > 0;
  return '' +
    '<div class="vc-head">' +
      '<div class="plate"><span class="plate-text">' + esc(r.vin) + '</span>' +
      '<button type="button" class="plate-copy" data-act="copy" aria-label="Copy VIN">Copy</button></div>' +
      '<div class="vc-meta"><span data-role="chip" class="chip"></span>' +
      '<span class="muted">Serial ' + String(r.serial).padStart(state.product.digits || 5, '0') + '</span>' +
      '<span class="muted">Generated ' + esc(r.generatedAt) + '</span></div>' +
    '</div>' +
    '<div class="fields">' +
      fieldHTML('Make of batteries', 'batteryMake', r.batteryMake, { locked: lk, list: 'dl-battery' }) +
      fieldHTML('Battery serial no.', 'batterySerial', r.batterySerial, { locked: lk }) +
      fieldHTML('Charger no.', 'chargerNo', r.chargerNo, { locked: lk }) +
      fieldHTML('Motor no.', 'motorNo', r.motorNo, { locked: lk }) +
      fieldHTML('Controller no.', 'controllerNo', r.controllerNo, { locked: lk }) +
      fieldHTML('Colour', 'colour', r.colour, { locked: lk, list: 'dl-colour' }) +
      fieldHTML('EV model', 'evModel', r.evModel, { locked: lk, list: 'dl-model' }) +
    '</div>' +
    '<p class="msg" data-role="msg" role="status"></p>' +
    '<div class="vc-actions">' +
      '<button type="button" class="btn" data-act="save">Save details</button>' +
      '<button type="button" class="btn" data-act="preview">Preview card</button>' +
      '<button type="button" class="btn primary" data-act="print">Print card</button>' +
    '</div>';
}

function mountCard(rec, prepend) {
  const existing = state.cards.get(rec.vin);
  if (existing) {
    existing.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    existing.el.classList.remove('flash');
    void existing.el.offsetWidth;
    existing.el.classList.add('flash');
    return;
  }
  const el = document.createElement('article');
  el.className = 'vc flash';
  el.dataset.vin = rec.vin;
  el.innerHTML = cardTemplate(rec);
  const entry = { rec, el, dirty: false };
  state.cards.set(rec.vin, entry);
  const q = $('#queue');
  if (prepend) q.prepend(el); else q.append(el);
  refreshCard(entry);
  syncEmpty();
}

function refreshCard(entry) {
  const { rec, el } = entry;
  const lk = rec.printCount > 0;
  el.querySelectorAll('input').forEach(i => { i.disabled = lk; });
  const chip = $('[data-role=chip]', el);
  chip.className = 'chip';
  if (lk) { chip.classList.add('ok'); chip.textContent = 'Printed ' + rec.printCount + (rec.printCount === 1 ? ' time' : ' times'); }
  else if (entry.dirty) { chip.classList.add('warn'); chip.textContent = 'Unsaved changes'; }
  else if (rec.status === 'READY') { chip.classList.add('ok'); chip.textContent = 'Ready to print'; }
  else { chip.textContent = 'Details needed'; }
  $('[data-act=save]', el).disabled = lk;
  $('[data-act=print]', el).textContent = lk ? 'Reprint card' : 'Print card';
}

function readForm(el) {
  const out = {};
  el.querySelectorAll('input[name]').forEach(i => { out[i.name] = i.value.replace(/\s+/g, ' ').trim(); });
  return out;
}

function setMsg(el, text, type) {
  const m = $('[data-role=msg]', el);
  m.textContent = text || '';
  m.className = 'msg' + (type ? ' ' + type : '');
}

function validate(el) {
  const d = readForm(el);
  el.querySelectorAll('input').forEach(i => i.classList.remove('invalid'));
  for (const [name, label] of REQUIRED) {
    if (!d[name]) {
      const inp = $('[name=' + name + ']', el);
      inp.classList.add('invalid');
      inp.focus();
      return label + ' is required.';
    }
  }
  for (const k of Object.keys(d)) {
    if (/^[=+\-@]/.test(d[k])) {
      const inp = $('[name=' + k + ']', el);
      inp.classList.add('invalid');
      inp.focus();
      return 'Values cannot start with = + - or @.';
    }
  }
  return '';
}

async function saveEntry(entry) {
  const problem = validate(entry.el);
  if (problem) { setMsg(entry.el, problem, 'bad'); return false; }
  const { record } = await api('save', { vin: entry.rec.vin, details: readForm(entry.el) });
  entry.rec = record;
  entry.dirty = false;
  state.cards.set(record.vin, entry);
  refreshCard(entry);
  setMsg(entry.el, 'Details saved.', 'ok');
  return true;
}

/* delegated events for the queue */
$('#queue').addEventListener('input', e => {
  const el = e.target.closest('.vc');
  if (!el) return;
  const entry = state.cards.get(el.dataset.vin);
  entry.dirty = true;
  e.target.classList.remove('invalid');
  setMsg(el, '');
  refreshCard(entry);
});

$('#queue').addEventListener('click', async e => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const el = btn.closest('.vc');
  const entry = state.cards.get(el.dataset.vin);
  const act = btn.dataset.act;

  if (act === 'copy') {
    try { await navigator.clipboard.writeText(entry.rec.vin); toast('VIN copied.', 'ok'); }
    catch (err) { toast('Copy is not available here. Select the VIN and copy it manually.', 'bad'); }
    return;
  }
  if (act === 'preview') { openPreview(entry); return; }
  if (state.busy) return;

  state.busy = true;
  setBusy(btn, true);
  try {
    if (act === 'save') await saveEntry(entry);
    if (act === 'print') await printFlow(entry);
  } catch (err) {
    setMsg(el, err.message, 'bad');
    toast(err.message, 'bad');
  } finally {
    state.busy = false;
    setBusy(btn, false);
  }
});

/* ======================================================================
   DIALOGS
   ====================================================================== */
function ask(opts) {
  return new Promise(resolve => {
    const dlg = $('#dlg-ask');
    const inp = $('#ask-input');
    $('#ask-title').textContent = opts.title;
    $('#ask-body').textContent = opts.body;
    $('#ask-ok').textContent = opts.confirm || 'Confirm';
    $('#ask-cancel').textContent = 'Cancel';
    $('#ask-err').textContent = '';
    $('#ask-input-wrap').hidden = !opts.input;
    if (opts.input) { $('#ask-input-label').textContent = opts.input; inp.value = ''; }

    const finish = v => {
      $('#ask-ok').removeEventListener('click', onOk);
      $('#ask-cancel').removeEventListener('click', onNo);
      dlg.removeEventListener('cancel', onEsc);
      if (dlg.open) dlg.close();
      resolve(v);
    };
    const onOk = () => {
      if (opts.input) {
        const v = inp.value.trim();
        if (v.length < 3) { $('#ask-err').textContent = 'Enter a reason of at least 3 characters.'; inp.focus(); return; }
        finish(v);
      } else finish(true);
    };
    const onNo = () => finish(opts.input ? null : false);
    const onEsc = ev => { ev.preventDefault(); onNo(); };

    $('#ask-ok').addEventListener('click', onOk);
    $('#ask-cancel').addEventListener('click', onNo);
    dlg.addEventListener('cancel', onEsc);
    dlg.showModal();
    if (opts.input) inp.focus();
  });
}
$('#ask-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#ask-ok').click(); } });

/* ======================================================================
   VEHICLE HISTORY CARD MARKUP
   ====================================================================== */
const td = (html, o) => {
  o = o || {};
  return '<td' + (o.cls ? ' class="' + o.cls + '"' : '') + (o.span ? ' colspan="' + o.span + '"' : '') + '>' + (html == null ? '' : html) + '</td>';
};
const fill = (v, cls) => '<i' + (cls ? ' class="' + cls + '"' : '') + '>' + esc(v) + '</i>';

function cardHTML(r, p, lang) {
  const isHi = (lang || state.lang) === 'hi';
  const L = CARD_LANGS[lang || state.lang] || CARD_LANGS.en;
  const tr = (n, cells, cls) => '<tr' + (cls ? ' class="' + cls + '"' : '') + ' style="height:' + mmRow(L, n) + '">' + cells + '</tr>';
  const headRow = (n, merged) => tr(n,
    td(L.sno, { cls: 'h' }) + td(L.desc, { cls: 'h' }) + td('', { cls: 'h' }) + td(L.sig, { cls: 'h' }) +
    td(L.sno, { cls: 'h' }) + td(L.desc, { cls: 'h' }) +
    (merged ? td(L.sig, { cls: 'h r', span: 2 }) : td('', { cls: 'h' }) + td(L.sig, { cls: 'h' })) +
    td(L.inline, { cls: 'h' }));

  const re = !!p && p.type !== 'ORIGINAL';
  const printNo = p
    ? '<span class="pn' + (re ? ' re' : '') + '">' + p.no + ' ' + (re ? L.reprint : L.orig) + '</span>'
    : '';

  let h = '<table><colgroup>' + L.colw.map((w, i) => '<col style="width:' + mmCol(L, i) + '">').join('') + '</colgroup><tbody>';

  /* ---- header block (rows 1 to 5) ---- */
  h += tr(1, td(esc(L.co), { cls: 'co', span: 2 }) + td(esc(L.es), { cls: 'es', span: 2 }) +
    td(esc(L.title), { cls: 'ti', span: 2 }) + td('') + td('<div class="fl"><b style="font-weight:400">' + esc(L.date) + '</b>' + fill(r.generatedDate) + '</div>', { span: 2 }), 'hb');
  h += tr(2, td('<div class="fl"><b>' + esc(L.make) + '</b>' + fill(r.batteryMake, 's" style="min-width:34mm') + '<b>' + esc(L.bsn) + '</b>' + fill(r.batterySerial) + '</div>', { span: 9 }), 'hb');
  h += tr(3, td('<div class="fl"><b>' + esc(L.chassis) + '</b>' + fill(r.vin) + '</div>', { span: 4 }) +
    td('<div class="fl"><b>' + esc(L.motor) + '</b>' + fill(r.motorNo) + '</div>', { span: 5 }), 'hb');
  h += tr(4, td('<div class="fl"><b>' + esc(L.controller) + '</b>' + fill(r.controllerNo) + '</div>', { span: 4 }) +
    td('<div class="fl"><b>' + esc(L.charger) + '</b>' + fill(r.chargerNo) + '</div>', { span: 5 }), 'hb');
  h += tr(5, td('<div class="fl"><b>' + esc(L.printno) + '</b>' + printNo + '</div>', { span: 4 }) +
    td('<div class="fl"><b>' + esc(L.colour) + '</b>' + fill(r.colour, 's" style="min-width:30mm') + '<b>' + esc(L.model) + '</b>' + fill(r.evModel) + '</div>', { span: 5 }), 'hb');

  /* ---- section 1: assembly (rows 6 to 25) ---- */
  h += headRow(6, true);
  for (let i = 0; i < L.s1l.length; i++) {
    const hasR = i < 18;
    h += tr(7 + i,
      td(i + 1, { cls: 'n' }) + td(esc(L.s1l[i]), { cls: i === 4 ? 'wr' : '' }) + td('') + td('') +
      td(hasR ? i + 1 : '', { cls: 'n' }) + td(esc(L.s1r[i] || '')) + td('') + td('') + td(''));
  }

  /* ---- section 2: functional check (rows 26 to 36) ---- */
  h += tr(26, td('', { span: 9 }), 'sp');
  h += tr(27, td(esc(L.band2), { span: 9 }), 'band');
  h += headRow(28, false);
  for (let i = 0; i < L.s2l.length; i++) {
    h += tr(29 + i,
      td(i + 1, { cls: 'n' }) + td(esc(L.s2l[i])) + td('') + td('') +
      td(i + 1, { cls: 'n' }) + td(esc(L.s2r[i][0])) + td(esc(L.s2r[i][1]), { cls: 'tq' }) + td('') + td(''));
  }

  /* ---- section 3: PDI check point (rows 37 to 48) ---- */
  h += tr(37, td('', { span: 9 }), 'sp');
  h += tr(38, td(esc(L.band3), { span: 9 }), 'band');
  h += headRow(39, false);
  for (let i = 0; i < L.s3l.length; i++) {
    h += tr(40 + i,
      td(i + 1, { cls: 'n' }) + td(esc(L.s3l[i]), { cls: i === 0 ? 'wr' : '' }) + td('') + td('') +
      td(i + 9, { cls: 'n' }) + td('') + td('') + td('') + td(''));
  }
  h += tr(48, td('') + td(esc(L.signL)) + td('') + td('') + td('') + td(esc(L.signR)) + td('') + td('') + td(''));
  h += '</tbody></table>';

  return '<div class="hc' + (isHi ? ' hi' : '') + '" style="--k:' + L.k + ';--f:' + L.f + ';line-height:' + L.lh + ';width:' + cardWidth(L) + '">' + h +
    (p ? '<div class="hc-trace"><span>' + esc(r.vin) + '</span><span>Print ' + p.no + ' / ' + esc(p.id) + ' / printed ' + esc(p.at) + '</span></div>' : '') +
    '</div>';
}

const savedLang = store.get('hc-lang');
if (savedLang && CARD_LANGS[savedLang]) { state.lang = savedLang; $('#card-lang').value = savedLang; }
$('#card-lang').addEventListener('change', e => { state.lang = e.target.value; store.set('hc-lang', state.lang); });

/* ======================================================================
   PREVIEW (on screen only, watermarked)
   ====================================================================== */
let previewEntry = null;

function openPreview(entry) {
  previewEntry = entry;
  const merged = Object.assign({}, entry.rec, readForm(entry.el));
  const host = $('#preview-scale');
  host.innerHTML = cardHTML(merged, null);
  $('#dlg-preview').showModal();
  fitPreview();
}

function fitPreview() {
  const host = $('#preview-scale');
  const card = host.firstElementChild;
  if (!card) return;
  card.style.transform = 'none';
  const natural = card.offsetWidth;
  const avail = host.parentElement.clientWidth - 28;
  const scale = Math.min(1, avail / natural);
  card.style.transform = 'scale(' + scale + ')';
  host.style.width = Math.ceil(natural * scale) + 'px';
  host.style.height = Math.ceil(card.offsetHeight * scale) + 'px';
}
window.addEventListener('resize', () => { if ($('#dlg-preview').open) fitPreview(); });

$('#preview-close').addEventListener('click', () => $('#dlg-preview').close());
$('#dlg-preview').addEventListener('close', () => { $('#preview-scale').innerHTML = ''; });
$('#preview-print').addEventListener('click', async () => {
  const entry = previewEntry;
  $('#dlg-preview').close();
  if (!entry || state.busy) return;
  state.busy = true;
  try { await printFlow(entry); }
  catch (err) { setMsg(entry.el, err.message, 'bad'); toast(err.message, 'bad'); }
  finally { state.busy = false; }
});

/* ======================================================================
   CONTROLLED PRINT
   The card exists in the page only while a registered print is running.
   Ctrl+P or the browser menu on any other screen prints a notice instead.
   ====================================================================== */
async function printFlow(entry) {
  if (entry.rec.printCount === 0) {
    const saved = await saveEntry(entry);
    if (!saved) return;
  }
  const n = entry.rec.printCount + 1;
  let reason = '';

  if (entry.rec.printCount > 0) {
    reason = await ask({
      title: 'Reason for reprint',
      body: 'This card was already printed ' + entry.rec.printCount + (entry.rec.printCount === 1 ? ' time' : ' times') + '. A reprint is recorded in the sheet and marked as a duplicate copy on the card.',
      input: 'Why is this card being reprinted?',
      confirm: 'Continue',
    });
    if (reason === null) return;
  }

  const ok = await ask({
    title: n === 1 ? 'Print this card?' : 'Reprint this card?',
    body: n === 1
      ? 'This will be recorded as print no. 1 for ' + entry.rec.vin + ' (card language: ' + CARD_LANGS[state.lang].name + '). After printing, the details are locked.'
      : 'This will be recorded as print no. ' + n + ' for ' + entry.rec.vin + ' (card language: ' + CARD_LANGS[state.lang].name + ').',
    confirm: 'Print now',
  });
  if (!ok) return;

  const { record, print } = await api('print', { vin: entry.rec.vin, reason });
  entry.rec = record;
  entry.dirty = false;
  refreshCard(entry);
  setMsg(entry.el, 'Print no. ' + print.no + ' recorded (' + print.id + ').', 'ok');
  runPrint(record, print);
}

function runPrint(record, print) {
  const root = $('#print-root');
  root.innerHTML = cardHTML(record, print);
  document.body.classList.add('armed');
  let timer = null;
  const disarm = () => {
    document.body.classList.remove('armed');
    root.innerHTML = '';
    window.removeEventListener('afterprint', disarm);
    clearTimeout(timer);
  };
  window.addEventListener('afterprint', disarm);
  timer = setTimeout(disarm, 180000); // some mobile browsers never fire afterprint
  requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
}

/* Block the usual save shortcuts. Printing itself is handled above. */
window.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && ['s', 'S'].includes(e.key)) e.preventDefault();
});

/* ======================================================================
   RECORDS
   ====================================================================== */
async function loadRecords() {
  const body = $('#rec-body');
  const empty = $('#rec-empty');
  empty.hidden = false;
  empty.textContent = 'Loading records...';
  body.innerHTML = '';
  try {
    const { records } = await api('list', { limit: 100 });
    state.records = records;
    renderRecords();
  } catch (err) {
    empty.hidden = false;
    empty.textContent = err.message;
  }
}

function renderRecords() {
  const q = $('#rec-search').value.trim().toLowerCase();
  const rows = state.records.filter(r => !q || [r.vin, r.batterySerial, r.motorNo, r.controllerNo, r.chargerNo].join(' ').toLowerCase().includes(q));
  const body = $('#rec-body');
  const empty = $('#rec-empty');
  body.innerHTML = rows.map(r => {
    const chip = r.printCount > 0 ? '<span class="chip ok">Printed</span>' : (r.status === 'READY' ? '<span class="chip warn">Ready</span>' : '<span class="chip">Details needed</span>');
    return '<tr><td class="vin">' + esc(r.vin) + '</td><td>' + esc(r.batterySerial) + '</td><td>' + esc(r.motorNo) + '</td><td>' + esc(r.controllerNo) +
      '</td><td>' + chip + '</td><td>' + r.printCount + '</td><td>' + esc(r.lastPrinted) +
      '</td><td><button class="btn" type="button" data-open="' + esc(r.vin) + '">Open</button></td></tr>';
  }).join('');
  empty.hidden = rows.length > 0;
  empty.textContent = state.records.length ? 'No record matches the search.' : 'No VINs have been generated yet.';
}

$('#rec-search').addEventListener('input', renderRecords);
$('#rec-refresh').addEventListener('click', loadRecords);
$('#rec-body').addEventListener('click', e => {
  const b = e.target.closest('[data-open]');
  if (!b) return;
  const rec = state.records.find(r => r.vin === b.dataset.open);
  if (!rec) return;
  selectTab('generate');
  mountCard(rec, true);
});

/* ======================================================================
   START
   ====================================================================== */
(async function init() {
  document.body.insertAdjacentHTML('beforeend',
    '<datalist id="dl-battery"></datalist>' +
    '<datalist id="dl-colour"></datalist>' +
    '<datalist id="dl-model"></datalist>');
  setProduct(state.product);
  store.del('hc-key'); // older versions kept the password here; remove it if it is still there
  store.del('hc-id');
  store.del('hc-token'); // older versions shared one token between all products
  const saved = store.get(TOKEN_KEY);
  if (saved && apiReady()) {
    state.token = saved;
    try { const data = await api('ping'); setProduct(data.product || state.product); startIdleTimer(); showApp(); return; }
    catch (e) { state.token = ''; store.del(TOKEN_KEY); }
  }
  showLogin();
})();
