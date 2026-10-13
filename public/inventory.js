/* ===================================================================
   גמ"ח שמלות · מערכת CRM והשכרה — לוגיקת צד לקוח
   =================================================================== */
let USER = JSON.parse(localStorage.getItem('gemach_user') || 'null');
let CTX = null;
let TAB = 'dashboard';
let ORD_FILTER = 'today';
let STOCK_FLASH = null; // הודעת מלאי פנוי אחרונה להצגה אחרי רענון כרטיס ההזמנה
let NAV_TEMPLATE = null; // התפריט המקורי מה-HTML — משוחזר בכל כניסה לפי הרשאות המשתמשת

const PAGE_TITLES = {
  dashboard: 'לוח בקרה',
  orders: 'הזמנות',
  search: 'חיפוש',
  station: 'עמדת סריקה',
  returns: 'החזרות',
  catalog: 'קטלוג ומלאי',
  customers: 'לקוחות',
  cash: 'קופה',
  cancellations: 'דוח ביטולים',
  stockcheck: 'בדיקת מלאי',
  manual: 'דוח ברקודים ידניים',
};

/* ---------- כלים ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nis = (n) => '₪' + (Math.round((+n || 0) * 100) / 100).toLocaleString('he-IL');
const shortDate = (s) => (s || '').slice(0, 10);

function toast(msg, kind = '') {
  const t = el('div', 'toast ' + kind, `<span>${kind === 'ok' ? '✓' : kind === 'err' ? '✕' : 'ℹ'}</span><span>${esc(msg)}</span>`);
  $('#toast-host').append(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, 3200);
}

/* ---------- הרשאות תצוגה ---------- */
const isManager = () => USER?.role === 'מנהלת';

/* ---------- ערימת מודאלים ----------
   כשמודאל נפתח מתוך מודאל אחר (למשל "טיפול במשפחה" מתוך סיום המשמרת),
   שתי השכבות היו באותו z-index — והשדות של המודאל הפנימי לא קיבלו פוקוס.
   כאן כל שכבה חדשה מקבלת z-index גבוה מקודמתה, ומקבלת פוקוס אוטומטי. */
function stackModal(back, focusSel = null) {
  const depth = $$('.modal-back').length; // כמה שכבות כבר פתוחות
  back.style.zIndex = String(100 + (depth + 1) * 10);
  document.body.append(back);
  setTimeout(() => {
    const f = focusSel ? back.querySelector(focusSel)
      : back.querySelector('input:not([type=checkbox]):not([disabled]), textarea, select');
    f?.focus();
  }, 40);
  return back;
}

/* ---------- זיהוי דגם ומידה מברקוד ----------
   הלקוחה מזמינה לפי ברקוד, אבל השריון הוא על דגם+מידה.
   מחזיר {model_code, model_name, size, price, source} או null אם לא זוהה. */
let MODELS_CACHE = null;
async function identifyBarcode(barcode) {
  const bc = String(barcode || '').trim();
  if (!bc) return null;
  try {
    const it = await api('/api/inv/scan/' + encodeURIComponent(bc));
    return {
      barcode: bc, model_code: it.model_code, model_name: it.model_name, size: it.size,
      price: it.premium ? it.premium_price : it.price, premium: !!it.premium,
      status: it.status, model_id: it.model_id, source: 'item',
    };
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  // הברקוד אינו רשום כשמלה — פירוק לפי מבנה הברקוד (קוד דגם + מידה), בדיוק כמו בשרת
  const digits = bc.replace(/\D/g, '');
  if (digits.length < 5) return null;
  MODELS_CACHE = MODELS_CACHE || await api('/api/inv/models');
  const code = digits.slice(0, -4);
  const md = MODELS_CACHE.find((m) => String(m.code) === code);
  if (!md) return null;
  return {
    barcode: bc, model_code: md.code, model_name: md.name,
    size: String(parseInt(digits.slice(-4, -2), 10)),
    price: md.premium ? md.premium_price : md.price, premium: !!md.premium,
    status: null, model_id: md.id, source: 'barcode',
  };
}

/* כרטיסון "זוהה: דגם · מידה · שם · מחיר" עם כפתור אישור */
function identCardHTML(info, okId, cancelId, extra = '') {
  return `<div class="card" style="margin-top:10px;border-inline-start:5px solid var(--ok);background:var(--ok-bg);padding:12px">
      <div style="font-weight:800;color:var(--navy-800);font-size:1.05rem">
        🔍 זוהה: דגם <b>${esc(info.model_code)}</b> · מידה <b>${esc(info.size || '?')}</b>
      </div>
      <div class="sub">${esc(info.model_name)} · ${info.premium ? '⭐ פרימיום ' : ''}${nis(info.price)}
        · ברקוד <span class="muted">${esc(info.barcode)}</span>
        ${info.source === 'barcode' ? ' · <i>זוהה לפי מבנה הברקוד</i>' : ''}</div>
      ${extra}
      <div class="row" style="margin-top:10px">
        <button class="btn-primary" id="${okId}">✓ אישור והוספה</button>
        <button class="btn-secondary" id="${cancelId}">ביטול</button>
      </div>
    </div>`;
}

/* ---------- צפצוף (התראה קולית) ---------- */
let _audioCtx = null;
function beep(kind = 'ok') {
  try {
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = _audioCtx;
    // דחוף (מאוחר) = שני צפצופים גבוהים; רגיל = צפצוף אחד
    const tones = kind === 'alert' ? [880, 0, 880, 1174] : [660];
    let t = ctx.currentTime;
    for (const f of tones) {
      if (f === 0) { t += 0.12; continue; }
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.frequency.value = f; osc.type = 'square';
      g.gain.setValueAtTime(0.14, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      osc.connect(g); g.connect(ctx.destination);
      osc.start(t); osc.stop(t + 0.16); t += 0.18;
    }
  } catch { /* ללא קול אם הדפדפן חוסם */ }
}

/* ---------- הקלדת ברקוד ידנית: אימות כפול + חתימה ---------- */
const SIGNATURE_TEXT = 'אני מאשרת שהשמלה אכן בידי עכשיו';
// context: שריון/מסירה/החזרה · orderId: אם ידוע · onConfirm(barcode): הפעולה שאחרי
function manualBarcodeModal(context, orderId, onConfirm) {
  const back = el('div', 'modal-back');
  const m = el('div', 'modal');
  m.style.maxWidth = '460px';
  m.innerHTML = `
    <h3>⌨️ הקלדת ברקוד ידנית</h3>
    <div class="sub">הסורק לא עבד? הקלידי את הברקוד פעמיים לאימות, ואשרי שהשמלה בידך.</div>
    <label class="fld">ברקוד</label>
    <input id="mb-1" class="in" inputmode="numeric" placeholder="הקלידי ברקוד" autocomplete="off">
    <label class="fld">הקלדה חוזרת (לאימות)</label>
    <input id="mb-2" class="in" inputmode="numeric" placeholder="הקלידי שוב" autocomplete="off">
    <label class="fld" style="display:flex;gap:8px;align-items:flex-start;margin-top:12px">
      <input type="checkbox" id="mb-sign" style="width:auto;margin-top:4px">
      <span>${SIGNATURE_TEXT}</span>
    </label>
    <div id="mb-err" class="err-line"></div>
    <div class="form-actions">
      <button class="btn-primary" id="mb-ok">אישור</button>
      <button class="btn-secondary" id="mb-cancel">ביטול</button>
    </div>`;
  back.append(m); stackModal(back, '#mb-1');
  const close = () => back.remove();
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  m.querySelector('#mb-cancel').addEventListener('click', close);
  m.querySelector('#mb-ok').addEventListener('click', async () => {
    const a = m.querySelector('#mb-1').value.trim(), b = m.querySelector('#mb-2').value.trim();
    const err = m.querySelector('#mb-err');
    if (!a) return err.textContent = 'הקלידי ברקוד';
    if (a !== b) return err.textContent = 'שתי ההקלדות אינן זהות — נסי שוב';
    if (!m.querySelector('#mb-sign').checked) return err.textContent = 'יש לאשר את החתימה';
    // רישום מיידי — נכנס לדוח "ברקודים ידניים" ומפעיל התראה, בלי תלות בפעולה שאחריו
    try {
      await api('/api/inv/manual-barcode', { method: 'POST', body: { barcode: a, context, order_id: orderId || null, signature: SIGNATURE_TEXT } });
      toast('ברקוד ידני נרשם', 'ok');
    } catch (e) { err.textContent = e.message; return; }
    close();
    onConfirm(a, SIGNATURE_TEXT);
  });
}

/* ---------- גודל תצוגה (זום) — משותף עם מערכת המשימות ---------- */
const ZOOM = { min: 1, max: 3.5, step: 0.25, def: 2 };
function getZoom() { return parseFloat(localStorage.getItem('gemach_zoom')) || ZOOM.def; }
function applyZoom(z) {
  z = Math.min(ZOOM.max, Math.max(ZOOM.min, Math.round(z * 100) / 100));
  document.body.style.zoom = z;
  localStorage.setItem('gemach_zoom', z);
  const lbl = $('#zoom-val');
  if (lbl) lbl.textContent = Math.round(z * 100) + '%';
}
function mountZoomControl() {
  const tools = $('.tb-tools');
  if (!tools || $('#zoom-ctl')) return;
  const w = el('div', 'zoom-ctl');
  w.id = 'zoom-ctl';
  w.innerHTML = `
    <button class="zoom-btn" id="zoom-minus" title="הקטנת תצוגה">א−</button>
    <span id="zoom-val">${Math.round(getZoom() * 100)}%</span>
    <button class="zoom-btn" id="zoom-plus" title="הגדלת תצוגה">א+</button>`;
  tools.prepend(w);
  w.querySelector('#zoom-minus').addEventListener('click', () => applyZoom(getZoom() - ZOOM.step));
  w.querySelector('#zoom-plus').addEventListener('click', () => applyZoom(getZoom() + ZOOM.step));
}
applyZoom(getZoom());

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': USER ? USER.id : '',
      'x-station': localStorage.getItem('gemach_station') || '',
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(data.error || 'שגיאה'); err.data = data; err.status = res.status; throw err; }
  return data;
}

/* ===================== כניסה ===================== */
async function initLogin() {
  try {
    const c = await api('/api/context');
    $('#login-hebdate').textContent = `${c.hdate} · פרשת ${c.parsha}`;
  } catch { /* לא קריטי */ }
  const doLogin = async () => {
    const code = $('#login-code').value.trim();
    $('#login-error').textContent = '';
    if (!code) return;
    try {
      const u = await api('/api/login', { method: 'POST', body: { code } });
      USER = u;
      localStorage.setItem('gemach_user', JSON.stringify(u));
      startApp();
    } catch (e) { $('#login-error').textContent = e.message; }
  };
  $('#login-btn').addEventListener('click', doLogin);
  $('#login-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('#login-code').focus();
}

async function startApp() {
  $('#login-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  try { CTX = await api('/api/context'); }
  catch { logout(); return; }

  $('#user-name').textContent = USER.name;
  $('#user-role').textContent = USER.role || 'עובדת';
  $('#su-avatar').textContent = (USER.name || '?').trim().charAt(0);
  $('#heb-context').textContent = `${CTX.hdate} · פרשת ${CTX.parsha}`;

  const st = $('#station-sel');
  st.value = localStorage.getItem('gemach_station') || '';
  // onchange ולא addEventListener — startApp רצה מחדש בכל כניסה, ומאזין נוסף היה גורם לכפילות
  st.onchange = () => {
    localStorage.setItem('gemach_station', st.value);
    toast(st.value ? `העמדה הוגדרה: מחשב ${st.value}` : 'עמדה נוקתה', 'ok');
  };

  mountZoomControl();

  // התפריט נבנה מחדש בכל כניסה מהתבנית המקורית — אחרת פריטים שהוסרו לעובדת
  // היו נעלמים גם למנהלת שנכנסת אחריה, בלי סגירת התוכנה
  if (NAV_TEMPLATE === null) NAV_TEMPLATE = $('#side-nav').innerHTML;
  $('#side-nav').innerHTML = NAV_TEMPLATE;

  // מסכים כספיים + ניהול מלאי + דוחות — למנהלת בלבד; ההשכרה (הזמנות/סריקה/לקוחות) פתוחה לאחמ"שית
  if (!isManager()) {
    $$('.nav-item').forEach((n) => {
      if (['cash', 'cancellations', 'catalog', 'manual', 'stockcheck'].includes(n.dataset.tab)) n.remove();
    });
  }

  // הלשונית הפעילה מתאפסת בכל כניסה — שלא ננחת על מסך שאין לעובדת החדשה הרשאה אליו
  if (!$(`.nav-item[data-tab="${TAB}"]`)) TAB = 'dashboard';
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.tab === TAB));
  $('#page-title').textContent = PAGE_TITLES[TAB] || '';

  $('#side-nav').onclick = (e) => {
    const btn = e.target.closest('.nav-item');
    if (!btn) return;
    TAB = btn.dataset.tab;
    $$('.nav-item').forEach((n) => n.classList.toggle('active', n === btn));
    $('#page-title').textContent = PAGE_TITLES[TAB] || '';
    render();
  };

  $('#logout-btn').onclick = () => {
    if (!confirm('לצאת מהמערכת?')) return;
    // סיום משמרת: קודם סוקרים משפחות שלא החזירו, ואז יוצאים
    shiftEndReview(() => { api('/api/logout', { method: 'POST' }).catch(() => {}); logout(); });
  };

  render();
}

function logout() {
  localStorage.removeItem('gemach_user');
  USER = null;
  // סוגרים כל חלון צף שנשאר פתוח — אחרת הוא נשאר מעל מסך הכניסה
  // וחוסם את הקלדת הקוד, ואז אין ברירה אלא לסגור את התוכנה
  document.querySelectorAll('.modal-back').forEach((b) => b.remove());
  $('#main').innerHTML = '';
  $('#app').classList.add('hidden');
  $('#login-screen').classList.remove('hidden');
  $('#login-code').value = '';
  $('#login-error').textContent = '';
  $('#login-code').focus();
}

/* ===================== ניתוב ===================== */
async function render() {
  const main = $('#main');
  main.innerHTML = '<p class="muted">טוען…</p>';
  try {
    if (TAB === 'dashboard') await renderDashboard(main);
    else if (TAB === 'orders') await renderOrders(main);
    else if (TAB === 'search') await renderSearch(main);
    else if (TAB === 'station') await renderStation(main);
    else if (TAB === 'returns') await renderReturns(main);
    else if (TAB === 'catalog') await renderCatalog(main);
    else if (TAB === 'customers') await renderCustomers(main);
    else if (TAB === 'cash') await renderCash(main);
    else if (TAB === 'cancellations') await renderCancellations(main);
    else if (TAB === 'stockcheck') await renderStockCheck(main);
    else if (TAB === 'manual') await renderManual(main);
  } catch (e) {
    if (e.status === 401) { logout(); return; }
    main.innerHTML = `<div class="empty-state" style="color:var(--danger)">${esc(e.message)}</div>`;
  }
}

function goTab(tab, filter) {
  TAB = tab;
  if (filter) ORD_FILTER = filter;
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.tab === tab));
  $('#page-title').textContent = PAGE_TITLES[tab] || '';
  render();
}

/* ===================== לוח בקרה ===================== */
async function renderDashboard(main) {
  // נתונים כספיים נטענים ומוצגים למנהלת בלבד
  const [counts, cash, todayOrders, models] = await Promise.all([
    api('/api/inv/exceptions/counts'),
    isManager() ? api(`/api/inv/cash?from=${CTX.today}&to=${CTX.today}`) : Promise.resolve(null),
    api('/api/inv/orders?filter=today'),
    api('/api/inv/models'),
  ]);
  const totalItems = models.reduce((s, m) => s + (m.item_count || 0), 0);
  const availItems = models.reduce((s, m) => s + (m.available_count || 0), 0);

  main.innerHTML = '';
  main.append(el('div', 'section-title', 'מבט מהיר על היום'));

  const kpis = el('div', 'kpi-grid');
  const kpiData = [
    { cls: '', val: counts.today, lbl: 'איסופים והחזרות להיום', hint: 'למעבר להזמנות ←', act: () => goTab('orders', 'today') },
    { cls: 'k-warn', val: counts.not_taken, lbl: 'הזמנות שלא נלקחו', hint: 'לטיפול ←', act: () => goTab('orders', 'not_taken') },
    { cls: 'k-danger', val: counts.late, lbl: 'מאחרות בהחזרה', hint: 'לגביה ←', act: () => goTab('orders', 'late') },
    ...(cash ? [{ cls: 'k-ok', val: nis(cash.summary.balance), lbl: 'יתרת קופה היום', hint: 'לקופה ←', act: () => goTab('cash') }] : []),
    { cls: '', val: `${availItems}/${totalItems}`, lbl: 'שמלות זמינות במלאי', hint: 'לקטלוג ←', act: () => goTab('catalog') },
  ];
  for (const k of kpiData) {
    const c = el('div', 'kpi ' + k.cls);
    c.innerHTML = `<div class="kpi-val">${k.val}</div><div class="kpi-lbl">${k.lbl}</div><div class="kpi-hint">${k.hint}</div>`;
    c.addEventListener('click', k.act);
    kpis.append(c);
  }
  main.append(kpis);

  const cols = el('div', 'dash-cols');

  // פאנל: אירועי היום
  const p1 = el('div', 'panel');
  p1.append(el('div', 'panel-head', `<span>📅 איסופים והחזרות היום</span><button class="btn-secondary btn-sm" id="dash-new">+ הזמנה חדשה</button>`));
  const body1 = el('div', 'panel-body');
  if (!todayOrders.length) body1.append(el('div', 'empty-state', 'אין תנועות להיום'));
  else todayOrders.forEach((o) => body1.append(orderRow(o)));
  p1.append(body1);
  cols.append(p1);

  // פאנל: פעולות מהירות
  const p2 = el('div', 'panel');
  p2.append(el('div', 'panel-head', '<span>⚡ פעולות מהירות</span>'));
  const body2 = el('div', 'panel-body');
  body2.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:16px';
  const quick = [
    ['+ הזמנה חדשה', 'btn-primary', () => orderModal(null)],
    ['◨ מעבר לעמדת סריקה', 'btn-secondary', () => goTab('station')],
    ['◉ חיפוש לקוחה', 'btn-secondary', () => goTab('customers')],
    ...(isManager() ? [['₪ סגירת קופה יומית', 'btn-secondary', () => goTab('cash')]] : []),
  ];
  quick.forEach(([label, cls, act]) => {
    const b = el('button', cls + ' btn-block', label);
    b.addEventListener('click', act);
    body2.append(b);
  });
  p2.append(body2);
  cols.append(p2);

  main.append(cols);
  $('#dash-new')?.addEventListener('click', () => orderModal(null));
}

/* ===================== רכיב שורת הזמנה ===================== */
function orderRow(o) {
  const row = el('div', 'order-row');
  row.innerHTML = `
    <div class="order-num">#${o.id}</div>
    <div class="order-main">
      <div class="order-name">${esc(o.customer_name)}</div>
      <div class="order-meta">אירוע ${esc(shortDate(o.event_date))} · איסוף ${esc(shortDate(o.pickup_date))} · החזרה ${esc(shortDate(o.return_date))}
        · ${o.item_count} שמלות${o.model_codes ? ' (' + esc(o.model_codes) + ')' : ''}</div>
    </div>
    <div class="order-flags" title="משלוחים">${o.delivery_out ? '🚚' : ''}${o.delivery_back ? '↩️' : ''}</div>
    ${o.status === 'מוכנה' ? '<button class="btn-primary btn-sm no-print" data-handover="1" title="המשפחה לקחה את השקית">✅ נלקח</button>' : ''}
    <span class="badge st-${esc(o.status)}">${esc(o.status)}</span>`;
  row.addEventListener('click', async (e) => {
    // כפתור מסירה מהיר — ישירות מהרשימה, בלי להיכנס להזמנה
    const hb = e.target.closest('[data-handover]');
    if (hb) {
      e.stopPropagation();
      if (!confirm(`לסמן שהזמנה #${o.id} של ${o.customer_name} נלקחה בפועל?`)) return;
      hb.disabled = true;
      try {
        await api(`/api/inv/orders/${o.id}/handover`, { method: 'POST', body: { note: '' } });
        toast(`הזמנה #${o.id} סומנה כנלקחה 📤`, 'ok');
        render();
      } catch (err) { hb.disabled = false; toast(err.message, 'err'); }
      return;
    }
    orderModal(o.id);
  });
  return row;
}

/* ===================== הזמנות ===================== */
async function renderOrders(main) {
  const counts = await api('/api/inv/exceptions/counts');
  main.innerHTML = '';

  const toolbar = el('div', 'toolbar no-print');
  toolbar.innerHTML = `
    <div class="search"><input id="ord-q" class="in" placeholder="חיפוש לפי מספר הזמנה / ת&quot;ז / טלפון"></div>
    <button class="btn-secondary" id="ord-search">חיפוש</button>
    <button class="btn-primary" id="ord-new">+ הזמנה חדשה</button>`;
  main.append(toolbar);

  const chips = [
    ['today', '📅 להיום', counts.today],
    ['drafts', '📝 טיוטות', counts.drafts],
    ['ready', '🎒 מוכנות לאיסוף', counts.ready],
    ['not_taken', '📦 לא נלקחו', counts.not_taken],
    ['partial', '🧩 חלקית', counts.partial],
    ['late', '⏰ מאחרות', counts.late],
    ['all', '📋 הכל', null],
  ];
  const bar = el('div', 'chip-bar');
  for (const [key, label, num] of chips) {
    const c = el('button', 'chip' + (ORD_FILTER === key ? ' active' : ''));
    c.innerHTML = `${label}${num !== null ? ` <span class="chip-num ${num ? '' : 'zero'}">${num}</span>` : ''}`;
    c.addEventListener('click', () => { ORD_FILTER = key; render(); });
    bar.append(c);
  }
  main.append(bar);

  const q = $('#ord-q');
  $('#ord-search').addEventListener('click', () => loadList(q.value.trim()));
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadList(q.value.trim()); });
  $('#ord-new').addEventListener('click', () => orderModal(null));

  const listWrap = el('div', 'list');
  main.append(listWrap);

  async function loadList(query) {
    const url = query
      ? `/api/inv/orders?q=${encodeURIComponent(query)}`
      : `/api/inv/orders${ORD_FILTER !== 'all' ? '?filter=' + ORD_FILTER : ''}`;
    const orders = await api(url);
    listWrap.innerHTML = '';
    if (!orders.length) { listWrap.append(el('div', 'empty-state', 'אין הזמנות להצגה')); return; }
    orders.forEach((o) => listWrap.append(orderRow(o)));
  }
  await loadList('');
}

/* ===================== החזרות ===================== */
/* הזמנות שנמסרו והשמלות עדיין אצל הלקוחה — ממתינות לחזור. פתוח לכל העובדות. */
async function renderReturns(main) {
  const orders = await api('/api/inv/orders?filter=returns');
  const late = orders.filter((o) => o.return_date && shortDate(o.return_date) < CTX.today);
  main.innerHTML = '';

  main.append(el('div', 'section-title', 'שמלות שממתינות לחזור מהלקוחות'));
  const kpis = el('div', 'kpi-grid');
  const k1 = el('div', 'kpi');
  k1.innerHTML = `<div class="kpi-val">${orders.length}</div><div class="kpi-lbl">ממתינות להחזרה</div>`;
  const k2 = el('div', 'kpi ' + (late.length ? 'k-danger' : 'k-ok'));
  k2.innerHTML = `<div class="kpi-val">${late.length}</div><div class="kpi-lbl">${late.length ? 'באיחור — עבר תאריך ההחזרה' : 'אין איחורים 🎉'}</div>`;
  kpis.append(k1, k2);
  main.append(kpis);

  main.append(el('div', 'sub muted', 'ההחזרה עצמה נקלטת בעמדת הסריקה — כאן רואים למי עדיין יש שמלות. לחיצה על שורה פותחת את ההזמנה.'));

  if (!orders.length) { main.append(el('div', 'empty-state', 'אין שמלות שממתינות לחזור — הכל חזר לגמ"ח 🎉')); return; }
  const list = el('div', 'list');
  orders.forEach((o) => {
    const isLate = o.return_date && shortDate(o.return_date) < CTX.today;
    const row = orderRow(o);
    if (isLate) {
      row.style.cssText = 'border-inline-start:6px solid var(--danger);background:var(--danger-bg,#fff5f5)';
      const flag = el('div', '', '<b style="color:var(--danger)">⏰ באיחור</b>');
      flag.style.cssText = 'white-space:nowrap;margin-inline-start:6px';
      row.append(flag);
    }
    list.append(row);
  });
  main.append(list);
}

/* ===================== מסך חיפוש ===================== */
async function renderSearch(main) {
  main.innerHTML = `
    <div class="card no-print">
      <div class="section-title" style="margin-top:0">⌕ חיפוש הזמנות</div>
      <div class="sub">אפשר למלא שדה אחד או כמה יחד — למשל דגם + מידה, או חודש בלבד. החיפוש כולל גם הזמנות מבוטלות וטיוטות.</div>
      <div class="row" style="margin-top:12px">
        <div class="grow"><label class="fld" style="margin-top:0">ברקוד</label><input id="se-barcode" class="in" placeholder="ברקוד שמלה"></div>
        <div class="grow"><label class="fld" style="margin-top:0">קוד דגם</label><input id="se-model" class="in" placeholder="למשל 533"></div>
        <div class="grow"><label class="fld" style="margin-top:0">מידה</label><input id="se-size" class="in" placeholder="למשל 10"></div>
      </div>
      <div class="row" style="margin-top:10px">
        <div class="grow"><label class="fld" style="margin-top:0">חודש האירוע</label><input id="se-month" class="in" type="month"></div>
        <div class="grow"><label class="fld" style="margin-top:0">יום האירוע</label><input id="se-date" class="in" type="date"></div>
        <div class="grow"><label class="fld" style="margin-top:0">לקוחה — שם / ת"ז / טלפון</label><input id="se-customer" class="in" placeholder="חיפוש חופשי"></div>
      </div>
      <div class="form-actions">
        <button class="btn-primary" id="se-go">🔍 חיפוש</button>
        <button class="btn-secondary" id="se-clear">ניקוי</button>
      </div>
      <div id="se-err" class="err-line"></div>
    </div>
    <div id="se-results" style="margin-top:16px"></div>`;

  const F = {
    barcode: '#se-barcode', model_code: '#se-model', size: '#se-size',
    month: '#se-month', event_date: '#se-date', customer: '#se-customer',
  };
  const results = $('#se-results');
  results.innerHTML = '<div class="empty-state">מלאי לפחות שדה אחד ולחצי "חיפוש"</div>';

  const doSearch = async () => {
    const err = $('#se-err');
    err.textContent = '';
    const params = new URLSearchParams();
    for (const [key, sel] of Object.entries(F)) {
      const v = $(sel).value.trim();
      if (v) params.set(key, v);
    }
    if (![...params.keys()].length) { err.textContent = 'יש למלא לפחות שדה חיפוש אחד'; return; }
    results.innerHTML = '<p class="muted">מחפשת…</p>';
    let rows;
    try { rows = await api('/api/inv/search?' + params.toString()); }
    catch (e) { err.textContent = e.message; results.innerHTML = ''; return; }
    results.innerHTML = '';
    results.append(el('div', 'section-title', `תוצאות (${rows.length}${rows.length === 200 ? '+ — מוצגות 200 הראשונות' : ''})`));
    if (!rows.length) {
      results.append(el('div', 'empty-state', 'לא נמצאו הזמנות מתאימות — נסי לחפש לפי פחות שדות'));
      return;
    }
    const list = el('div', 'list');
    rows.forEach((o) => list.append(orderRow(o)));
    results.append(list);
  };

  $('#se-go').addEventListener('click', doSearch);
  $('#se-clear').addEventListener('click', () => {
    Object.values(F).forEach((sel) => { $(sel).value = ''; });
    $('#se-err').textContent = '';
    results.innerHTML = '<div class="empty-state">מלאי לפחות שדה אחד ולחצי "חיפוש"</div>';
    $('#se-barcode').focus();
  });
  Object.values(F).forEach((sel) => {
    $(sel).addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  });
  $('#se-barcode').focus();
}

/* ===================== מודאל הזמנה ===================== */
function openModal() {
  const back = el('div', 'modal-back');
  const m = el('div', 'modal');
  back.append(m);
  stackModal(back);
  back.addEventListener('click', (e) => {
    if (e.target !== back) return;
    // הזמנה חדשה עם נתונים שהוקלדו — לא סוגרים בטעות בלחיצה על הרקע
    if (back.dataset.guard === '1' && !confirm('לסגור את ההזמנה? הפרטים שהוקלדו לא יישמרו.')) return;
    back.remove(); render();
  });
  return { back, m };
}

async function orderModal(orderId) {
  const { back, m } = openModal();
  if (!orderId) return newOrderForm(m, back);

  const o = await api('/api/inv/orders/' + orderId);
  const billed = o.items.filter((i) => i.oi_status !== 'בוטל').reduce((s, i) => s + i.price, 0);

  m.innerHTML = `
    <div class="modal-head">
      <h3>הזמנה #${o.id} <span class="badge st-${esc(o.status)}">${esc(o.status)}</span></h3>
      <button class="btn-secondary btn-sm no-print" id="om-print">🖨️ הדפסה</button>
    </div>
    ${o.status === 'מוכנה' ? `
    <div class="card no-print" style="margin-top:10px;background:var(--ok-bg);border:2px solid var(--ok);border-inline-start:8px solid var(--ok);padding:14px">
      <div style="font-weight:800;font-size:1.12rem;color:var(--ok);margin-bottom:4px">🎒 ההזמנה מוכנה בשקית — לחצי כאן כשהמשפחה לוקחת</div>
      <div class="sub" style="margin-bottom:10px">זהו השלב האחרון: אחרי הלחיצה ההזמנה עוברת לסטטוס "נמסרה" והשמלות רשומות אצל הלקוחה.</div>
      <input id="om-handover-note" class="in" placeholder="מי לקח / יצא עם משלוחן (לא חובה)">
      <button class="btn-primary btn-block" id="om-handover-btn" style="margin-top:10px;font-size:1.1rem;padding:14px">✅ נלקח בפועל — מסירה ללקוחה</button>
    </div>` : ''}
    <div class="sub"><b>${esc(o.customer_name)}</b> · ת"ז ${esc(o.tz || '—')} · ${esc(o.phone || '—')}</div>
    <div class="sub">אירוע: <b>${esc(shortDate(o.event_date))}</b> · איסוף ${esc(shortDate(o.pickup_date))} · החזרה ${esc(shortDate(o.return_date))}
      ${o.delivery_out ? ' · 🚚 משלוח הלוך' : ''}${o.delivery_back ? ' · ↩️ משלוח חזור' : ''}</div>
    ${o.customer_notes ? `<div class="alert-note">⚠️ הערות לקוחה: ${esc(o.customer_notes)}</div>` : ''}

    <div class="section-title">שמלות בהזמנה <span class="sub muted" style="font-weight:400">(השריון הוא על דגם ומידה — השמלה הספציפית נקבעת במסירה)</span></div>
    <div id="om-items"></div>
    ${['טיוטה', 'שריון'].includes(o.status) ? `
    <div class="row no-print" style="margin-top:10px">
      <input id="om-barcode" class="in grow" placeholder="📷 סריקת ברקוד — המערכת משריינת את הדגם והמידה">
      <button class="btn-primary" id="om-add">הוספה</button>
      <button class="btn-secondary" id="om-add-manual" title="הסורק לא עובד">⌨️ ידני</button>
    </div>` : ''}
    ${['שריון', 'מוכנה'].includes(o.status) && o.items.some((i) => i.oi_status === 'משוריין') ? `
    <div class="row no-print" style="margin-top:10px;background:var(--blue-100);border-radius:10px;padding:10px">
      <div style="width:100%;font-weight:700;color:var(--navy-800);margin-bottom:6px">📦 שלב 1 — הכנה לשקיות: סרקי כל שמלה שנכנסת לשקית</div>
      <input id="om-deliver-scan" class="in grow" placeholder="סרקי ברקוד של שמלה להכנה">
      <button class="btn-primary" id="om-deliver-btn">הכנה</button>
      <button class="btn-secondary" id="om-deliver-manual" title="הסורק לא עובד">⌨️ ידני</button>
    </div>` : ''}
    <div id="om-ident"></div>
    <div id="om-err" class="err-line"></div>

    <div class="section-title">כספים</div>
    ${(o.delivery_total > 0 || o.extra_days > 0) ? `<div class="sub" style="margin-bottom:6px">שמלות ${nis(o.dresses_total)}${o.extra_days > 0 ? ` + ימים נוספים ×${o.extra_days} (חצי מחיר) ${nis(o.extra_days_total)}` : ''}${o.delivery_total > 0 ? ` + משלוחים ${nis(o.delivery_total)}${o.delivery_out && o.delivery_back ? ' (הלוך+חזור)' : ''}` : ''} = <b>${nis(o.billed_total)}</b></div>` : ''}
    <div class="money-head"><span>שולם עד כה</span><span class="big">${nis(o.paid)} / ${nis(o.billed_total ?? billed)}</span></div>
    <div id="om-tx" style="margin-top:10px">${o.transactions.map((t) => `<div class="tx-line">${esc(t.at.slice(0, 16))} · <b>${esc(t.type)}</b> ${nis(t.amount)} (${esc(t.method)})${t.note ? ' · ' + esc(t.note) : ''}</div>`).join('') || '<div class="sub muted">אין תנועות כספיות</div>'}</div>
    <div class="row no-print" style="margin-top:10px">
      <select id="om-tx-type" class="in" style="max-width:120px"><option>תשלום</option><option>החזר</option></select>
      <select id="om-tx-method" class="in" style="max-width:150px"><option value="">— אמצעי —</option><option>מזומן</option><option>אשראי</option><option>שובר מתנה</option></select>
      <input id="om-tx-amount" class="in grow" type="number" placeholder="סכום ₪" min="0">
      <button class="btn-secondary" id="om-tx-add">רישום</button>
    </div>

    <div class="form-actions no-print">
      ${o.status === 'טיוטה' ? '<button class="btn-primary" id="om-finalize">✅ הפיכה להזמנה סופית</button>' : ''}
      ${['טיוטה', 'שריון', 'מוכנה'].includes(o.status) ? `<button class="btn-danger" id="om-cancel">${o.status === 'טיוטה' ? 'מחיקת טיוטה' : 'ביטול הזמנה'}</button>` : ''}
      ${o.status === 'נמסרה' ? '<span class="sub muted">השמלות אצל הלקוחה — החזרה נקלטת בעמדת הסריקה</span>' : ''}
    </div>
    <div class="sub muted no-print" style="margin-top:12px">נרשמה ${esc(o.created_at)} · ${esc(o.created_by || '')}${o.workstation ? ' · ' + esc(o.workstation) : ''}</div>`;

  const itemsDiv = m.querySelector('#om-items');
  if (!o.items.length) itemsDiv.append(el('div', 'sub muted', 'טרם נוספו שמלות — סרקי ברקוד להוספה'));
  o.items.forEach((it) => {
    const line = el('div', 'item-line' + (it.oi_status === 'בוטל' ? ' cancelled' : ''));
    // ההצגה הראשית היא דגם+מידה (עליהם השריון) — הברקוד משני וקטן
    const physical = it.barcode
      ? `<span class="sub muted" style="font-size:.82rem">ברקוד ${esc(it.barcode)}</span>`
      : '<span style="color:var(--warn);font-weight:600;font-size:.82rem">טרם שויכה שמלה — תיסרק במסירה</span>';
    line.innerHTML = `👗 <b style="font-size:1.05rem">דגם ${esc(it.model_code)} · מידה ${esc(it.size || '?')}</b>
      · ${esc(it.model_name)} · ${physical}
      · ${nis(it.price)} · <i>${esc(it.oi_status)}</i>
      ${it.oi_status === 'משוריין' ? `<button class="btn-danger btn-sm no-print" data-rm="${it.oi_id}" style="margin-inline-start:auto">הסרה</button>` : ''}`;
    itemsDiv.append(line);
  });

  itemsDiv.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-rm]');
    if (!b) return;
    const verify = prompt('אבטחת שינויים — הזיני ת"ז או טלפון של המזמינה:');
    if (!verify) return;
    try {
      await api(`/api/inv/orders/${o.id}/items/${b.dataset.rm}?verify=${encodeURIComponent(verify)}`, { method: 'DELETE' });
      toast('השמלה הוסרה מההזמנה', 'ok');
      back.remove(); orderModal(o.id);
    } catch (err) { m.querySelector('#om-err').textContent = err.message; }
  });

  // מלאי אחרון שהתקבל מהשרת — מוצג אחרי טעינה מחדש של הכרטיס
  if (STOCK_FLASH && STOCK_FLASH.orderId === o.id) {
    const f = el('div', STOCK_FLASH.last ? 'err-line' : 'ok-line', STOCK_FLASH.text);
    f.style.cssText = 'font-weight:700;margin-top:6px';
    itemsDiv.append(f);
    STOCK_FLASH = null;
  }

  // סריקת ברקוד → זיהוי דגם+מידה → אישור → שריון
  const identBox = () => m.querySelector('#om-ident');
  async function identify(barcode, manualSig = null) {
    const errEl = m.querySelector('#om-err');
    errEl.textContent = '';
    identBox().innerHTML = '';
    if (!barcode) return;
    let info;
    try { info = await identifyBarcode(barcode); }
    catch (e) { errEl.textContent = e.message; return; }
    if (!info) { errEl.textContent = `הברקוד ${barcode} אינו מזוהה — לא נמצא דגם מתאים`; return; }
    if (['לא תקין', 'נגרע'].includes(info.status)) {
      errEl.textContent = `השמלה במצב "${info.status}" — לא ניתן לשריין`; return;
    }
    identBox().innerHTML = identCardHTML(info, 'om-ident-ok', 'om-ident-cancel',
      '<div class="sub muted">השריון הוא על הדגם והמידה — לא על השמלה הספציפית שנסרקה.</div>');
    identBox().querySelector('#om-ident-cancel').addEventListener('click', () => { identBox().innerHTML = ''; });
    identBox().querySelector('#om-ident-ok').addEventListener('click', () => addItem(barcode, manualSig));
    identBox().querySelector('#om-ident-ok').focus();
  }
  m.querySelector('#om-add')?.addEventListener('click', () => identify(m.querySelector('#om-barcode').value.trim()));
  m.querySelector('#om-barcode')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') identify(m.querySelector('#om-barcode').value.trim()); });
  m.querySelector('#om-add-manual')?.addEventListener('click', () => manualBarcodeModal('שריון', o.id, (bc, sig) => identify(bc, sig)));

  async function addItem(barcode, manualSig = null) {
    if (!barcode) return;
    try {
      const body = { barcode, ...(manualSig ? { manual: true, signature: manualSig } : {}) };
      const r = await api(`/api/inv/orders/${o.id}/items`, { method: 'POST', body });
      const stock = r.remaining === 0
        ? `⚠️ זו האחרונה! אין עוד שמלות פנויות מדגם זה במידה ${r.size} בתאריכים אלה (${r.physical} קיימות פיזית)`
        : `נותרו ${r.remaining} פנויות מדגם זה במידה ${r.size} (מתוך ${r.physical} קיימות פיזית)`;
      STOCK_FLASH = { orderId: o.id, last: r.remaining === 0, text: `📦 ${stock}` };
      toast(`שוריין: ${r.model} מידה ${r.size} (${nis(r.price)}) — ${stock}`, r.remaining === 0 ? 'err' : 'ok');
      back.remove(); orderModal(o.id);
    } catch (err) {
      // חוסר מלאי חוסם תמיד — אין חריגת חירום ממלאי בשום מקרה (דרישת הלקוחה)
      identBox().innerHTML = '';
      m.querySelector('#om-err').textContent = err.message;
    }
  }

  // שלב 1 — הכנה: כל סריקה משדכת שמלה פיזית לשריון ומכניסה לשקית
  const deliverScan = async (barcode, manualSig = null) => {
    if (!barcode) return;
    try {
      const body = { barcode, ...(manualSig ? { manual: true, signature: manualSig } : {}) };
      const r = await api(`/api/inv/orders/${o.id}/prepare-scan`, { method: 'POST', body });
      toast(r.remaining > 0 ? `הוכנה ${r.model} — נותרו ${r.remaining} להכנה` : `הוכנה ${r.model} — כל השמלות בשקיות! מוכנה לאיסוף 🎒`, 'ok');
      back.remove(); orderModal(o.id);
    } catch (err) { m.querySelector('#om-err').textContent = err.message; }
  };
  m.querySelector('#om-deliver-btn')?.addEventListener('click', () => deliverScan(m.querySelector('#om-deliver-scan').value.trim()));
  m.querySelector('#om-deliver-scan')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') deliverScan(m.querySelector('#om-deliver-scan').value.trim()); });
  m.querySelector('#om-deliver-manual')?.addEventListener('click', () => manualBarcodeModal('הכנה', o.id, (bc) => deliverScan(bc)));
  // שלב 2 — נלקח בפועל
  m.querySelector('#om-handover-btn')?.addEventListener('click', async () => {
    try {
      await api(`/api/inv/orders/${o.id}/handover`, { method: 'POST', body: { note: m.querySelector('#om-handover-note').value.trim() } });
      toast('ההזמנה סומנה כנלקחה 📤', 'ok');
      back.remove(); orderModal(o.id);
    } catch (err) { m.querySelector('#om-err').textContent = err.message; }
  });

  m.querySelector('#om-tx-add').addEventListener('click', async () => {
    const amount = +m.querySelector('#om-tx-amount').value;
    const txMethod = m.querySelector('#om-tx-method').value;
    if (!(amount > 0)) { m.querySelector('#om-err').textContent = 'הזיני סכום'; return; }
    if (!txMethod) { m.querySelector('#om-err').textContent = 'יש לבחור אמצעי תשלום'; return; }
    try {
      await api('/api/inv/transactions', { method: 'POST', body: {
        order_id: o.id, type: m.querySelector('#om-tx-type').value,
        method: txMethod, amount } });
      toast('התנועה נרשמה בקופה', 'ok');
      back.remove(); orderModal(o.id);
    } catch (err) { m.querySelector('#om-err').textContent = err.message; }
  });

  m.querySelector('#om-deliver')?.addEventListener('click', async () => {
    try {
      const r = await api(`/api/inv/orders/${o.id}/deliver`, { method: 'POST' });
      toast(`נמסרו ${r.delivered} שמלות ללקוחה`, 'ok');
      back.remove(); orderModal(o.id);
    } catch (err) { m.querySelector('#om-err').textContent = err.message; }
  });

  m.querySelector('#om-finalize')?.addEventListener('click', async () => {
    const active = o.items.filter((i) => i.oi_status !== 'בוטל');
    if (!active.length) { m.querySelector('#om-err').textContent = 'אין שמלות בטיוטה — הוסיפי לפחות שמלה אחת'; return; }
    let body = {};
    if (!(o.paid > 0)) {
      const amt = prompt('להפיכה להזמנה צריך תשלום. סכום לתשלום (₪):', active.reduce((s, i) => s + i.price, 0) || '');
      if (amt === null) return;
      body = { payment: { amount: +amt || 0, method: 'מזומן' } };
    }
    try {
      await api(`/api/inv/orders/${o.id}/finalize`, { method: 'POST', body });
      toast('הטיוטה הפכה להזמנה מאושרת', 'ok');
      back.remove(); orderModal(o.id);
    } catch (err) { m.querySelector('#om-err').textContent = err.message; }
  });

  m.querySelector('#om-cancel')?.addEventListener('click', async () => {
    if (o.status === 'טיוטה') {
      if (!confirm('למחוק את הטיוטה לצמיתות?')) return;
      try {
        await api(`/api/inv/orders/${o.id}`, { method: 'DELETE' });
        toast('הטיוטה נמחקה', 'ok');
        back.remove(); render();
      } catch (err) { m.querySelector('#om-err').textContent = err.message; }
      return;
    }
    cancelChoiceModal(o, back);
  });

  m.querySelector('#om-print').addEventListener('click', () => {
    const stNum = localStorage.getItem('gemach_station');
    const station = stNum ? 'מחשב ' + stNum : 'לא צוינה עמדה';
    let foot = m.querySelector('.print-foot');
    if (!foot) { foot = el('div', 'print-foot sub', ''); m.append(foot); }
    foot.textContent = `הודפס ע"י ${station} · ${new Date().toLocaleString('he-IL')}`;
    window.print();
  });
}

/* ---------- טופס הזמנה חדשה ---------- */
function newOrderForm(m, back) {
  back.dataset.guard = '1'; // הגנה מפני סגירה בטעות שמאבדת נתונים
  const dresses = []; // {barcode, model_code, model_name, size, price}
  const MAX = 6;

  m.innerHTML = `
    <div class="modal-head"><h3>הזמנה חדשה</h3></div>
    <div class="wiz-steps" id="wiz-dots"></div>
    <div class="wiz-title" id="wiz-title"></div>

    <!-- שלב 1: לקוחה -->
    <div class="wiz-page" data-step="1">
      <label class="fld">חיפוש לקוחה קיימת — ת"ז / טלפון / שם</label>
      <input id="no-cust-q" class="in" placeholder="הקלידי לחיפוש…">
      <div id="no-cust-results"></div>
      <div id="no-cust-selected" class="sub" style="margin-top:6px"></div>
      <details id="no-new-cust" style="margin-top:12px">
        <summary class="sub" style="cursor:pointer;font-weight:600">➕ לקוחה חדשה? מלאי פרטים כאן</summary>
        <label class="fld">שם מלא / שם משפחה</label><input id="no-name" class="in">
        <label class="fld">טלפון</label><input id="no-phone" class="in">
        <label class="fld">ת"ז</label><input id="no-tz" class="in">
        <label class="fld">מייל (לא חובה)</label><input id="no-email" class="in">
      </details>
    </div>

    <!-- שלב 2: תאריכים ומשלוח -->
    <div class="wiz-page hidden" data-step="2">
      <label class="fld">תאריך האירוע</label><input id="no-event" class="in" type="date">
      <label class="fld">איסוף (מתמלא לבד: יומיים לפני)</label><input id="no-pickup" class="in" type="date">
      <label class="fld">החזרה (מתמלא לבד: יום אחרי)</label><input id="no-return" class="in" type="date">
      <div class="row" style="margin-top:14px">
        <label class="sub" style="display:flex;align-items:center;gap:6px;font-weight:600"><input type="checkbox" id="no-dout"> 🚚 משלוח הלוך</label>
        <label class="sub" style="display:flex;align-items:center;gap:6px;font-weight:600"><input type="checkbox" id="no-dback"> ↩️ משלוח חזור</label>
      </div>
      <div id="no-addr-wrap" class="hidden"><label class="fld">כתובת למשלוח</label><input id="no-addr" class="in"></div>

      <!-- ימים נוספים בחצי מחיר (הזמנה מראש: לקחת מוקדם / להחזיר מאוחר / חו"ל) -->
      <div class="section-title" style="margin-top:18px">📅 ימים נוספים — בחצי מחיר</div>
      <div class="sub muted" style="margin-bottom:8px">
        לרוצות לקחת מוקדם יותר או להחזיר מאוחר יותר. כל יום נוסף = 50% ממחיר השמלות.
        השמלה נתפסת במלאי גם בימים האלה.
      </div>
      <div class="row">
        <div class="grow"><label class="fld" style="margin-top:0">ימים לפני האיסוף</label>
          <input id="no-days-before" class="in" type="number" min="0" max="7" step="1" value="0"></div>
        <div class="grow"><label class="fld" style="margin-top:0">ימים אחרי ההחזרה</label>
          <input id="no-days-after" class="in" type="number" min="0" max="7" step="1" value="0"></div>
      </div>
      <div id="no-days-note" class="sub" style="margin-top:6px"></div>
    </div>

    <!-- שלב 3: שמלות -->
    <div class="wiz-page hidden" data-step="3">
      <div class="section-title" style="margin-top:0">👗 שמלות בהזמנה <span id="no-count" class="sub muted" style="font-weight:500">(0 מתוך ${MAX})</span></div>
      <div class="row">
        <input id="no-barcode" class="in grow" placeholder="📷 סריקת/הקלדת ברקוד — המערכת מזהה דגם ומידה" autocomplete="off">
        <button class="btn-secondary" id="no-add-dress">זיהוי</button>
      </div>
      <div id="no-bymodel-wrap" class="hidden" style="margin-top:12px;padding-top:12px;border-top:2px dashed var(--line)">
        <div class="sub" style="font-weight:700">או — בלי ברקוד, לפי קוד דגם בלבד:</div>
        <div class="row" style="margin-top:6px">
          <input id="no-model-code" class="in grow" placeholder="לדוגמה: 533 — יוצגו רק המידות הפנויות בתאריכים שלך" autocomplete="off">
          <button class="btn-secondary" id="no-model-btn">חיפוש מידות פנויות</button>
        </div>
      </div>
      <div id="no-model-box"></div>
      <div id="no-ident"></div>
      <div id="no-dresses" style="margin-top:8px"></div>
      <div id="no-dress-err" class="err-line"></div>
    </div>

    <!-- שלב 4: תשלום וסיום -->
    <div class="wiz-page hidden" data-step="4">
      <div class="money-head"><span id="no-total-lbl">סה"כ שמלות</span><span class="big" id="no-total">₪0</span></div>
      <label class="fld">סכום לתשלום (חובה — אין הזמנה ללא תשלום)</label>
      <input id="no-pay-amount" class="in" type="number" min="0" placeholder="₪">
      <label class="fld">אמצעי תשלום (חובה לבחור)</label>
      <select id="no-pay-method" class="in">
        <option value="">— בחרי אמצעי תשלום —</option>
        <option value="מזומן">מזומן</option>
        <option value="אשראי">אשראי</option>
        <option value="שובר מתנה">שובר מתנה</option>
        <option value="פיצול">פיצול (מזומן + אשראי)</option>
      </select>
      <div id="no-split" class="row hidden" style="margin-top:8px">
        <div class="grow"><label class="fld" style="margin-top:0">מזומן ₪</label><input id="no-split-cash" class="in" type="number" min="0" placeholder="₪"></div>
        <div class="grow"><label class="fld" style="margin-top:0">אשראי ₪</label><input id="no-split-credit" class="in" type="number" min="0" placeholder="₪"></div>
      </div>
      <label class="fld">הערות (לא חובה)</label><textarea id="no-notes" class="in"></textarea>
      <div class="form-actions">
        <button class="btn-primary btn-block" id="no-save">✓ יצירת ההזמנה</button>
      </div>
      <button class="btn-secondary btn-block" id="no-draft" style="margin-top:8px">📝 שמירה כטיוטה (בלי תשלום)</button>
    </div>

    <div class="wiz-actions no-print">
      <button class="btn-ghost" id="no-cancel">ביטול</button>
      <div style="display:flex;gap:10px">
        <button class="btn-secondary" id="wiz-prev">→ חזרה</button>
        <button class="btn-primary" id="wiz-next">המשך ←</button>
      </div>
    </div>
    <div id="no-err" class="err-line"></div>`;

  // ---------- ניווט האשף ----------
  const WIZ_TITLES = [null, 'שלב 1: מי הלקוחה?', 'שלב 2: מתי האירוע?', 'שלב 3: אילו שמלות?', 'שלב 4: תשלום וסיום'];
  let wizStep = 1;
  const drawWiz = () => {
    const d = m.querySelector('#wiz-dots');
    d.innerHTML = '';
    for (let i = 1; i <= 4; i++) {
      if (i > 1) d.append(el('span', 'wiz-line'));
      d.append(el('span', 'wiz-dot' + (i === wizStep ? ' active' : i < wizStep ? ' done' : ''), i < wizStep ? '✓' : String(i)));
    }
    m.querySelector('#wiz-title').textContent = WIZ_TITLES[wizStep];
  };
  const showStep = (s) => {
    wizStep = Math.max(1, Math.min(4, s));
    m.querySelectorAll('.wiz-page').forEach((p) => p.classList.toggle('hidden', +p.dataset.step !== wizStep));
    m.querySelector('#wiz-prev').style.visibility = wizStep === 1 ? 'hidden' : 'visible';
    m.querySelector('#wiz-next').classList.toggle('hidden', wizStep === 4);
    drawWiz();
    const focusSel = { 1: '#no-cust-q', 2: '#no-event', 3: '#no-barcode', 4: '#no-pay-amount' }[wizStep];
    setTimeout(() => m.querySelector(focusSel)?.focus(), 50);
  };
  m.querySelector('#wiz-next').addEventListener('click', () => {
    const errEl = m.querySelector('#no-err');
    errEl.textContent = '';
    if (wizStep === 1) {
      const hasNew = m.querySelector('#no-name').value.trim() &&
        (m.querySelector('#no-tz').value.trim() || m.querySelector('#no-phone').value.trim());
      if (!selectedCustomer && !hasNew) { errEl.textContent = 'בחרי לקוחה קיימת, או מלאי שם + טלפון/ת"ז ללקוחה חדשה'; return; }
    }
    if (wizStep === 2 && !m.querySelector('#no-event').value) { errEl.textContent = 'חסר תאריך אירוע'; return; }
    showStep(wizStep + 1);
  });
  m.querySelector('#wiz-prev').addEventListener('click', () => { m.querySelector('#no-err').textContent = ''; showStep(wizStep - 1); });

  // מחירי משלוח מהגדרות המנהלת — נטענים ברקע
  let delPrices = { out: 0, back: 0 };
  api('/api/inv/delivery-prices').then((p) => { delPrices = p; renderDresses(); }).catch(() => {});
  const deliveryCost = () =>
    (m.querySelector('#no-dout')?.checked ? delPrices.out : 0) + (m.querySelector('#no-dback')?.checked ? delPrices.back : 0);
  // ימים נוספים: כל יום = 50% ממחיר השמלות
  const clampDays = (sel) => Math.min(7, Math.max(0, Math.floor(+m.querySelector(sel)?.value || 0)));
  const extraDays = () => clampDays('#no-days-before') + clampDays('#no-days-after');
  const dressesCost = () => dresses.reduce((s, d) => s + d.price, 0);
  const extraDaysCost = () => Math.round(extraDays() * 0.5 * dressesCost() * 100) / 100;
  const total = () => dressesCost() + extraDaysCost() + deliveryCost();
  const renderDresses = () => {
    const wrap = m.querySelector('#no-dresses');
    wrap.innerHTML = '';
    dresses.forEach((d, i) => {
      const line = el('div', 'item-line');
      // ההצגה הראשית: דגם + מידה (עליהם השריון). הברקוד משני וקטן.
      line.innerHTML = `👗 <b style="font-size:1.05rem">דגם ${esc(d.model_code)} · מידה ${esc(d.size || '?')}</b>
        · ${esc(d.model_name)} · ${nis(d.price)}
        <span class="sub muted" style="font-size:.82rem">${d.byModel ? '⌨️ לפי דגם — בלי ברקוד' : 'ברקוד ' + esc(d.barcode)}</span>
        <button class="btn-danger btn-sm no-print" data-rm="${i}" style="margin-inline-start:auto">הסרה</button>`;
      wrap.append(line);
    });
    m.querySelector('#no-count').textContent = `(${dresses.length} מתוך ${MAX})`;
    const dc = deliveryCost(), ec = extraDaysCost(), nd = extraDays();
    m.querySelector('#no-total').textContent = nis(total());
    const lbl = m.querySelector('#no-total-lbl');
    if (lbl) {
      const parts = [`שמלות ${nis(dressesCost())}`];
      if (ec > 0) parts.push(`${nd} ימים נוספים ${nis(ec)}`);
      if (dc > 0) parts.push(`משלוח ${nis(dc)}`);
      lbl.textContent = parts.length > 1 ? `סה"כ (${parts.join(' + ')})` : 'סה"כ שמלות';
    }
    // הסבר ליד שדות הימים הנוספים
    const note = m.querySelector('#no-days-note');
    if (note) note.innerHTML = nd > 0
      ? `<b style="color:var(--ok)">✓ ${nd} ימים נוספים × 50% = ${nis(ec)}</b> · השמלות ייתפסו גם בימים אלה`
      : '';
    const amt = m.querySelector('#no-pay-amount');
    if (!amt.dataset.touched) amt.value = total() || '';
    m.querySelector('#no-add-dress').disabled = dresses.length >= MAX;
    m.querySelector('#no-barcode').disabled = dresses.length >= MAX;
    const mb = m.querySelector('#no-model-btn'), mc = m.querySelector('#no-model-code');
    if (mb) mb.disabled = dresses.length >= MAX;
    if (mc) mc.disabled = dresses.length >= MAX;
  };
  m.querySelector('#no-dresses').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rm]');
    if (!b) return;
    dresses.splice(+b.dataset.rm, 1);
    renderDresses();
  });

  // מלאי פיזי של דגם+מידה — כדי שהעובדת תראה כמה יש לפני האישור
  const sameSize = (a, b) => {
    const n = (x) => { const p = parseInt(String(x ?? '').trim(), 10); return isNaN(p) ? String(x ?? '').trim() : String(p); };
    return n(a) === n(b);
  };
  const stockLine = async (info) => {
    if (!info.model_id) return '';
    try {
      const items = await api(`/api/inv/models/${info.model_id}/items`);
      const inSize = items.filter((x) => sameSize(x.size, info.size));
      const free = inSize.filter((x) => x.status === 'זמין').length;
      if (!inSize.length) return '<div class="err-line" style="font-weight:700">📦 אין שמלות מדגם זה במידה זו במלאי הפיזי!</div>';
      return `<div class="sub" style="font-weight:700;color:${free ? 'var(--ok)' : 'var(--danger)'}">
        📦 במלאי הפיזי: ${inSize.length} שמלות מדגם זה במידה ${esc(info.size)} · מהן ${free} במצב "זמין" כרגע
        <span class="muted" style="font-weight:400">(הזמינות המדויקת לתאריכי ההזמנה נבדקת בשמירה)</span></div>`;
    } catch { return ''; }
  };

  // זיהוי הברקוד → הצגת דגם+מידה לאישור → רק אחר כך הוספה לרשימה
  const identifyDress = async () => {
    const errEl = m.querySelector('#no-dress-err');
    const box = m.querySelector('#no-ident');
    errEl.textContent = '';
    box.innerHTML = '';
    const barcode = m.querySelector('#no-barcode').value.trim();
    if (!barcode) return;
    if (dresses.length >= MAX) { errEl.textContent = `ניתן להוסיף עד ${MAX} שמלות`; return; }
    if (dresses.some((d) => d.barcode === barcode)) { errEl.textContent = 'השמלה כבר נוספה להזמנה'; return; }
    let info;
    try { info = await identifyBarcode(barcode); }
    catch (err) { errEl.textContent = err.message + ` (${barcode})`; return; }
    if (!info) { errEl.textContent = `הברקוד ${barcode} אינו מזוהה — לא נמצא דגם מתאים`; return; }
    if (['לא תקין', 'נגרע'].includes(info.status)) { errEl.textContent = `השמלה במצב "${info.status}" — לא ניתן לשריין`; return; }
    box.innerHTML = identCardHTML(info, 'no-ident-ok', 'no-ident-cancel', await stockLine(info));
    box.querySelector('#no-ident-cancel').addEventListener('click', () => {
      box.innerHTML = ''; m.querySelector('#no-barcode').focus();
    });
    box.querySelector('#no-ident-ok').addEventListener('click', () => {
      dresses.push({ barcode: info.barcode, model_code: info.model_code, model_name: info.model_name,
        size: info.size, price: info.price });
      box.innerHTML = '';
      m.querySelector('#no-barcode').value = '';
      renderDresses();
      m.querySelector('#no-barcode').focus();
    });
    box.querySelector('#no-ident-ok').focus();
  };
  m.querySelector('#no-add-dress').addEventListener('click', identifyDress);
  m.querySelector('#no-barcode').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); identifyDress(); } });

  /* ---------- הזמנה לפי דגם בלבד, בלי ברקוד ----------
     מוצגת רק אם המנהלת אישרה. מחפשת מול השרת אילו מידות פנויות בפועל בתאריכי ההזמנה. */
  api('/api/inv/flags')
    .then((f) => { if (f.manual_model_order) m.querySelector('#no-bymodel-wrap').classList.remove('hidden'); })
    .catch(() => {});

  const searchByModel = async () => {
    const box = m.querySelector('#no-model-box');
    const errEl = m.querySelector('#no-dress-err');
    errEl.textContent = ''; box.innerHTML = '';
    const code = m.querySelector('#no-model-code').value.trim();
    if (!code) return;
    if (dresses.length >= MAX) { errEl.textContent = `ניתן להוסיף עד ${MAX} שמלות`; return; }
    const ev = m.querySelector('#no-event').value;
    if (!ev) { errEl.textContent = 'קודם מלאי תאריך אירוע (שלב 2) — הזמינות נבדקת לפי התאריכים'; return; }
    const qs = new URLSearchParams({
      model_code: code, event_date: ev,
      pickup_date: m.querySelector('#no-pickup').value || '',
      return_date: m.querySelector('#no-return').value || '',
      extra_before: m.querySelector('#no-days-before')?.value || '0',
      extra_after: m.querySelector('#no-days-after')?.value || '0',
    });
    let d;
    try { d = await api('/api/inv/model-availability?' + qs); }
    catch (err) { errEl.textContent = err.message; return; }

    if (!d.free.length) {
      box.innerHTML = `<div class="card" style="margin-top:10px;border-inline-start:5px solid var(--danger);padding:12px">
        <div style="font-weight:800">😕 דגם ${esc(d.model.code)} · ${esc(d.model.name)}</div>
        <div class="err-line" style="font-weight:700">אין אף מידה פנויה בתאריכים ${esc(shortDate(d.pickup_date))}–${esc(shortDate(d.return_date))}</div>
        ${d.taken.length ? `<div class="sub muted">מידות שקיימות אך תפוסות: ${d.taken.map((t) => esc(t.size)).join(', ')}</div>` : '<div class="sub muted">לדגם זה אין שמלות תקינות במלאי</div>'}
        <div class="row" style="margin-top:10px"><button class="btn-secondary" id="no-model-close">סגירה</button></div></div>`;
    } else {
      box.innerHTML = `<div class="card" style="margin-top:10px;border-inline-start:5px solid var(--ok);background:var(--ok-bg);padding:12px">
        <div style="font-weight:800;color:var(--navy-800);font-size:1.05rem">
          👗 דגם <b>${esc(d.model.code)}</b> · ${esc(d.model.name)} · ${d.model.premium ? '⭐ פרימיום ' : ''}${nis(d.model.price)}</div>
        <div class="sub">מידות פנויות לתאריכים ${esc(shortDate(d.pickup_date))}–${esc(shortDate(d.return_date))} — בחרי מידה להוספה:</div>
        <div class="row" style="margin-top:10px;flex-wrap:wrap">
          ${d.free.map((s) => `<button class="btn-primary" data-size="${esc(s.size)}" style="min-width:120px">מידה ${esc(s.size)}<br><span class="sub" style="color:#fff;opacity:.85">${s.available} פנויות</span></button>`).join('')}
        </div>
        ${d.taken.length ? `<div class="sub muted" style="margin-top:10px">תפוסות בתאריכים אלה: ${d.taken.map((t) => esc(t.size)).join(', ')}</div>` : ''}
        <div class="row" style="margin-top:10px"><button class="btn-secondary" id="no-model-close">ביטול</button></div></div>`;
    }
    lastModel = d.model;
  };
  // מאזין יחיד על התיבה (ולא חדש בכל חיפוש) — אחרת חיפוש שני היה מוסיף שמלה פעמיים,
  // ועם נתוני הדגם הישן
  let lastModel = null;
  m.querySelector('#no-model-box').addEventListener('click', (e) => {
    const box = m.querySelector('#no-model-box');
    if (e.target.closest('#no-model-close')) {
      box.innerHTML = ''; m.querySelector('#no-model-code').focus(); return;
    }
    const b = e.target.closest('[data-size]');
    if (!b || !lastModel) return;
    dresses.push({ barcode: null, byModel: true, model_code: lastModel.code, model_name: lastModel.name,
      size: b.dataset.size, price: lastModel.price });
    box.innerHTML = '';
    m.querySelector('#no-model-code').value = '';
    renderDresses();
    m.querySelector('#no-model-code').focus();
  });
  m.querySelector('#no-model-btn').addEventListener('click', searchByModel);
  m.querySelector('#no-model-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); searchByModel(); } });
  m.querySelector('#no-pay-amount').addEventListener('input', (e) => { e.target.dataset.touched = '1'; });
  // הצגת שדות פיצול כשבוחרים "פיצול"
  m.querySelector('#no-pay-method').addEventListener('change', (e) => {
    m.querySelector('#no-split').classList.toggle('hidden', e.target.value !== 'פיצול');
  });
  renderDresses();
  showStep(1);

  let selectedCustomer = null;
  const q = m.querySelector('#no-cust-q');
  let timer;
  q.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!q.value.trim()) { m.querySelector('#no-cust-results').innerHTML = ''; return; }
      const results = await api('/api/inv/customers?q=' + encodeURIComponent(q.value.trim()));
      const div = m.querySelector('#no-cust-results');
      div.innerHTML = '';
      results.forEach((c) => {
        const r = el('div', 'sub', `👤 ${esc(c.name)} · ${esc(c.tz || '')} · ${esc(c.phone || '')}`);
        r.style.cssText = 'cursor:pointer;padding:7px 10px;border-radius:8px;border:1px solid var(--line-2);margin-top:4px';
        r.addEventListener('mouseenter', () => r.style.background = 'var(--blue-100)');
        r.addEventListener('mouseleave', () => r.style.background = '');
        r.addEventListener('click', () => {
          selectedCustomer = c;
          m.querySelector('#no-cust-selected').innerHTML = `✅ נבחרה: <b>${esc(c.name)}</b>${c.notes ? `<div class="alert-note">⚠️ ${esc(c.notes)}</div>` : ''}`;
          div.innerHTML = '';
        });
        div.append(r);
      });
      if (!results.length) div.innerHTML = '<div class="sub muted" style="padding:6px">לא נמצאה לקוחה — הוסיפי חדשה למטה</div>';
    }, 250);
  });

  const dout = m.querySelector('#no-dout'), dback = m.querySelector('#no-dback');
  const syncAddr = () => m.querySelector('#no-addr-wrap').classList.toggle('hidden', !dout.checked && !dback.checked);
  // שינוי משלוח מעדכן גם את הסכום (מחיר משלוח מתווסף)
  const onDelivery = () => { syncAddr(); renderDresses(); };
  dout.addEventListener('change', onDelivery); dback.addEventListener('change', onDelivery);
  // שינוי בימים הנוספים מעדכן מיד את הסכום ואת ההסבר
  ['#no-days-before', '#no-days-after'].forEach((sel) => {
    m.querySelector(sel)?.addEventListener('input', () => renderDresses());
  });

  m.querySelector('#no-event').addEventListener('change', (e) => {
    const ev = new Date(e.target.value);
    if (isNaN(ev)) return;
    const f = (d) => d.toISOString().slice(0, 10);
    m.querySelector('#no-pickup').value = f(new Date(ev.getTime() - 2 * 86400000));
    m.querySelector('#no-return').value = f(new Date(ev.getTime() + 1 * 86400000));
  });

  m.querySelector('#no-cancel').addEventListener('click', () => back.remove());
  m.querySelector('#no-save').addEventListener('click', () => save(false, false));
  m.querySelector('#no-draft').addEventListener('click', () => save(false, true));

  async function save(force, isDraft) {
    const errEl = m.querySelector('#no-err');
    errEl.textContent = '';
    const customer = selectedCustomer ? { id: selectedCustomer.id } : {
      name: m.querySelector('#no-name').value.trim(),
      tz: m.querySelector('#no-tz').value.trim(),
      phone: m.querySelector('#no-phone').value.trim(),
      email: m.querySelector('#no-email').value.trim(),
    };
    if (!m.querySelector('#no-event').value) { errEl.textContent = 'חסר תאריך אירוע'; return; }
    const payAmount = +m.querySelector('#no-pay-amount').value || 0;
    const method = m.querySelector('#no-pay-method').value;
    // בניית התשלום — כולל פיצול מזומן/אשראי
    let payments = null;
    if (method === 'פיצול') {
      const cash = +m.querySelector('#no-split-cash').value || 0;
      const credit = +m.querySelector('#no-split-credit').value || 0;
      payments = [{ amount: cash, method: 'מזומן' }, { amount: credit, method: 'אשראי' }].filter((p) => p.amount > 0);
      if (Math.round((cash + credit) * 100) !== Math.round(payAmount * 100)) {
        errEl.textContent = `סכום הפיצול (${cash + credit}) לא שווה לסכום התשלום (${payAmount})`; return;
      }
    }
    if (!isDraft) {
      if (!dresses.length) { errEl.textContent = 'אין הזמנה ללא שמלות — הוסיפי לפחות שמלה אחת'; return; }
      if (!(payAmount > 0)) { errEl.textContent = 'אין הזמנה ללא תשלום — הזיני סכום תשלום'; return; }
      if (!method) { errEl.textContent = 'יש לבחור אמצעי תשלום'; return; }
    }
    try {
      const r = await api('/api/inv/orders', { method: 'POST', body: {
        customer,
        event_date: m.querySelector('#no-event').value,
        pickup_date: m.querySelector('#no-pickup').value || null,
        return_date: m.querySelector('#no-return').value || null,
        delivery_out: dout.checked, delivery_back: dback.checked,
        delivery_address: m.querySelector('#no-addr').value.trim() || null,
        extra_days_before: clampDays('#no-days-before'),
        extra_days_after: clampDays('#no-days-after'),
        notes: m.querySelector('#no-notes').value.trim() || null,
        barcodes: dresses.filter((d) => !d.byModel).map((d) => d.barcode),
        items: dresses.filter((d) => d.byModel).map((d) => ({ model_code: d.model_code, size: d.size })),
        ...(payments ? { payments } : { payment: { amount: payAmount, method } }),
        draft: isDraft, force,
      } });
      toast(isDraft ? `נשמרה טיוטה #${r.id} (${r.items} שמלות)` : `נוצרה הזמנה #${r.id} · ${r.items} שמלות · שולם ${nis(r.paid)}`, 'ok');
      back.remove(); orderModal(r.id);
    } catch (err) {
      // עקיפה מותרת אך ורק ברישום רטרואקטיבי (תאריך אירוע שעבר, שגיאת 400).
      // חוסר מלאי (409) חוסם תמיד — אין חריגת חירום ממלאי בשום מקרה (דרישת הלקוחה).
      if (err.status === 400 && err.data?.canForce) {
        if (confirm(`⚠️ ${err.message}\n\nלאשר רישום רטרואקטיבי עם תיעוד מלא?`)) return save(true, isDraft);
        return;
      }
      errEl.textContent = err.message;
    }
  }
}

/* ===================== עמדת סריקה ===================== */
/* ---------- ביטול: הזמנה שלמה או שמלה בודדת ---------- */
function cancelChoiceModal(o, parentBack) {
  const reserved = o.items.filter((i) => i.oi_status === 'משוריין');
  const back = el('div', 'modal-back');
  const m = el('div', 'modal');
  m.style.maxWidth = '520px';
  m.innerHTML = `
    <h3>ביטול הזמנה #${o.id}</h3>
    <div class="sub">${esc(o.customer_name)} · ${reserved.length} שמלות משוריינות</div>
    <div class="form-actions" style="margin-top:16px;flex-direction:column;gap:10px">
      <button class="btn-danger btn-block" id="cc-whole">🗑️ ביטול כל ההזמנה</button>
      ${reserved.length > 1 ? '<button class="btn-secondary btn-block" id="cc-partial">👗 ביטול שמלה בודדת (השאר יישארו)</button>' : ''}
      <button class="btn-secondary btn-block" id="cc-cancel">חזרה</button>
    </div>
    <div id="cc-list" style="margin-top:12px"></div>
    <div id="cc-err" class="err-line"></div>`;
  back.append(m); stackModal(back);
  back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
  m.querySelector('#cc-cancel').addEventListener('click', () => back.remove());

  m.querySelector('#cc-whole').addEventListener('click', async () => {
    const verify = prompt('אבטחת ביטולים — הזיני ת"ז או טלפון של המזמינה:');
    if (!verify) return;
    const fee = prompt('דמי ביטול (₪, 0 אם אין):', '0');
    const refund = prompt('החזר כספי ללקוחה (₪, 0 אם אין):', '0');
    try {
      await api(`/api/inv/orders/${o.id}/cancel`, { method: 'POST', body: { verify, fee: +fee || 0, refund: +refund || 0 } });
      toast('ההזמנה בוטלה', 'ok');
      back.remove(); parentBack.remove(); render();
    } catch (err) { m.querySelector('#cc-err').textContent = err.message; }
  });

  m.querySelector('#cc-partial')?.addEventListener('click', () => {
    const list = m.querySelector('#cc-list');
    list.innerHTML = '<div class="section-title" style="margin-top:0">בחרי שמלה לביטול:</div>';
    reserved.forEach((it) => {
      const row = el('div', 'item-line', `👗 <b>${esc(it.model_code)}</b> ${esc(it.model_name)} · מידה ${esc(it.size || '?')} · ${nis(it.price)}
        <button class="btn-danger btn-sm" data-cancel-item="${it.oi_id}" style="margin-inline-start:auto">ביטול שמלה זו</button>`);
      list.append(row);
    });
    list.onclick = async (e) => {
      const b = e.target.closest('[data-cancel-item]');
      if (!b) return;
      const verify = prompt('אבטחת שינויים — הזיני ת"ז או טלפון של המזמינה:');
      if (!verify) return;
      try {
        await api(`/api/inv/orders/${o.id}/items/${b.dataset.cancelItem}?verify=${encodeURIComponent(verify)}`, { method: 'DELETE' });
        toast('השמלה בוטלה מההזמנה', 'ok');
        back.remove(); parentBack.remove(); orderModal(o.id);
      } catch (err) { m.querySelector('#cc-err').textContent = err.message; }
    };
  });
}

/* ---------- מעקב טיפול במשפחה שלא החזירה ---------- */
function followupModal(orderId, family = null, onDone = null) {
  const back = el('div', 'modal-back');
  const m = el('div', 'modal');
  m.style.maxWidth = '520px';
  m.innerHTML = `
    <h3>📞 טיפול במשפחה שלא החזירה</h3>
    <div class="sub">${family ? esc(family.customer_name || '') + (family.customer_phone ? ' · ' + esc(family.customer_phone) : '') : 'הזמנה #' + orderId}
      ${family?.models ? ' · שמלות: ' + esc(family.models) : ''}</div>
    ${family?.f_next ? `<div class="alert-note" style="margin-top:10px">📋 המשך ממשמרת קודמת (${esc(family.f_by || '')}): ${esc(family.f_next)}</div>` : ''}
    <label class="fld" style="display:flex;gap:8px;align-items:center;margin-top:12px">
      <input type="checkbox" id="fu-called" style="width:auto" ${family?.f_called ? 'checked' : ''}> התקשרתי למשפחה
    </label>
    <label class="fld">מה קרה בשיחה?</label>
    <textarea id="fu-outcome" class="in" placeholder="לדוגמה: לא ענו / אמרו שישלחו עם משלוחן / מחזירות מחר">${esc(family?.f_outcome || '')}</textarea>
    <label class="fld">המשך טיפול למשמרת הבאה</label>
    <textarea id="fu-next" class="in" placeholder="לדוגמה: להתקשר שוב מחר / לבדוק שהמשלוחן הגיע">${esc(family?.f_next || '')}</textarea>
    <div id="fu-err" class="err-line"></div>
    <div class="form-actions">
      <button class="btn-primary" id="fu-save">שמירה</button>
      <button class="btn-secondary" id="fu-close">סגירה — המשפחה החזירה ✓</button>
      <button class="btn-secondary" id="fu-cancel">ביטול</button>
    </div>`;
  // המודאל הזה נפתח לרוב מעל מודאל אחר (סיום משמרת) — לכן שכבה גבוהה יותר ופוקוס אוטומטי
  back.append(m); stackModal(back, '#fu-outcome');
  const done = () => { back.remove(); onDone && onDone(); };
  back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
  m.querySelector('#fu-cancel').addEventListener('click', () => back.remove());
  const save = async (close) => {
    try {
      await api('/api/inv/followups', { method: 'POST', body: {
        order_id: orderId,
        called: m.querySelector('#fu-called').checked,
        outcome: m.querySelector('#fu-outcome').value.trim(),
        next_action: m.querySelector('#fu-next').value.trim(),
        close,
      } });
      toast(close ? 'הטיפול נסגר' : 'הטיפול נשמר', 'ok');
      done();
    } catch (e) { m.querySelector('#fu-err').textContent = e.message; }
  };
  m.querySelector('#fu-save').addEventListener('click', () => save(false));
  m.querySelector('#fu-close').addEventListener('click', () => save(true));
}

/* ---------- סיום משמרת: סקירת משפחות שלא החזירו ---------- */
async function shiftEndReview(onFinish) {
  let families = [];
  try { families = await api('/api/inv/not-returned'); } catch { return onFinish(); }
  if (!families.length) return onFinish();

  const back = el('div', 'modal-back');
  const m = el('div', 'modal');
  m.style.maxWidth = '640px';
  const render = () => {
    m.innerHTML = `
      <h3>📋 לפני היציאה — משפחות שטרם החזירו (${families.length})</h3>
      <div class="sub">עברי על כל משפחה: האם התקשרת? מה היה? מה ההמשך? כדי שהמשמרת הבאה תדע להמשיך.</div>
      <div id="se-list" style="margin-top:14px"></div>
      <div class="form-actions">
        <button class="btn-primary" id="se-finish">סיום ויציאה</button>
      </div>`;
    const list = m.querySelector('#se-list');
    families.forEach((f) => {
      const treated = f.f_next || f.f_outcome || f.f_called;
      const row = el('div', 'item-line', `
        <b>${esc(f.customer_name)}</b> · ${esc(f.customer_phone || 'אין טלפון')} · ${esc(f.models || '')}
        <span class="sub muted">החזרה עד ${esc(shortDate(f.return_date))}</span>
        <button class="btn-${treated ? 'secondary' : 'primary'} btn-sm" data-fu="${f.order_id}" style="margin-inline-start:auto">${treated ? '✓ עודכן — עריכה' : 'רישום טיפול'}</button>`);
      list.append(row);
    });
    m.querySelector('#se-list').addEventListener('click', (e) => {
      const b = e.target.closest('[data-fu]');
      if (!b) return;
      const fam = families.find((x) => x.order_id === +b.dataset.fu);
      followupModal(+b.dataset.fu, fam, async () => {
        families = await api('/api/inv/not-returned').catch(() => families);
        render();
      });
    });
    m.querySelector('#se-finish').addEventListener('click', () => { back.remove(); onFinish(); });
  };
  render();
  back.append(m); stackModal(back);
}

async function renderStation(main) {
  main.innerHTML = `
    <div id="followups-banner"></div>
    <div class="scan-box no-print">
      <input id="scan-input" placeholder="סרקי ברקוד…" autofocus>
      <div class="scan-hint">הסריקה מציגה את השמלה מיד · Enter לאישור</div>
      <button class="btn-secondary btn-sm" id="manual-scan" style="margin-top:10px">⌨️ הסורק לא עובד? הקלדה ידנית</button>
    </div>
    <div id="scan-result"></div>
    <div class="card no-print" style="margin-top:20px">
      <div class="section-title" style="margin-top:0">🔚 סוף יום החזרות — סבב ברקודים</div>
      <div class="sub">כל שמלה שלא נסרקה עד עכשיו (ולא הוגדר לה משלוח חזור) תסומן "החזרה מאוחרת", תירשם הערה בכרטיס הלקוחה ותיפתח משימת גביה אוטומטית.</div>
      <div class="form-actions"><button class="btn-primary" id="close-round">סיום סבב ברקודים</button></div>
      <div id="round-result" class="sub" style="margin-top:10px"></div>
    </div>`;

  // באנר המשך טיפול פתוח מהמשמרת הקודמת
  try {
    const fus = await api('/api/inv/followups');
    if (fus.length) {
      const b = $('#followups-banner');
      b.className = 'card';
      b.style.cssText = 'border-inline-start:5px solid var(--warn);background:var(--warn-bg);margin-bottom:16px';
      b.innerHTML = `<div class="section-title" style="margin-top:0">📞 המשך טיפול ממשמרת קודמת (${fus.length})</div>` +
        fus.map((f) => `<div class="item-line" style="cursor:pointer" data-fu="${f.order_id}">
          <b>${esc(f.customer_name || 'לקוחה')}</b> · ${esc(f.customer_phone || '')} · <i>${esc(f.next_action)}</i>
          <span class="sub muted" style="margin-inline-start:auto">${esc(f.updated_by || '')} · ${esc((f.updated_at || '').slice(5, 16))}</span>
        </div>`).join('');
      b.addEventListener('click', (e) => {
        const row = e.target.closest('[data-fu]');
        if (row) followupModal(+row.dataset.fu);
      });
    }
  } catch { /* לא קריטי */ }
  main.querySelector('#manual-scan').addEventListener('click', () => {
    manualBarcodeModal('החזרה', null, (barcode) => showItem(barcode, true));
  });

  const input = $('#scan-input');
  input.focus();
  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const barcode = input.value.trim();
    if (!barcode) return;
    input.value = '';
    await showItem(barcode);
  });

  // wasManual: הברקוד הוקלד ידנית (וכבר נרשם מראש) — רק להצגת תווית, בלי רישום נוסף
  async function showItem(barcode, wasManual = false) {
    const box = $('#scan-result');
    try {
      const it = await api('/api/inv/scan/' + encodeURIComponent(barcode));
      const stCls = it.status === 'זמין' ? '' : (it.status === 'מושכר' ? 'busy' : 'bad');
      const co = it.current_order;
      // החזרה מאוחרת: כבר מסומן, או עבר תאריך ההחזרה
      const isLate = co && (co.oi_status === 'החזרה מאוחרת' || (co.return_date && co.return_date < CTX.today));
      box.innerHTML = '';
      const card = el('div', 'item-card' + (isLate ? ' late-flash' : ''));
      card.innerHTML = `
        <div class="item-visual">👗</div>
        <div class="item-info">
          ${isLate ? '<div class="late-banner">⏰ החזרה מאוחרת! להודיע לאחמ"שית</div>' : ''}
          <div class="item-title">${esc(it.model_code)} · ${esc(it.model_name)}</div>
          <div class="item-sub">ברקוד ${esc(it.barcode)}${it.size ? ' · מידה ' + esc(it.size) : ''} · ${esc(it.category)}
            · ${it.premium ? '⭐ פרימיום ' + nis(it.premium_price) : nis(it.price)}${wasManual ? ' · <b style="color:var(--warn)">⌨️ הוקלד ידנית</b>' : ''}</div>
          <span class="st-pill ${stCls}">${esc(it.status)}</span>
          ${it.condition_note ? `<div class="item-sub" style="color:var(--danger)">📝 ${esc(it.condition_note)}</div>` : ''}
          ${co ? `<div class="item-sub" style="margin-top:8px">📋 בהזמנה <b>#${co.id}</b> · ${esc(co.customer_name)}
            · אירוע ${esc(shortDate(co.event_date))} · החזרה עד ${esc(shortDate(co.return_date))} (${esc(co.oi_status)})</div>` : ''}
          <div class="scan-actions">
            ${co && ['נמסר', 'החזרה מאוחרת'].includes(co.oi_status) ? `
              <button class="btn-primary btn-sm" id="ret-ok">✅ החזרה תקינה</button>
              <button class="btn-danger btn-sm" id="ret-bad">⚠️ הוחזרה פגומה</button>` : ''}
            ${co ? `<button class="btn-secondary btn-sm" id="open-order">פתיחת הזמנה #${co.id}</button>` : ''}
            ${it.status === 'בכביסה' || it.status === 'בתיקון' ? `<button class="btn-primary btn-sm" id="mark-avail">✅ החזרה למלאי — זמינה להשכרה</button>` : ''}
          </div>
          <div id="scan-msg" class="sub" style="margin-top:8px"></div>
        </div>`;
      box.append(card);
      // צפצוף מיידי בסריקה: מאוחר = התראה כפולה, אחרת צפצוף רגיל
      beep(isLate ? 'alert' : 'ok');

      // ההחזרה עצמה בלי דגל ידני — אם הוקלד ידנית זה כבר נרשם מראש (מניעת רישום כפול)
      const returnBody = (extra) => ({ barcode, ...extra });
      card.querySelector('#ret-ok')?.addEventListener('click', async () => {
        const r = await api('/api/inv/return', { method: 'POST', body: returnBody({}) });
        if (r.late) {
          beep('alert');
          card.querySelector('#scan-msg').innerHTML = `⏰ <b style="color:var(--danger)">החזרה מאוחרת נרשמה!</b> נשלחה הודעה לאחמ"שית · הזמנה #${r.order_id}`;
          toast('החזרה מאוחרת — הודעה נשלחה לאחמ"שית', 'err');
        } else {
          card.querySelector('#scan-msg').innerHTML = `✅ נקלטה החזרה — הזמנה #${r.order_id}. השמלה הועברה לכביסה.`;
          toast('החזרה נקלטה', 'ok');
        }
        setTimeout(() => showItem(barcode), 1100);
      });
      card.querySelector('#ret-bad')?.addEventListener('click', async () => {
        const note = prompt('מה הבעיה? (כתם / קרע / אחר)');
        await api('/api/inv/return', { method: 'POST', body: returnBody({ damaged: true, note }) });
        card.querySelector('#scan-msg').innerHTML = `⚠️ השמלה סומנה "לא תקין", נוספה הערה בכרטיס הלקוחה ונפתחה משימת בדיקה.`;
        toast('נרשמה החזרה פגומה', 'err');
        setTimeout(() => showItem(barcode), 1400);
      });
      card.querySelector('#open-order')?.addEventListener('click', () => orderModal(co.id));
      card.querySelector('#mark-avail')?.addEventListener('click', async () => {
        await api('/api/inv/items/' + it.id, { method: 'PATCH', body: { status: 'זמין' } });
        toast('השמלה חזרה למלאי', 'ok');
        showItem(barcode);
      });
    } catch (err) {
      box.innerHTML = `<div class="empty-state" style="color:var(--danger)">❌ ${esc(err.message)} (${esc(barcode)})</div>`;
    }
    input.focus();
  }

  $('#close-round').addEventListener('click', async () => {
    if (!confirm('לסיים את סבב הברקודים? כל שמלה שלא נסרקה תסומן כהחזרה מאוחרת.')) return;
    const r = await api('/api/inv/rounds/close', { method: 'POST' });
    $('#round-result').innerHTML = r.late.length
      ? `⏰ ${r.late.length} החזרות מאוחרות: ` + r.late.map((l) => `${esc(l.customer)} (שמלה ${esc(l.barcode)}, #${l.order})`).join(' · ')
      : '✅ כל השמלות חזרו — אין החזרות מאוחרות!';
    toast(r.late.length ? `${r.late.length} החזרות מאוחרות` : 'כל השמלות חזרו', r.late.length ? 'err' : 'ok');
  });
}

/* ===================== קטלוג ===================== */
async function renderCatalog(main) {
  const models = await api('/api/inv/models');
  main.innerHTML = '';

  if (!isManager()) {
    // צפייה בלבד: בלי טופס הוספה
    main.append(el('div', 'sub muted', '👁️ תצוגת קטלוג לצפייה — עריכה דרך המנהלת'));
  }
  const form = el('div', 'card no-print' + (isManager() ? '' : ' hidden'));
  form.innerHTML = `
    <div class="section-title" style="margin-top:0">➕ הוספת דגם חדש</div>
    <div class="row">
      <input id="nm-code" class="in" placeholder="קוד דגם" style="max-width:130px">
      <input id="nm-name" class="in grow" placeholder="שם הדגם">
      <select id="nm-cat" class="in" style="max-width:110px"><option>נשים</option><option>ילדות</option></select>
      <select id="nm-season" class="in" style="max-width:120px"><option>כל השנה</option><option>קיץ</option><option>חורף</option></select>
      <input id="nm-price" class="in" type="number" placeholder="מחיר ₪" style="max-width:110px">
      <button class="btn-primary" id="nm-add">הוספה</button>
    </div>
    <div id="nm-err" class="err-line"></div>`;
  main.append(form);
  $('#nm-add').addEventListener('click', async () => {
    try {
      await api('/api/inv/models', { method: 'POST', body: {
        code: $('#nm-code').value, name: $('#nm-name').value.trim(),
        category: $('#nm-cat').value, season: $('#nm-season').value, price: $('#nm-price').value } });
      toast('הדגם נוסף לקטלוג', 'ok');
      render();
    } catch (e) { $('#nm-err').textContent = e.message; }
  });

  main.append(el('div', 'section-title', `הקטלוג (${models.length} דגמים)`));
  const grid = el('div', 'model-grid');
  for (const md of models) {
    const card = el('div', 'model-card');
    card.innerHTML = `
      <span class="premium-star ${md.premium ? 'on' : ''}" title="פרימיום — לחיצה משנה מיד">★</span>
      <div class="model-code">${esc(md.code)}</div>
      <div class="model-name">${esc(md.name)}</div>
      <div class="model-meta">${esc(md.category)} · ${esc(md.season)} · ${md.premium ? `⭐ ${nis(md.premium_price)} <s>${nis(md.price)}</s>` : nis(md.price)}</div>
      <span class="avail-pill ${md.available_count > 0 ? 'ok' : 'none'}">${md.available_count}/${md.item_count} זמינות</span>`;
    if (isManager()) {
      card.querySelector('.premium-star').addEventListener('click', async (e) => {
        e.stopPropagation();
        let pp = md.premium_price;
        if (!md.premium && !pp) pp = +prompt('תעריף פרימיום (₪):', Math.round(md.price * 1.5)) || md.price;
        await api('/api/inv/models/' + md.id, { method: 'PATCH', body: { premium: !md.premium, premium_price: pp } });
        toast(md.premium ? 'הוסר סימון פרימיום' : 'סומן כפרימיום', 'ok');
        render();
      });
    }
    card.addEventListener('click', () => modelModal(md));
    grid.append(card);
  }
  main.append(grid);
  if (!models.length) main.append(el('div', 'empty-state', 'עדיין אין דגמים בקטלוג — הוסיפי דגם ראשון למעלה'));
}

async function modelModal(md) {
  const items = await api(`/api/inv/models/${md.id}/items`);
  const { back, m } = openModal();
  m.innerHTML = `
    <div class="modal-head"><h3>${esc(md.code)} · ${esc(md.name)} ${md.premium ? '⭐' : ''}</h3></div>
    <div class="sub">${esc(md.category)} · ${esc(md.season)} · מחיר: ${md.premium ? nis(md.premium_price) + ' (פרימיום)' : nis(md.price)}</div>
    <div class="section-title">פריטים (${items.length})</div>
    <div id="mm-items">${items.map((it) => `
      <div class="item-line">🏷️ <b>${esc(it.barcode)}</b>${it.size ? ' · מידה ' + esc(it.size) : ''} ·
        ${esc(it.status)}${it.repair_count ? ` · 🔧 ${it.repair_count} תיקונים` : ''}${it.condition_note ? ' · ' + esc(it.condition_note) : ''}</div>`).join('') || '<div class="sub muted">אין פריטים</div>'}</div>
    ${isManager() ? `
    <div class="row no-print" style="margin-top:12px">
      <input id="mm-barcode" class="in grow" placeholder="ברקוד חדש">
      <input id="mm-size" class="in" placeholder="מידה" style="max-width:90px">
      <button class="btn-primary" id="mm-add">הוספת פריט</button>
    </div>
    <div class="row no-print" style="margin-top:10px">
      <input id="mm-price" class="in" type="number" value="${md.price}" title="מחיר רגיל" style="max-width:130px">
      <button class="btn-secondary" id="mm-save-price">עדכון מחיר</button>
      <button class="btn-ghost" id="mm-close" style="margin-inline-start:auto">סגירה</button>
    </div>` : `
    <div class="row no-print" style="margin-top:10px">
      <button class="btn-ghost" id="mm-close" style="margin-inline-start:auto">סגירה</button>
    </div>`}
    <div id="mm-err" class="err-line"></div>`;
  m.querySelector('#mm-close').addEventListener('click', () => { back.remove(); render(); });
  m.querySelector('#mm-add')?.addEventListener('click', async () => {
    try {
      await api('/api/inv/items', { method: 'POST', body: {
        barcode: m.querySelector('#mm-barcode').value, model_id: md.id, size: m.querySelector('#mm-size').value.trim() } });
      toast('פריט נוסף', 'ok');
      back.remove(); modelModal(md);
    } catch (e) { m.querySelector('#mm-err').textContent = e.message; }
  });
  m.querySelector('#mm-save-price')?.addEventListener('click', async () => {
    await api('/api/inv/models/' + md.id, { method: 'PATCH', body: { price: +m.querySelector('#mm-price').value } });
    const err = m.querySelector('#mm-err'); err.className = 'ok-line'; err.textContent = '✅ המחיר עודכן';
    toast('המחיר עודכן', 'ok');
  });
}

/* ===================== לקוחות ===================== */
async function renderCustomers(main) {
  main.innerHTML = `
    <div class="toolbar">
      <div class="search"><input id="cu-q" class="in" placeholder="חיפוש לקוחה לפי שם / ת&quot;ז / טלפון"></div>
      <button class="btn-secondary" id="cu-search">חיפוש</button>
    </div>
    <div id="cu-results" class="list" style="margin-top:14px"></div>`;

  const q = $('#cu-q');
  const results = $('#cu-results');
  q.focus();

  async function search() {
    const val = q.value.trim();
    if (!val) { results.innerHTML = '<div class="empty-state">הקלידי שם, ת"ז או טלפון לחיפוש לקוחה</div>'; return; }
    const list = await api('/api/inv/customers?q=' + encodeURIComponent(val));
    results.innerHTML = '';
    if (!list.length) { results.innerHTML = '<div class="empty-state">לא נמצאה לקוחה מתאימה</div>'; return; }
    list.forEach((c) => {
      const row = el('div', 'order-row');
      row.innerHTML = `
        <div class="su-avatar" style="width:42px;height:42px">${esc((c.name || '?').charAt(0))}</div>
        <div class="order-main">
          <div class="order-name">${esc(c.name)}</div>
          <div class="order-meta">ת"ז ${esc(c.tz || '—')} · טלפון ${esc(c.phone || '—')}${c.email ? ' · ' + esc(c.email) : ''}</div>
        </div>
        ${c.notes ? '<span class="badge st-נמסרה">⚠️ הערות</span>' : ''}`;
      row.addEventListener('click', () => customerModal(c.id));
      results.append(row);
    });
  }
  $('#cu-search').addEventListener('click', search);
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
  let t; q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(search, 300); });
  results.innerHTML = '<div class="empty-state">הקלידי שם, ת"ז או טלפון לחיפוש לקוחה</div>';
}

async function customerModal(id) {
  const c = await api('/api/inv/customers/' + id);
  const { back, m } = openModal();
  m.innerHTML = `
    <div class="modal-head"><h3>👤 ${esc(c.name)}</h3></div>
    <div class="sub">ת"ז ${esc(c.tz || '—')} · טלפון ${esc(c.phone || '—')}${c.email ? ' · ' + esc(c.email) : ''}</div>
    <div class="sub muted">נוספה למערכת: ${esc(shortDate(c.created_at))}</div>
    ${c.notes ? `<div class="alert-note">⚠️ הערות: ${esc(c.notes)}</div>` : ''}
    <div class="section-title">היסטוריית הזמנות (${c.orders.length})</div>
    <div id="cu-orders"></div>
    <div class="form-actions"><button class="btn-ghost" id="cu-close">סגירה</button></div>`;
  const wrap = m.querySelector('#cu-orders');
  if (!c.orders.length) wrap.append(el('div', 'sub muted', 'אין הזמנות קודמות'));
  c.orders.forEach((o) => {
    const line = el('div', 'item-line');
    line.style.cursor = 'pointer';
    line.innerHTML = `<b>#${o.id}</b> · אירוע ${esc(shortDate(o.event_date))} · <span class="badge st-${esc(o.status)}">${esc(o.status)}</span>`;
    line.addEventListener('click', () => { back.remove(); orderModal(o.id); });
    wrap.append(line);
  });
  m.querySelector('#cu-close').addEventListener('click', () => { back.remove(); render(); });
}

/* ===================== קופה ===================== */
async function renderCash(main) {
  const today = CTX.today;
  main.innerHTML = `
    <div class="toolbar no-print">
      <div><label class="fld" style="margin-top:0">מתאריך</label><input id="cash-from" class="in" type="date" value="${today}"></div>
      <div><label class="fld" style="margin-top:0">עד תאריך</label><input id="cash-to" class="in" type="date" value="${today}"></div>
      <button class="btn-primary" id="cash-load" style="align-self:flex-end">הצגה</button>
      <button class="btn-secondary" id="cash-week" style="align-self:flex-end">השבוע</button>
      <button class="btn-secondary" id="cash-month" style="align-self:flex-end">החודש</button>
    </div>
    <div id="cash-body" style="margin-top:16px"></div>`;

  async function load(from, to) {
    const d = await api(`/api/inv/cash?from=${from}&to=${to}`);
    $('#cash-body').innerHTML = `
      <div class="cash-cards">
        <div class="cash-card"><div class="amount">${nis(d.summary.cash_in)}</div><div class="lbl">💵 מזומן</div></div>
        <div class="cash-card"><div class="amount">${nis(d.summary.credit_in)}</div><div class="lbl">💳 אשראי</div></div>
        <div class="cash-card"><div class="amount">-${nis(d.summary.refunds)}</div><div class="lbl">↩️ החזרים וזיכויים</div></div>
        <div class="cash-card balance"><div class="amount">${nis(d.summary.balance)}</div><div class="lbl">יתרה בקופה</div></div>
      </div>
      <div class="section-title">תנועות (${d.list.length})</div>
      ${d.list.map((t) => `<div class="list-item"><div class="meta">${esc(t.at)} · ${esc(t.by_user || '')}${t.order_id ? ' · הזמנה #' + t.order_id : ''}${t.customer_name ? ' · ' + esc(t.customer_name) : ''}</div>
        <b>${esc(t.type)}</b> ${nis(t.amount)} (${esc(t.method)})${t.note ? ' · ' + esc(t.note) : ''}</div>`).join('') || '<div class="empty-state">אין תנועות בטווח</div>'}`;
  }
  $('#cash-load').addEventListener('click', () => load($('#cash-from').value, $('#cash-to').value));
  $('#cash-week').addEventListener('click', () => {
    const now = new Date(); const start = new Date(now); start.setDate(now.getDate() - now.getDay());
    $('#cash-from').value = start.toISOString().slice(0, 10); $('#cash-to').value = today;
    load($('#cash-from').value, today);
  });
  $('#cash-month').addEventListener('click', () => {
    $('#cash-from').value = today.slice(0, 8) + '01'; $('#cash-to').value = today;
    load($('#cash-from').value, today);
  });
  await load(today, today);
}

/* ===================== דוח ביטולים ===================== */
async function renderCancellations(main) {
  const d = await api('/api/inv/cancellations');
  main.innerHTML = '';
  const table = (title, rows) => {
    const wrap = el('div');
    wrap.append(el('div', 'section-title', `${title} (${rows.length})`));
    if (!rows.length) { wrap.append(el('div', 'empty-state', 'אין ביטולים בקטגוריה זו')); return wrap; }
    const t = el('table', 'data');
    t.innerHTML = '<tr><th>הזמנה</th><th>לקוחה</th><th>רישום</th><th>ביטול</th><th>דגמים</th><th>נגבה</th><th>הוחזר</th></tr>' +
      rows.map((r) => `<tr><td>#${r.id}</td><td>${esc(r.customer_name)}</td><td>${esc(shortDate(r.registered_at))}</td>
        <td>${esc(shortDate(r.cancelled_at))}</td><td>${esc(r.model_codes || '—')}</td>
        <td>${nis(r.charged)}</td><td>${nis(r.refunded)}</td></tr>`).join('');
    wrap.append(t);
    return wrap;
  };
  main.append(table('👩 ביטולי שמלות נשים', d.women));
  main.append(table('👧 ביטולי שמלות ילדות', d.girls));
  if (d.other.length) main.append(table('ללא שיוך', d.other));
}

/* ===================== בדיקת מלאי ===================== */
async function renderStockCheck(main) {
  const models = await api('/api/inv/models');
  const scanned = new Set();
  main.innerHTML = `
    <div class="card no-print">
      <div class="section-title" style="margin-top:0">◈ בדיקת מלאי — ספירה מול הרשום</div>
      <div class="sub">בוחרים דגם (או "כל המלאי"), סורקים את כל השמלות שנמצאות פיזית על הסטנד,
        ובסיום לוחצים "סיום וחישוב". המערכת תציג מה חסר, מה עודף ומה לא תואם.</div>
      <div class="row" style="margin-top:12px">
        <select id="sc-model" class="in grow">
          <option value="">כל המלאי</option>
          ${models.map((m) => `<option value="${m.id}">${esc(m.code)} · ${esc(m.name)} (${m.item_count} שמלות)</option>`).join('')}
        </select>
      </div>
      <div class="scan-box" style="margin-top:12px">
        <input id="sc-scan" placeholder="סרקי ברקוד של שמלה שנמצאת על הסטנד…" autofocus>
        <div class="scan-hint">כל סריקה מתווספת לרשימה · Enter לאישור</div>
      </div>
      <div class="row" style="margin-top:12px">
        <button class="btn-primary" id="sc-finish">✅ סיום וחישוב</button>
        <button class="btn-secondary" id="sc-reset">ניקוי הרשימה</button>
        <span class="sub" style="align-self:center">נסרקו: <b id="sc-count">0</b></span>
      </div>
      <div id="sc-list" class="sub" style="margin-top:10px;max-height:150px;overflow-y:auto"></div>
    </div>
    <div id="sc-result"></div>`;

  const input = $('#sc-scan');
  const refreshList = () => {
    $('#sc-count').textContent = scanned.size;
    $('#sc-list').innerHTML = [...scanned].map((b) => `<span class="badge" style="margin:2px">${esc(b)}</span>`).join('');
  };
  input.focus();
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const bc = input.value.trim();
    if (!bc) return;
    input.value = '';
    if (scanned.has(bc)) { toast('הברקוד כבר נסרק', 'err'); beep('alert'); }
    else { scanned.add(bc); beep('ok'); refreshList(); }
  });
  $('#sc-reset').addEventListener('click', () => { scanned.clear(); refreshList(); $('#sc-result').innerHTML = ''; input.focus(); });

  $('#sc-finish').addEventListener('click', async () => {
    if (!scanned.size && !confirm('לא נסרקה אף שמלה — להציג את כל מה שחסר?')) return;
    const model_id = $('#sc-model').value || null;
    const d = await api('/api/inv/stock-check', { method: 'POST', body: { model_id: model_id ? +model_id : null, scanned: [...scanned] } });
    const box = $('#sc-result');
    box.innerHTML = `
      <div class="kpi-grid" style="margin-top:18px">
        <div class="kpi"><div class="kpi-val">${d.summary.expected}</div><div class="kpi-lbl">אמורות להיות</div></div>
        <div class="kpi k-ok"><div class="kpi-val">${d.summary.found}</div><div class="kpi-lbl">נמצאו ✓</div></div>
        <div class="kpi k-danger"><div class="kpi-val">${d.summary.missing}</div><div class="kpi-lbl">חסרות!</div></div>
        <div class="kpi k-warn"><div class="kpi-val">${d.summary.extra}</div><div class="kpi-lbl">עודפות/זרות</div></div>
        <div class="kpi k-warn"><div class="kpi-val">${d.summary.conflicts}</div><div class="kpi-lbl">אי-התאמות</div></div>
      </div>`;
    const table = (title, rows, cls) => {
      if (!rows.length) return;
      box.append(el('div', 'section-title', title + ` (${rows.length})`));
      const t = el('table', 'data');
      t.innerHTML = '<tr><th>ברקוד</th><th>דגם</th><th>מידה</th><th>סטטוס במערכת</th><th>הערה</th></tr>' +
        rows.map((x) => `<tr><td><b>${esc(x.barcode)}</b></td><td>${esc(x.model_code || '—')} ${esc(x.model_name || '')}</td>
          <td>${esc(x.size || '—')}</td><td>${esc(x.status || '—')}</td><td class="${cls}">${esc(x.issue || '')}</td></tr>`).join('');
      box.append(t);
    };
    table('❌ שמלות חסרות — רשומות בגמ"ח אך לא נמצאו', d.missing, 'err-line');
    table('⚠️ אי-התאמות — נמצאו אך רשומות כמושכרות', d.wrongStatus, 'err-line');
    table('➕ שמלות זרות/עודפות שנסרקו', d.extra, 'err-line');
    if (!d.missing.length && !d.extra.length && !d.wrongStatus.length) {
      box.append(el('div', 'celebrate', '🎉 המלאי תואם במדויק! אין חוסרים ואין עודפים'));
    }
    toast(d.summary.missing ? `${d.summary.missing} שמלות חסרות!` : 'המלאי תואם', d.summary.missing ? 'err' : 'ok');
  });
}

async function renderManual(main) {
  const today = CTX.today;
  main.innerHTML = `
    <div class="row no-print" style="margin-bottom:16px">
      <div><label class="fld" style="margin-top:0">תאריך</label><input id="mbr-date" class="in" type="date" value="${today}"></div>
      <button class="btn-primary" id="mbr-load" style="align-self:flex-end">הצגה</button>
    </div>
    <div id="mbr-body"></div>`;
  const load = async (date) => {
    const d = await api('/api/inv/manual-barcodes?date=' + date);
    const body = $('#mbr-body');
    body.innerHTML = `<div class="section-title" style="margin-top:0">⌨️ ברקודים שהוקלדו ידנית — ${esc(d.date)} (${d.rows.length})</div>`;
    if (!d.rows.length) { body.append(el('div', 'empty-state', 'לא הוקלדו ברקודים ידנית ביום זה 🎉')); return; }
    const t = el('table', 'data');
    t.innerHTML = '<tr><th>שעה</th><th>ברקוד</th><th>הקשר</th><th>הזמנה</th><th>לקוחה</th><th>מי הקלידה</th><th>חתימה</th></tr>' +
      d.rows.map((r) => `<tr><td>${esc((r.at || '').slice(11, 16))}</td><td><b>${esc(r.barcode)}</b></td>
        <td>${esc(r.context)}</td><td>${r.oid ? '#' + r.oid : '—'}</td><td>${esc(r.customer_name || '—')}</td>
        <td>${esc(r.user_name)}</td><td class="sub">${esc(r.signature)}</td></tr>`).join('');
    body.append(t);
  };
  $('#mbr-load').addEventListener('click', () => load($('#mbr-date').value));
  await load(today);
}

/* ===================== אתחול ===================== */
initLogin();          // מחברים תמיד את מנגנון הכניסה — כדי שאחרי יציאה אפשר להיכנס שוב
if (USER) startApp();
