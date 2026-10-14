/* ===================================================================
   גמ"ח שמלות · מערכת משימות — לוגיקת צד לקוח
   =================================================================== */
let USER = JSON.parse(localStorage.getItem('gemach_user') || 'null');
let CTX = null;
let TAB = null;
let SCOPE_FILTER = 'הכל';
/* שיוך ברירת המחדל. "כללי" בוטל ומוזג לתוך "תחילת משמרת" (מיגרציה ב-server/db.js),
   כי "כללי" לא אמר כלום על מתי מבצעים את המשימה. המבנה: תחילת משמרת / סוף משמרת / אישי. */
const DEFAULT_SCOPE = 'תחילת משמרת';
const SCOPE_ORDER = ['תחילת משמרת', 'סוף משמרת', 'מוקדנית בוקר', 'מנהלת'];
// תצוגת לוח המשימות: 'list' (כרטיסים) או 'table' (שורות קצרות ורחבות)
const VIEW_LS = 'gemach_tasks_view';
let VIEW_MODE = localStorage.getItem(VIEW_LS) === 'table' ? 'table' : 'list';
// שיוך משימה → אימוג'י ותווית קצרה לתגית
const SCOPE_META = {
  'מנהלת':         { icon: '🔒', label: 'מנהלת' },
  'מוקדנית בוקר':  { icon: '🌅', label: 'מוקדנית בוקר' },
  'תחילת משמרת':   { icon: '▶️', label: 'תחילת משמרת' },
  'סוף משמרת':     { icon: '⏹️', label: 'סוף משמרת' },
};
// אפשרויות בורר השיוך — מקור אחד לכל הטפסים
function scopeOptions(selected = DEFAULT_SCOPE) {
  return SCOPE_ORDER.map((k) => {
    const m = SCOPE_META[k];
    return `<option value="${k}" ${k === selected ? 'selected' : ''}>${m.icon} ${m.label}</option>`;
  }).join('');
}
let CAL = null;
let CAL_SELECTED = null;
/* קטגוריות מכווצות. ברירת המחדל היא סגור — הלוח נפתח כטבלת כותרות קצרה,
   והרשימה של כל קטגוריה נפתחת בלחיצה. המצב נשמר בין כניסות. */
const COLLAPSED_LS = 'gemach_collapsed_cats';
const COLLAPSED = new Set(JSON.parse(localStorage.getItem(COLLAPSED_LS) || 'null') || []);
let COLLAPSED_LOADED = COLLAPSED.size > 0 || localStorage.getItem(COLLAPSED_LS) !== null;
const saveCollapsed = () => localStorage.setItem(COLLAPSED_LS, JSON.stringify([...COLLAPSED]));
// קטגוריה שצריך לפתוח בכניסה למסך (מגיעים אליה בלחיצה מלוח הבקרה)
let OPEN_CAT = null;

// מוני "חדש/לא טופל" שמוצגים בסוגריים על פריטי התפריט. אפס = לא מוצג כלום.
let COUNTERS = { problems: 0, messages: 0, handover: 0 };
const COUNTER_TABS = { problems: 'problems', handover: 'handover', messages: 'messages' };
let ANNOUNCE_TIMER = null;
let ATTENDANCE_LIVE_TIMER = null;
let ATTENDANCE_MONTH = null;
// תצוגת מסך העברת המשמרת: הערות פעילות בלבד או גם היסטוריה
let HO_SHOW_HISTORY = false;
// הערות פעילות מימים קודמים — מכווצות כברירת מחדל, כדי שמה שנכתב היום יבלוט
let HO_SHOW_OLDER = false;
// מקרא "מי רואה מה" — סגור כברירת מחדל
let SHOW_SCOPE_HELP = false;

// תדירויות המערכת + התווית העברית שלהן (מסך התבניות)
const FREQ_ORDER = ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly'];
const FREQ_HE = { daily: 'יומי', weekly: 'שבועי', biweekly: 'דו־שבועי', monthly: 'חודשי', quarterly: 'רבעוני' };
// מצב החיפוש/הסינון של מסך התבניות — נשמר בין ציורים כדי לא לאבד את מה שהוקלד
let TPL_SEARCH = '';
let TPL_FREQ = 'all';
// תבניות שסומנו לשיוך מרוכז (מזהים)
const TPL_SELECTED = new Set();
// סינון לפי מצב שיוך אחראית: all / none (ללא אחראית) / some (יש אחראית)
let TPL_OWNER = 'all';

const PRIORITIES = ['רגיל', 'דחוף', 'חשוב', 'להמשך'];
const PR_META = {
  'רגיל':  { color: '#8a96a8', label: 'רגיל' },
  'דחוף':  { color: '#c1362f', label: 'דחוף' },
  'חשוב':  { color: '#b7791f', label: 'חשוב' },
  'להמשך': { color: '#2f79cf', label: 'להמשך' },
};
const CAT_EMOJI = {
  'ניהול צוות ועובדות': '👥', 'ניהול מתנדבות': '🤝', 'ניהול מלאי': '👗',
  'בקרת איכות התפירה': '🧵', 'בקרת איכות השמלות': '✨', 'שרות לקוחות': '📞',
  'משוב': '💬', 'תיעוד ורישום': '📝', 'כספים': '💰', 'מכירות': '📈',
  'שווק': '📣', 'תחזוקה': '🔧', 'נקיון': '🧹', 'בקרה': '👁️',
};
const catIcon = (c) => CAT_EMOJI[c] || '📋';

// תפריט הניווט — מוצג רק לפי הרשאות המשתמשת
const NAV = {
  dashboard: { icon: '▤', label: 'לוח מנהלת', title: 'לוח מנהלת' },
  today:     { icon: '☀', label: 'היום', title: 'משימות היום' },
  week:      { icon: '▦', label: 'השבוע', title: 'משימות השבוע' },
  periodic:  { icon: '▣', label: 'תקופתי', title: 'משימות תקופתיות' },
  calendar:  { icon: '▧', label: 'לוח שנה', title: 'לוח שנה' },
  problems:  { icon: '⚠', label: 'לוח בעיות', title: 'לוח בעיות' },
  handover:  { icon: '⇄', label: 'משמרת', title: 'העברת משמרת' },
  messages:  { icon: '✉', label: 'הודעות', title: 'הודעות' },
  attendance: { icon: '⏱', label: 'שעות נוכחות', title: 'שעות נוכחות' },
  inventory: { icon: '◨', label: 'מלאי והשכרה', title: '', link: '/inventory.html' },
  campaign:  { icon: '🎗', label: 'קמפיין מכירה סינית', title: '', link: '/campaign.html' },
  ai:        { icon: '✦', label: 'עוזרת AI', title: 'עוזרת AI' },
  integrations: { icon: '⇆', label: 'חיבורים', title: 'חיבורים: מייל · ימות המשיח · AI · גיבוי' },
  admin:     { icon: '⚙', label: 'ניהול והרשאות', title: 'ניהול והרשאות' },
};
const NAV_ORDER = ['dashboard', 'today', 'week', 'periodic', 'calendar', 'problems', 'handover', 'messages', 'attendance', 'inventory', 'campaign', 'ai', 'integrations', 'admin'];
// פריטים שאינם לשימוש יומיומי — נאספים לקבוצה מתקפלת אחת בתחתית התפריט
const ADMIN_NAV = ['integrations', 'admin'];
const NAV_GROUP = { icon: '⚙️', label: 'ניהול' };
const NAV_GROUP_LS = 'gemach_nav_admin_open';

/* ---------- דרגות ----------
   סדר היררכי אחד ויחיד. שינוי שם של דרגה נעשה כאן בלבד.
   שמות התפקיד עצמם מוצגים תמיד לפי מה שמגיע מהשרת. */
const ROLE_ORDER = ['יוטי', 'מנהלת', 'מוקדנית', 'מתנדבת'];
const TOP_ROLE = ROLE_ORDER[0];
// שמות היסטוריים של הדרגה העליונה — כדי שמסד נתונים ישן ימשיך לעבוד
const TOP_ROLE_ALIASES = [TOP_ROLE, 'העובי', 'מנהלת ראשית', 'אהובי'];
const isTopRole = (r) => TOP_ROLE_ALIASES.includes(String(r ?? '').trim());
// דרגות ניהוליות: העליונה + מנהלת
const isManagerRole = (r) => isTopRole(r) || String(r ?? '').trim() === 'מנהלת';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

/* ---------- גודל תצוגה (זום) ---------- */
const ZOOM = { min: 1, max: 3.5, step: 0.25, def: 2 };
function getZoom() { return parseFloat(localStorage.getItem('gemach_zoom')) || ZOOM.def; }
function applyZoom(z) {
  z = Math.min(ZOOM.max, Math.max(ZOOM.min, Math.round(z * 100) / 100));
  document.body.style.zoom = z;
  localStorage.setItem('gemach_zoom', z);
  const lbl = document.querySelector('#zoom-val');
  if (lbl) lbl.textContent = Math.round(z * 100) + '%';
}
function mountZoomControl() {
  const tools = document.querySelector('.tb-tools');
  if (!tools || document.querySelector('#zoom-ctl')) return;
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
applyZoom(getZoom()); // חל גם על מסך הכניסה
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function toast(msg, kind = '') {
  const t = el('div', 'toast ' + kind, `<span>${kind === 'ok' ? '✓' : kind === 'err' ? '✕' : 'ℹ'}</span><span>${esc(msg)}</span>`);
  $('#toast-host').append(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, 3200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(USER ? { 'x-user-id': USER.id } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(data.error || 'שגיאה'); err.status = res.status; throw err; }
  return data;
}

/* ===================== כניסה ===================== */
// תאריך לועזי בפורמט DD.MM.YYYY מתוך CTX.today (YYYY-MM-DD)
function gregDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

async function boot() {
  try { CTX = await api('/api/context'); } catch { /* לא קריטי */ }
  $('#login-hebdate').textContent = CTX ? `${gregDate(CTX.today)} · ${CTX.hdate} · פרשת ${CTX.parsha}` : '';
  if (USER) startApp(); else showLogin();
}

function showLogin() {
  $('#login-screen').classList.remove('hidden');
  $('#app').classList.add('hidden');
  $('#login-code').focus();
}

async function doLogin() {
  $('#login-error').textContent = '';
  const code = $('#login-code').value.trim();
  if (!code) return;
  try {
    const user = await api('/api/login', { method: 'POST', body: { code } });
    USER = user;
    localStorage.setItem('gemach_user', JSON.stringify(user));
    localStorage.removeItem(NAV_GROUP_LS); // כניסה חדשה — קבוצת הניהול תמיד סגורה
    startApp();
  } catch (e) { $('#login-error').textContent = e.message; }
}

async function startApp() {
  $('#login-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  if (!CTX) { try { CTX = await api('/api/context'); } catch { return logout(); } }

  // רענון הרשאות (הן עלולות להשתנות מאז הכניסה)
  try {
    const me = await api('/api/permissions/me');
    USER.features = me.features; USER.role = me.role;
    localStorage.setItem('gemach_user', JSON.stringify(USER));
  } catch (e) { if (e.status === 401) return logout(); }

  $('#user-name').textContent = USER.name;
  $('#user-role').textContent = USER.role;
  $('#su-avatar').textContent = (USER.name || '?').trim().charAt(0);
  $('#heb-context').textContent = `${gregDate(CTX.today)} · ${CTX.hdate} · פרשת ${CTX.parsha}`;

  buildNav();
  mountZoomControl();
  refreshAnnouncements();
  if (!ANNOUNCE_TIMER) ANNOUNCE_TIMER = setInterval(refreshAnnouncements, 30000);
  $('#logout-btn').onclick = () => {
    if (!confirm('לסיים משמרת ולצאת?')) return;
    document.querySelectorAll('.modal-back').forEach((b) => b.remove());
    // היציאה מיידית — רישום הנוכחות בשרת נעשה ברקע, בלי לחכות
    api('/api/logout', { method: 'POST' }).catch(() => {});
    logout();
  };
  render();
}

function buildNav() {
  const nav = $('#side-nav');
  nav.innerHTML = '';
  const allowed = NAV_ORDER.filter((k) => (USER.features || []).includes(k));
  if (!TAB || !allowed.includes(TAB) || TAB === 'inventory' || TAB === 'campaign')
    TAB = allowed.find((k) => k !== 'inventory' && k !== 'campaign') || allowed[0];

  const makeItem = (key) => {
    const meta = NAV[key];
    const counted = Object.prototype.hasOwnProperty.call(COUNTER_TABS, key);
    const b = el('button', 'nav-item' + (key === TAB ? ' active' : ''),
      `<span class="ni-ic">${meta.icon}</span> <span class="ni-label">${meta.label}</span>` +
      (counted ? '<span class="ni-count" data-count-for="' + key + '"></span>' : ''));
    b.dataset.tab = key;
    if (meta.link) { b.dataset.link = meta.link; b.title = 'מעבר למערכת המלאי'; }
    b.addEventListener('click', () => {
      if (meta.link) { location.href = meta.link; return; }
      TAB = key;
      $$('.nav-item').forEach((n) => n.classList.toggle('active', n === b));
      $('#page-title').textContent = NAV[key].title;
      render();
    });
    return b;
  };

  // פריטים יומיומיים — גלויים תמיד
  allowed.filter((k) => !ADMIN_NAV.includes(k)).forEach((k) => nav.append(makeItem(k)));

  // פריטי ניהול — מקובצים ומוסתרים כברירת מחדל. מוצגים רק למי שיש לה הרשאה אליהם
  const adminItems = allowed.filter((k) => ADMIN_NAV.includes(k));
  if (adminItems.length) {
    // פתוח רק אם המשתמשת פתחה בעצמה במהלך ההתחברות הזו, או שהלשונית הפעילה בפנים
    const open = localStorage.getItem(NAV_GROUP_LS) === '1' || adminItems.includes(TAB);
    const grp = el('div', 'nav-group' + (open ? ' open' : ''));
    const tg = el('button', 'nav-item nav-group-toggle',
      `<span class="ni-ic">${NAV_GROUP.icon}</span> ${NAV_GROUP.label}<span class="ng-caret">▾</span>`);
    tg.setAttribute('aria-expanded', open ? 'true' : 'false');
    tg.title = 'הגדרות ניהול — לא לשימוש יומיומי';
    const body = el('div', 'nav-group-body');
    adminItems.forEach((k) => body.append(makeItem(k)));
    tg.addEventListener('click', () => {
      const now = !grp.classList.contains('open');
      grp.classList.toggle('open', now);
      tg.setAttribute('aria-expanded', now ? 'true' : 'false');
      localStorage.setItem(NAV_GROUP_LS, now ? '1' : '0');
    });
    grp.append(tg, body);
    nav.append(grp);
  }
  $('#page-title').textContent = NAV[TAB]?.title || '';
  paintCounters(); // התפריט נבנה מחדש — מציירים מיד את הערכים המוכרים
}

/* ---------- מוני התפריט ----------
   מוצגים בסוגריים ליד שם הלשונית. אפס — לא מוצג כלום (דרישה מפורשת). */
function paintCounters() {
  for (const key of Object.keys(COUNTER_TABS)) {
    const span = document.querySelector(`.ni-count[data-count-for="${key}"]`);
    if (!span) continue;
    const n = Number(COUNTERS[key]) || 0;
    span.textContent = n > 0 ? ` (${n})` : '';
  }
  const t = NAV[TAB];
  if (t) {
    const n = Number(COUNTERS[TAB]) || 0;
    $('#page-title').textContent = t.title + (COUNTER_TABS[TAB] && n > 0 ? ` (${n})` : '');
  }
}

async function refreshAnnouncements() {
  if (!USER) return;
  const box = $('#announce-banner');
  if (!box) return;
  let rows = [];
  try { rows = await api('/api/messages/banner'); } catch { return; }
  box.innerHTML = '';
  rows.forEach((m) => {
    const item = el('div', 'announce-item');
    const top = el('div', 'an-top');
    top.innerHTML = `<div class="an-body"><span class="an-meta">📣 ${esc(m.from_user)}:</span>${esc(m.body)}</div>`;
    const replyBtn = el('button', 'an-reply-btn', '↩ תגובה');
    replyBtn.title = 'שליחת תגובה חזרה';
    const close = el('button', 'an-close', '✕');
    close.title = 'סגירה';
    const dismiss = async () => {
      item.remove();
      try { await api(`/api/messages/${m.id}/dismiss`, { method: 'POST' }); } catch { /* לא קריטי */ }
    };
    close.addEventListener('click', dismiss);
    top.append(replyBtn, close);
    item.append(top);

    const replyRow = el('div', 'an-reply-row hidden');
    const replyInput = el('input', 'in');
    replyInput.placeholder = `תגובה ל${m.from_user}…`;
    const sendBtn = el('button', 'btn-primary btn-sm', 'שליחה');
    const doSend = async () => {
      const text = replyInput.value.trim();
      if (!text) return;
      try {
        await api(`/api/messages/${m.id}/reply`, { method: 'POST', body: { text } });
        toast('התגובה נשלחה', 'ok');
        dismiss();
      } catch (e) { toast(e.message || 'השליחה נכשלה', 'err'); }
    };
    sendBtn.addEventListener('click', doSend);
    replyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSend(); });
    replyRow.append(replyInput, sendBtn);
    item.append(replyRow);

    replyBtn.addEventListener('click', () => {
      replyRow.classList.toggle('hidden');
      if (!replyRow.classList.contains('hidden')) replyInput.focus();
    });
    box.append(item);
  });
}

async function refreshCounters() {
  if (!USER) return;
  try {
    const c = await api('/api/counters');
    COUNTERS = { problems: c.problems || 0, messages: c.messages || 0, handover: c.handover || 0 };
  } catch { /* מונה הוא מידע משני — לא מפילים את המסך בגללו */ }
  paintCounters();
}

function logout() {
  localStorage.removeItem('gemach_user');
  localStorage.removeItem(NAV_GROUP_LS);
  USER = null; TAB = null;
  if (ANNOUNCE_TIMER) { clearInterval(ANNOUNCE_TIMER); ANNOUNCE_TIMER = null; }
  if (ATTENDANCE_LIVE_TIMER) { clearInterval(ATTENDANCE_LIVE_TIMER); ATTENDANCE_LIVE_TIMER = null; }
  const box = $('#announce-banner'); if (box) box.innerHTML = '';
  COUNTERS = { problems: 0, messages: 0, handover: 0 };
  HO_SHOW_HISTORY = false;
  // סוגרים כל חלון צף שנשאר פתוח — אחרת הוא חוסם את מסך הכניסה
  document.querySelectorAll('.modal-back').forEach((b) => b.remove());
  $('#app').classList.add('hidden');
  showLogin();
  $('#login-code').value = '';
  $('#login-error').textContent = '';
}

/* ===================== ניתוב ===================== */
async function render() {
  const main = $('#main');
  main.innerHTML = '<p class="muted">טוען…</p>';
  try {
    if (TAB === 'dashboard') await renderDashboard(main);
    else if (TAB === 'today' || TAB === 'week' || TAB === 'periodic') await renderTasks(main, TAB);
    else if (TAB === 'calendar') await renderCalendar(main);
    else if (TAB === 'problems') await renderProblems(main);
    else if (TAB === 'handover') await renderHandover(main);
    else if (TAB === 'messages') await renderMessages(main);
    else if (TAB === 'attendance') await renderAttendance(main);
    else if (TAB === 'ai') await renderAI(main);
    else if (TAB === 'integrations') await renderIntegrations(main);
    else if (TAB === 'admin') await renderAdmin(main);
  } catch (e) {
    if (e.status === 401) return logout();
    main.innerHTML = `<div class="empty-state" style="color:var(--danger)">${esc(e.message)}</div>`;
  }
  // רענון המונים אחרי כל ציור — כניסה, מעבר לשונית וכל פעולה שמסתיימת ב-render()
  refreshCounters();
}

/* ===================== לוח מנהלת ===================== */
async function renderDashboard(main) {
  const d = await api('/api/dashboard');
  main.innerHTML = '';
  main.append(el('div', 'section-title', 'סקירת ניהול · היום'));

  // d.today.total מגיע מהשרת כשהוא *כבר* מנוכה מ"לא רלוונטי" (נספרות ב-d.today.irrelevant),
  // ולכן המכנה כאן הוא מספר המשימות הרלוונטיות בלבד. אם כולן סומנו "לא רלוונטי"
  // (total = 0 ו-irrelevant > 0) — 100%, בעקבות אותה החלטה כמו ב-progressOf().
  const skipped = d.today.irrelevant || 0;
  const pct = d.today.total ? Math.round((d.today.done / d.today.total) * 100) : (skipped ? 100 : 0);
  const kpis = el('div', 'kpi-grid');
  // כל כרטיס מוביל למסך שממנו הנתון הגיע — לחיצה על "הודעות" עוברת להודעות וכו'
  const cards = [
    { cls: '', val: `${d.today.done}/${d.today.total}`, lbl: `משימות היום (${pct}%)`,
      hint: 'הושלמו היום' + skipNote(skipped), go: 'today' },
    { cls: 'k-danger', val: d.overdue, lbl: 'משימות באיחור', hint: 'תאריך יעד עבר', go: 'today' },
    { cls: 'k-warn', val: d.openProblems, lbl: 'בעיות פתוחות', hint: `${d.problemsOverdue} מהן באיחור`, go: 'problems' },
    { cls: '', val: d.unhandledMsgs, lbl: 'הודעות שלא טופלו', hint: 'ממתינות למענה', go: 'messages' },
  ];
  cards.forEach((k) => {
    const canGo = k.go && (USER.features || []).includes(k.go);
    const c = el('div', 'kpi ' + k.cls + (canGo ? ' kpi-link' : ''),
      `<div class="kpi-val">${k.val}</div><div class="kpi-lbl">${k.lbl}</div><div class="kpi-hint">${k.hint}</div>` +
      (canGo ? `<div class="kpi-go">מעבר ל${esc(NAV[k.go].label)} ←</div>` : ''));
    if (canGo) {
      c.tabIndex = 0;
      c.title = `מעבר למסך ${NAV[k.go].label}`;
      const go = () => goToTab(k.go);
      c.addEventListener('click', go);
      c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    }
    kpis.append(c);
  });
  main.append(kpis);

  const cols = el('div', 'dash-cols');

  // מי במשמרת עכשיו
  const p1 = el('div', 'panel');
  p1.append(el('div', 'panel-head', '<span>👥 מי במשמרת עכשיו</span>'));
  const b1 = el('div', 'panel-body');
  if (!d.onShift.length) b1.append(el('div', 'empty-state', 'אף אחת לא מחוברת כרגע'));
  else d.onShift.forEach((u) => b1.append(el('div', 'mini-stat',
    `<span>${esc(u.name)} · <span class="muted">${esc(u.role)}</span></span><span class="val">${esc((u.check_in || '').slice(11, 16))}</span>`)));
  const teamPills = el('div', 'pill-row');
  teamPills.style.padding = '10px 12px';
  d.team.forEach((t) => teamPills.append(el('span', 'pill', `${esc(t.role)}: <b>${t.c}</b>`)));
  b1.append(teamPills);
  p1.append(b1);
  cols.append(p1);

  // ביצוע לפי קטגוריה היום
  const p2 = el('div', 'panel');
  const canTasks = (USER.features || []).includes('today');
  p2.append(el('div', 'panel-head' + (canTasks ? ' head-link' : ''),
    '<span>📊 ביצוע לפי קטגוריה · היום</span>' + (canTasks ? '<span class="head-go">למשימות ←</span>' : '')));
  if (canTasks) p2.querySelector('.panel-head').addEventListener('click', () => goToTab('today'));
  const b2 = el('div', 'panel-body');
  if (!d.catPerf.length) b2.append(el('div', 'empty-state', 'אין משימות להיום'));
  else d.catPerf.forEach((c) => {
    const p = c.total ? Math.round((c.done / c.total) * 100) : 0;
    const row = el('div', 'mini-stat' + (canTasks ? ' mini-link' : ''),
      `<span>${catIcon(c.category)} ${esc(c.category)}</span><span class="val">${c.done}/${c.total} · ${p}%</span>`);
    // לחיצה על קטגוריה — מעבר ללוח המשימות עם אותה קטגוריה פתוחה
    if (canTasks) row.addEventListener('click', () => { OPEN_CAT = c.category; goToTab('today'); });
    b2.append(row);
  });
  p2.append(b2);
  cols.append(p2);
  main.append(cols);

  // עריכת הרשאות גישה לפי דרגה (למנהלת)
  if ((USER.features || []).includes('admin') || isManagerRole(USER.role)) {
    await renderPermissions(main);
  }

  // יומן פעולות אחרון
  main.append(el('div', 'section-title', '🕐 פעולות אחרונות'));
  const aT = el('table', 'data');
  aT.innerHTML = '<tr><th>מי</th><th>פעולה</th><th>יעד</th><th>מתי</th></tr>' +
    d.auditTail.map((a) => `<tr><td>${esc(a.user_name || '')}</td><td>${esc(a.action)}</td><td>${esc(a.entity)}</td><td>${esc(a.at)}</td></tr>`).join('');
  main.append(aT);
}

async function renderPermissions(main) {
  const { features, roles, matrix } = await api('/api/permissions');
  main.append(el('div', 'section-title', '🔐 הרשאות גישה לפי דרגה'));
  main.append(el('div', 'sub muted', 'סמני מה כל דרגה רשאית לראות ולהשתמש. שינוי נשמר מיד ונאכף גם בשרת. לדרגה העליונה תמיד גישה מלאה.'));

  const wrap = el('div');
  wrap.style.cssText = 'overflow-x:auto;margin-top:12px';
  const t = el('table', 'perm-table');
  t.innerHTML = '<thead><tr><th>אזור \\ דרגה</th>' + roles.map((r) => `<th>${esc(r)}</th>`).join('') + '</tr></thead>';
  const tb = el('tbody');
  for (const f of features) {
    const tr = el('tr');
    tr.innerHTML = `<th>${esc(f.label)}</th>`;
    for (const role of roles) {
      const td = el('td');
      const locked = isTopRole(role);
      const on = !!matrix[role][f.key];
      const btn = el('button', 'perm-toggle' + (on ? ' on' : '') + (locked ? ' locked' : ''));
      btn.title = locked ? `לדרגה ${role} תמיד גישה מלאה` : (on ? 'לחיצה תחסום' : 'לחיצה תאפשר');
      if (!locked) btn.addEventListener('click', async () => {
        const next = !btn.classList.contains('on');
        try {
          await api('/api/permissions', { method: 'POST', body: { role, feature: f.key, allowed: next } });
          btn.classList.toggle('on', next);
          toast(`${next ? 'ניתנה' : 'נחסמה'} גישה · ${role} → ${f.label}`, 'ok');
          if (role === USER.role) { // עדכון עצמי — לרענן תפריט
            const me = await api('/api/permissions/me'); USER.features = me.features;
            localStorage.setItem('gemach_user', JSON.stringify(USER)); buildNav();
          }
        } catch (e) { toast(e.message, 'err'); }
      });
      td.append(btn);
      tr.append(td);
    }
    tb.append(tr);
  }
  t.append(tb);
  wrap.append(t);
  main.append(wrap);
}

/* ===================== רכיבי משימה ===================== */
// מילוי רשימת שמות הצוות בטופסי שיוך משימות (מנהלת בלבד)
async function fillNamesSelect(sel) {
  const box = $(sel);
  if (!box || !isManagerRole(USER.role)) return;
  try {
    (await api('/api/users/names')).forEach((n) => box.append(el('option', '', esc(n))));
  } catch { /* לא קריטי */ }
}

// רענון ששומר על מיקום הגלילה — סימון משימה לא מקפיץ לראש הדף
async function refreshKeepScroll() {
  const y = window.scrollY;
  await render();
  window.scrollTo({ top: y, behavior: 'instant' });
}

// מעבר ללשונית אחרת דרך מנגנון הניווט הקיים (בלי לטעון מחדש את הדף)
function goToTab(key) {
  if (!(USER.features || []).includes(key)) { toast('אין לך הרשאת גישה לאזור הזה', 'err'); return; }
  if (TAB === key) return;
  TAB = key;
  buildNav();
  render();
}

// משימה עם תאריך יעד עתידי — אי אפשר לבצע אותה מראש
const isFutureTask = (t) => !!(t.due_date && t.due_date > CTX.today);
const futureReason = (t) => {
  const [, mm, dd] = String(t.due_date).split('-');
  return `לא ניתן לסמן משימה שמיועדת ל-${dd}/${mm} — היא עוד לא הגיעה`;
};

// מצב שלישי: המשימה פשוט לא הייתה רלוונטית היום (למשל לא היו מיילים דחופים).
// לא בוצעה ולא בפיגור — ולכן גם לא נספרת באחוזי הביצוע.
const IRRELEVANT = 'לא רלוונטי';
const isHandled = (t) => t.status === 'done' || t.status === IRRELEVANT;

/* חישוב התקדמות אחיד לכל המסכים.
   משימה שסומנה "לא רלוונטי" יוצאת מהמכנה: היא לא בוצעה ולא נכשלה, ואסור
   שהיא תתקע את המחוון מתחת ל-100%. היא עדיין נספרת בנפרד ומוצגת למשתמשת.
   מקרה קצה: אם *כל* המשימות סומנו "לא רלוונטי" (relevant === 0) אין מה
   לחלק — נחשב 100% ("אין מה לעשות היום" = סיימנו), בלי חלוקה באפס. */
function progressOf(list) {
  const relevant = list.filter((t) => t.status !== IRRELEVANT);
  const done = relevant.filter((t) => t.status === 'done').length;
  const skipped = list.length - relevant.length;
  const pct = relevant.length ? Math.round((done / relevant.length) * 100) : (list.length ? 100 : 0);
  return { done, relevant: relevant.length, skipped, pct, total: list.length };
}

// "· 2 לא רלוונטי" — נספח קצר שמוצג רק כשבאמת יש כאלה, כדי שהמספרים לא ישקרו
const skipNote = (n) => (n ? ` · ${n} לא רלוונטי` : '');

// טקסט "בוצע ע"י מי ומתי". מציג גם תאריך אם הביצוע לא היה היום.
function doneLabel(t) {
  if (!isHandled(t)) return '';
  const who = t.done_by || '—';
  const at = String(t.done_at || '');
  const time = at.slice(11, 16);
  const day = at.slice(0, 10);
  const when = !day ? '' : (day === CTX.today ? (time ? 'היום ' + time : 'היום')
    : day.slice(8, 10) + '/' + day.slice(5, 7) + (time ? ' ' + time : ''));
  const verb = t.status === IRRELEVANT ? 'סומן "לא רלוונטי" ע"י' : 'בוצע ע"י';
  return `${verb} ${who}${when ? ' · ' + when : ''}`;
}

/* סימון "חשוב" בכוכב — מעלה את המשימה לראש הרשימה.
   מנגנון אחד בלבד: אותו שדה pinned בשרת, אותו מיון. זה מה שהחליף את סרגל
   סינון העדיפות, שהסתיר משימות אחרות ויצר בלבול. */
async function togglePin(t, refresh) {
  try {
    const r = await api(`/api/tasks/${t.id}/pin`, { method: 'POST', body: { pinned: !t.pinned } });
    toast(r.pinned ? '⭐ המשימה עלתה לראש הרשימה' : 'המשימה חזרה למקומה ברשימה', 'ok');
    refresh();
  } catch (e) {
    if (e.status === 401) return logout();
    toast(e.message || 'לא ניתן לסמן את המשימה כחשובה', 'err');
  }
}

// כפתור הכוכב — זמין לכל מי שרואה את המשימה (גם מוקדנית), גם בכרטיסים וגם בטבלה
function pinButton(t, refresh) {
  const b = el('button', 'pin-btn' + (t.pinned ? ' on' : ''), t.pinned ? '⭐' : '☆');
  b.title = t.pinned ? 'ביטול הסימון — המשימה תחזור למקומה' : 'סימון כחשוב — המשימה תעלה לראש הרשימה';
  b.setAttribute('aria-label', b.title);
  b.setAttribute('aria-pressed', t.pinned ? 'true' : 'false');
  b.addEventListener('click', (e) => { e.stopPropagation(); togglePin(t, refresh); });
  return b;
}

// שינוי מצב משימה לערך מפורש (open / done / לא רלוונטי)
async function setTaskState(t, status, refresh) {
  if (isFutureTask(t)) { toast(futureReason(t), 'err'); return; }
  try {
    await api(`/api/tasks/${t.id}/state`, { method: 'POST', body: { status } });
    refresh();
  } catch (e) {
    if (e.status === 401) return logout();
    toast(e.message || 'לא ניתן לעדכן את המשימה', 'err');
  }
}

// סימון/ביטול משימה — נקודה אחת שבה מטופלות גם שגיאות השרת (למשל משימה עתידית)
async function toggleTask(t, refresh) {
  if (isFutureTask(t)) { toast(futureReason(t), 'err'); return; }
  try {
    await api(`/api/tasks/${t.id}/toggle`, { method: 'POST', body: {} });
    refresh();
  } catch (e) {
    if (e.status === 401) return logout();
    toast(e.message || 'לא ניתן לעדכן את המשימה', 'err');
  }
}

function priorityDot(t, onChange) {
  const dot = el('button', 'pr-dot');
  const meta = PR_META[t.priority] || PR_META['רגיל'];
  dot.style.background = meta.color;
  dot.title = 'עדיפות: ' + meta.label + ' (לחיצה לשינוי)';
  dot.addEventListener('click', async (e) => {
    e.stopPropagation();
    const next = PRIORITIES[(PRIORITIES.indexOf(t.priority) + 1) % PRIORITIES.length];
    await api(`/api/tasks/${t.id}/priority`, { method: 'POST', body: { priority: next } });
    onChange();
  });
  return dot;
}

function taskRow(t, refresh, { showBadges = true } = {}) {
  const today = CTX.today;
  const isOneOff = t.source === 'manual' || t.frequency === 'once';
  const irrelevant = t.status === IRRELEVANT;
  const row = el('div', 'task-row' + (t.status === 'done' ? ' done' : '') +
    (irrelevant ? ' irrelevant' : '') + (isOneOff ? ' oneoff' : ''));
  row.style.borderInlineStart = `4px solid ${(PR_META[t.priority] || PR_META['רגיל']).color}`;
  // פשטות כמו ביומן גוגל: הצבע בגבול השורה כבר מספר על העדיפות — לא צריך גם תג טקסט.
  // רק מידע שדורש פעולה (באיחור / לא רלוונטי) נשאר כתג.
  const badges = showBadges ? (
    (t.status === 'open' && t.due_date && t.due_date < today ? '<span class="badge overdue">באיחור</span>' : '') +
    (t.status === IRRELEVANT ? '<span class="badge irrelevant">לא רלוונטי היום</span>' : '')
  ) : '';
  // תגית שיוך מוצגת רק כשהיא מוסיפה מידע — לשיוך ברירת המחדל אין מה להציג
  const sm = SCOPE_META[t.scope];
  const scopeBadge = (sm && t.scope !== DEFAULT_SCOPE) ? `<span class="badge" style="background:#efe9f7;color:var(--purple)">${sm.icon} ${esc(sm.label)}</span>` : '';
  const assigneeBadge = t.assignee ? `<span class="badge" style="background:var(--blue-100);color:var(--navy-800)">👤 ${esc(t.assignee)}</span>` : '';
  const future = isFutureTask(t);
  if (future) row.classList.add('future-locked');
  const meta = isHandled(t)
    ? `<div class="task-meta ${irrelevant ? 'irr-by' : 'done-by'}">${irrelevant ? '⊘' : '✓'} ${esc(doneLabel(t))}</div>`
    : (future ? `<div class="task-meta">🔒 ${esc(futureReason(t))}</div>` : '');
  const descLine = t.description ? `<div class="task-meta task-desc">${esc(t.description)}</div>` : '';
  // תיבת הסימון היא **המקום היחיד** שמסמן "בוצע". קודם כל השורה הייתה לחיצה,
  // והכפתורים תפסו רק 8% ממנה — כך שהחטאה קטנה של "לא רלוונטי" סימנה "בוצע" במקום.
  const check = el('button', 'task-check' + (future ? ' disabled' : '') + (irrelevant ? ' irr' : ''),
    t.status === 'done' ? '✓' : irrelevant ? '⊘' : (future ? '🔒' : ''));
  check.title = future ? futureReason(t)
    : t.status === 'done' ? 'ביטול הסימון' : 'סימון שהמשימה בוצעה';
  check.setAttribute('aria-pressed', t.status === 'done' ? 'true' : 'false');
  if (!future) check.addEventListener('click', (e) => { e.stopPropagation(); toggleTask(t, refresh); });
  const threadBtn = el('button', 'task-thread-btn' + (t.commentCount ? ' has-comments' : ''),
    t.commentCount ? `💬 ${t.commentCount}` : '💬');
  threadBtn.title = 'התכתבות וקבצים למשימה';
  threadBtn.addEventListener('click', (e) => { e.stopPropagation(); taskThreadModal(t); });
  row.append(
    check,
    el('div', 'task-title', esc(t.title) + scopeBadge + assigneeBadge + badges + descLine + meta),
    threadBtn,
    pinButton(t, refresh),
    priorityDot(t, refresh)
  );
  // כפתור המצב השלישי: "לא רלוונטי היום". לא כל משימה יומית באמת נדרשת כל יום.
  if (!future) {
    const irrBtn = el('button', 'irr-btn' + (irrelevant ? ' on' : ''), irrelevant ? '↩ החזרה' : '⊘ לא רלוונטי');
    irrBtn.title = irrelevant
      ? 'ביטול הסימון והחזרת המשימה למצב פתוח'
      : 'לא היה מה לעשות היום — לא ייחשב פיגור ולא ייספר באחוזי הביצוע';
    irrBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setTaskState(t, irrelevant ? 'open' : IRRELEVANT, refresh);
    });
    row.append(irrBtn);
  }
  if (future) row.title = futureReason(t);
  // אין יותר לחיצה על כל השורה — היא הייתה הופכת כל החטאה של כפתור לסימון "בוצע"
  return row;
}

// הופך URL-ים בטקסט לקישורים לחיצים, אחרי שהטקסט כבר ברח מ-HTML
function linkify(escapedText) {
  return escapedText.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/* ---- התכתבות וקבצים למשימה ---- */
function taskThreadModal(t) {
  const back = el('div', 'modal-back');
  const m = el('div', 'modal');
  m.innerHTML = `
    <div class="modal-head"><h3>💬 ${esc(t.title)}</h3></div>
    <div id="tt-comments"></div>
    <div class="row" style="margin-top:10px">
      <textarea id="tt-new-body" class="in grow" placeholder="שאלה/הערה על המשימה…" style="min-height:70px"></textarea>
    </div>
    <div class="row">
      <label class="sb-check"><input type="checkbox" id="tt-urgent"> דחוף — שלחי גם למייל של המנהלת</label>
      <button class="btn-primary" id="tt-send">שליחה</button>
    </div>
    <div class="section-title">📎 קבצים מצורפים</div>
    <div id="tt-attachments"></div>
    <div class="row">
      <label class="btn-secondary" style="cursor:pointer">📥 צירוף קובץ<input type="file" id="tt-file" class="hidden"></label>
    </div>
    <div class="form-actions"><button class="btn-ghost" id="tt-close">סגירה</button></div>
    <div id="tt-err" class="err-line"></div>`;
  back.append(m);
  document.body.append(back);
  back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
  m.querySelector('#tt-close').addEventListener('click', () => back.remove());

  const loadComments = async () => {
    const rows = await api(`/api/tasks/${t.id}/comments`);
    const box = m.querySelector('#tt-comments');
    if (!rows.length) { box.innerHTML = '<div class="empty-state">אין עדיין התכתבות על המשימה</div>'; return; }
    box.innerHTML = rows.map((c) => `
      <div class="tt-comment${c.urgent ? ' urgent' : ''}">
        <div class="meta"><b>${esc(c.from_user)}</b>${c.urgent ? ' <span class="badge overdue">דחוף</span>' : ''} · ${esc((c.created_at || '').slice(0, 16))}</div>
        <div>${linkify(esc(c.body))}</div>
      </div>`).join('');
  };
  const loadAttachments = async () => {
    const rows = await api(`/api/tasks/${t.id}/attachments`);
    const box = m.querySelector('#tt-attachments');
    if (!rows.length) { box.innerHTML = '<div class="empty-state">אין קבצים מצורפים</div>'; return; }
    box.innerHTML = '';
    rows.forEach((a) => {
      const item = el('div', 'tt-attachment');
      item.innerHTML = `<span>📄 ${esc(a.filename)}</span><span class="sub muted"> · ${esc(a.uploaded_by)} · ${esc((a.created_at || '').slice(0, 16))}</span>`;
      const dl = el('button', 'btn-secondary btn-sm', 'הורדה');
      dl.addEventListener('click', async () => {
        const full = await api(`/api/tasks/attachments/${a.id}/download`);
        const link = document.createElement('a');
        link.href = full.data; link.download = full.filename;
        document.body.append(link); link.click(); link.remove();
      });
      const delBtn = el('button', 'btn-secondary btn-sm', 'מחיקה');
      delBtn.addEventListener('click', async () => {
        if (!confirm('למחוק את הקובץ?')) return;
        await api(`/api/tasks/attachments/${a.id}`, { method: 'DELETE' });
        loadAttachments();
      });
      item.append(dl, delBtn);
      box.append(item);
    });
  };

  m.querySelector('#tt-send').addEventListener('click', async () => {
    const body = m.querySelector('#tt-new-body').value.trim();
    if (!body) return;
    try {
      await api(`/api/tasks/${t.id}/comments`, { method: 'POST', body: { body, urgent: m.querySelector('#tt-urgent').checked } });
      m.querySelector('#tt-new-body').value = '';
      m.querySelector('#tt-urgent').checked = false;
      loadComments();
    } catch (e) { m.querySelector('#tt-err').textContent = e.message || 'השליחה נכשלה'; }
  });
  m.querySelector('#tt-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = await fileToDataUrl(file);
      await api(`/api/tasks/${t.id}/attachments`, { method: 'POST', body: { filename: file.name, data } });
      loadAttachments();
    } catch (err) { m.querySelector('#tt-err').textContent = err.message || 'העלאת הקובץ נכשלה'; }
    e.target.value = '';
  });

  loadComments();
  loadAttachments();
}

/* ---- תצוגת טבלה: שורות קצרות ורחבות, שורה אחת למשימה ---- */
function tasksTable(list, refresh) {
  const wrap = el('div', 'tasks-table-wrap');
  const t = el('table', 'tasks-table');
  t.innerHTML = '<thead><tr><th class="c-chk">✓</th><th class="c-chk">⊘</th><th class="c-chk" title="חשוב — בראש הרשימה">⭐</th>' +
    '<th>משימה</th><th>קטגוריה</th><th>עדיפות</th><th>אחראית</th><th>סטטוס</th></tr></thead>';
  const tb = el('tbody');

  for (const task of list) {
    const future = isFutureTask(task);
    const irrelevant = task.status === IRRELEVANT;
    const tr = el('tr', 'tt-row' + (task.status === 'done' ? ' done' : '') +
      (irrelevant ? ' irrelevant' : '') + (future ? ' future-locked' : '') + (task.pinned ? ' pinned' : ''));
    tr.style.borderInlineStart = `5px solid ${(PR_META[task.priority] || PR_META['רגיל']).color}`;

    // תא הסימון — לחיצה בו מבצעת/מבטלת, ולא מנווטת
    const tdChk = el('td', 'c-chk');
    const box = el('button', 'tt-check' + (task.status === 'done' ? ' on' : '') + (future ? ' disabled' : ''),
      task.status === 'done' ? '✓' : (future ? '🔒' : ''));
    box.title = future ? futureReason(task) : (task.status === 'done' ? 'לחיצה תבטל את הסימון' : 'סימון כבוצע');
    if (future) box.disabled = true;
    box.addEventListener('click', (e) => { e.stopPropagation(); toggleTask(task, refresh); });
    tdChk.append(box);

    // תא "לא רלוונטי היום"
    const tdIrr = el('td', 'c-chk');
    if (!future) {
      const ib = el('button', 'tt-check irr' + (irrelevant ? ' on' : ''), irrelevant ? '⊘' : '');
      ib.title = irrelevant ? 'ביטול הסימון — חזרה למצב פתוח'
        : 'לא רלוונטי היום — לא ייחשב פיגור ולא ייספר באחוזי הביצוע';
      ib.addEventListener('click', (e) => {
        e.stopPropagation();
        setTaskState(task, irrelevant ? 'open' : IRRELEVANT, refresh);
      });
      tdIrr.append(ib);
    }

    const tdTitle = el('td', 'c-title', esc(task.title));
    const tdCat = el('td', 'c-cat', `${catIcon(task.category)} ${esc(task.category)}`);

    const tdPr = el('td', 'c-pr');
    const prWrap = el('span', 'tt-pr');
    prWrap.append(priorityDot(task, refresh), el('span', '', esc(task.priority || 'רגיל')));
    tdPr.append(prWrap);

    const tdWho = el('td', 'c-who', task.assignee ? '👤 ' + esc(task.assignee) : '—');
    const tdDone = el('td', 'c-done', isHandled(task) ? esc(doneLabel(task)) : '—');
    const tdPin = el('td', 'c-chk');
    tdPin.append(pinButton(task, refresh));

    tr.append(tdChk, tdIrr, tdPin, tdTitle, tdCat, tdPr, tdWho, tdDone);
    // שלושת תאי הפעולה חוסמים את הלחיצה ברמת ה-**תא** ולא רק ברמת הכפתור:
    // הכפתור קטן מהתא, ולחיצה על השוליים שלו הייתה מנווטת למסך אחר במקום לסמן.
    [tdChk, tdIrr, tdPin].forEach((td) => {
      td.title = '';
      td.addEventListener('click', (e) => e.stopPropagation());
    });
    // לחיצה על שאר השורה — מעבר למסך הבקרה (לוח המנהלת)
    tr.title = 'לחיצה — מעבר למסך הבקרה';
    tr.addEventListener('click', () => goToTab('dashboard'));
    tb.append(tr);
  }
  t.append(tb);
  wrap.append(t);
  return wrap;
}

// מתג תצוגה: רשימה / טבלה — הבחירה נשמרת ב-localStorage
function viewToggleBar(refresh) {
  const bar = el('div', 'view-toggle');
  bar.append(el('span', 'vt-lbl', 'תצוגה:'));
  [['list', '☰ רשימה'], ['table', '▦ טבלה']].forEach(([mode, label]) => {
    const b = el('button', 'chip' + (VIEW_MODE === mode ? ' active' : ''), label);
    b.addEventListener('click', () => {
      if (VIEW_MODE === mode) return;
      VIEW_MODE = mode;
      localStorage.setItem(VIEW_LS, mode);
      refresh();
    });
    bar.append(b);
  });
  return bar;
}

// בורר שיוך: תחילת משמרת / סוף משמרת / מוקדנית בוקר / מנהלת / אישי
/* התאמת משימה לסינון שיוך.
   כלל מרכזי: משימה שמשויכת אישית לעובדת שייכת ל"אישי" **בלבד**, והיא לא מופיעה
   שוב תחת שיוך המשמרת שלה. אחרת משימה של נירה הייתה מופיעה גם תחת "מוקדנית בוקר",
   וזו בדיוק הכפילות שיצרה בלבול על הלוח. */
function matchesScope(t, filter) {
  if (filter === 'הכל') return true;
  if (filter === 'אישי') return !!t.assignee;
  return !t.assignee && (t.scope || DEFAULT_SCOPE) === filter;
}

/* ברכת שלום אישית לפי שעת הדפדפן. זו ברכה ולא נתון עסקי, ולכן שעון
   המחשב של המשתמשת הוא המקור הנכון כאן. */
function greetingParts(h = new Date().getHours()) {
  if (h >= 5 && h < 12) return { hello: 'בוקר טוב', wish: 'שיהיה לך יום מוצלח' };
  if (h >= 12 && h < 17) return { hello: 'צהריים טובים', wish: 'שתהיה לך משמרת נעימה' };
  if (h >= 17 && h < 21) return { hello: 'ערב טוב', wish: 'שתהיה לך משמרת נעימה' };
  return { hello: 'לילה טוב', wish: 'שתהיה לך משמרת נעימה' };
}

function greetingBanner() {
  const { hello, wish } = greetingParts();
  const box = el('div', 'greeting');
  box.innerHTML = `<span class="greet-hello">${esc(hello)}, ${esc(USER.name || '')}</span>` +
    `<span class="greet-wish">${esc(wish)}</span>`;
  return box;
}

/* כותרת-על "הכל": סך כל המשימות של המסך. לחיצה מאפסת את הסינון.
   השיוכים שמתחתיה הם תתי-קבוצות של המספר הזה — לא תוספות לו. */
function scopeTotalHeader(tasks, refresh) {
  const active = SCOPE_FILTER === 'הכל';
  const head = el('button', 'scope-total' + (active ? ' active' : ''));
  head.innerHTML = `<span class="st-main">📋 סה"כ ${tasks.length} משימות היום</span>` +
    `<span class="st-sub">${active ? 'מוצגות כולן' : 'לחצי לאיפוס הסינון'}</span>`;
  head.addEventListener('click', () => { SCOPE_FILTER = 'הכל'; refresh(); });
  return head;
}

function scopeFilterBar(tasks, refresh) {
  const bar = el('div', 'filter-bar scope-bar');
  const groups = [
    ...SCOPE_ORDER.map((k) => [k, tasks.filter((t) => matchesScope(t, k)).length]),
    ['אישי', tasks.filter((t) => t.assignee).length],
  ];
  // שיוך ריק (0 משימות) לא מוצג כלל — צ׳יפ ריק הוא רעש. "הכל" כבר מוצג ככותרת-על
  // מעל הסרגל (scopeTotalHeader), ולכן לא חוזר כאן כצ׳יפ.
  const present = groups.filter(([, c]) => c > 0);
  // צ׳יפ בודד שמכיל את *כל* המשימות לא מסנן כלום — הוא רק חוזר על הכותרת. מסתירים.
  if (present.length < 2 && (!present.length || present[0][1] === tasks.length)) {
    SCOPE_FILTER = 'הכל';
    return bar;
  }
  bar.append(el('div', 'subgroup-hint', 'מתוכן:'));
  for (const [name, count] of present) {
    const meta = SCOPE_META[name];
    const chip = el('button', 'chip' + (SCOPE_FILTER === name ? ' active' : ''),
      `${name === 'אישי' ? '👤 אישי' : (meta && meta.icon ? meta.icon + ' ' : '') + name} (${count})`);
    chip.addEventListener('click', () => { SCOPE_FILTER = name; refresh(); });
    bar.append(chip);
  }
  return bar;
}

/* מקרא קצר שמסביר מי רואה מה — כדי שלא יהיה ניחוש בין שיוך משמרת ל"אישי" */
function scopeLegend() {
  const box = el('div', 'scope-legend');
  box.innerHTML = `
    <div class="sl-row"><b>▶️ תחילת משמרת</b> — צ׳ק-ליסט הכניסה. כל הצוות רואה, ומי שנוח יכולה לבצע. זו ברירת המחדל.</div>
    <div class="sl-row"><b>⏹️ סוף משמרת</b> — צ׳ק-ליסט היציאה. גם כאן כל הצוות רואה.</div>
    <div class="sl-row"><b>👤 אישי (אחראית)</b> — רק העובדת ששמה רשום רואה אותה, בתוספת מנהלת ו${TOP_ROLE}. זה מה שמונע שמשימה של רותי תופיע לכולן.</div>
    <div class="sl-row"><b>מנהלת בלבד</b> — סגור בפני שאר הצוות.</div>
    <div class="sl-row"><b>תחילת משמרת · סוף משמרת · מוקדנית בוקר</b> — אלה <u>קיבוץ לפי שלב במשמרת</u>, לא הרשאה: כל הצוות רואה אותן, והן רק מסודרות יחד בצ׳ק-ליסט.</div>
    <div class="sl-row"><b>⭐ כוכב</b> — כל עובדת יכולה לסמן משימה בכוכב, והיא תעלה לראש הרשימה. הכוכב לא משנה מי רואה את המשימה.</div>
    <div class="sl-row" style="margin-top:10px;border-top:1px solid var(--line);padding-top:8px">משימה שיש לה אחראית בשם מופיעה <b>רק</b> תחת "אישי" — ולא שוב תחת שיוך המשמרת שלה, כדי שלא תיספר פעמיים.</div>`;
  return box;
}

/* סרגל סינון העדיפות הוסר במכוון: כשהוא היה לחוץ הוא הסתיר את כל שאר המשימות
   ויצר בלבול. במקומו — הכוכב (pinButton), שמעלה משימה לראש הרשימה בלי להעלים כלום.
   העדיפות עצמה נשארה: הנקודה הצבעונית בשורה ובחירת העדיפות בטפסים. */

/* ===================== משימות (היום/שבוע/תקופתי) ===================== */
async function renderTasks(main, scope) {
  const { labels, tasks } = await api('/api/tasks?scope=' + scope);
  main.innerHTML = '';

  const scopeTitle = { today: labels.daily + ' · ' + labels.weekly, week: labels.weekly, periodic: labels.monthly + ' · ' + labels.quarterly }[scope];
  // המכנה הוא רק המשימות הרלוונטיות — ראה progressOf()
  const P = progressOf(tasks);
  const pct = P.pct;
  const allSkipped = tasks.length > 0 && P.relevant === 0;

  /* אזור ההגדרות העליון (מקרא הרשאות + מתג תצוגה) מיועד למנהלת בלבד.
     לעובדת (מוקדנית/מתנדבת) הוא רק מעמיס — היא מקבלת מסך משמרת נקי,
     ותמיד בתצוגת טבלה. הכפייה כאן ולא רק בהסתרת הכפתור, כדי ש-'list'
     שנשמר ב-localStorage מכניסה קודמת לא ישחזר לה את תצוגת הרשימה. */
  const showAdminBand = isManagerRole(USER.role);
  if (!showAdminBand) VIEW_MODE = 'table';

  // ברכת שלום אישית לפי שעת הדפדפן (ברכה בלבד — לא נתון עסקי)
  main.append(greetingBanner());

  const prog = el('div', 'progress-wrap');
  prog.append(
    // סדר ה-DOM הפוך בכוונה: הדף RTL, ולכן האיבר הראשון ב-flex יושב מימין.
    // כדי שכותרת היום תופיע *משמאל* והמחוון *מימין* — המחוון נכתב ראשון.
    el('div', 'progress-label',
      `<span class="pl-count">${allSkipped ? 'אין משימות רלוונטיות היום' : `${P.done}/${P.relevant} בוצעו`}` +
      `<span class="pl-skip">${esc(skipNote(P.skipped))}</span></span>` +
      `<span class="pl-title">${esc(scopeTitle)}</span>`),
    (() => {
      const b = el('div', 'progress-bar' + (pct === 100 && tasks.length ? ' is-complete' : ''));
      b.setAttribute('role', 'progressbar');
      b.setAttribute('aria-valuemin', '0');
      b.setAttribute('aria-valuemax', '100');
      b.setAttribute('aria-valuenow', String(pct));
      b.append(Object.assign(el('div', 'progress-fill'), { style: `width:${pct}%` }));
      return b;
    })()
  );
  main.append(prog);

  if (pct === 100 && tasks.length) {
    main.append(el('div', 'celebrate',
      allSkipped
        ? '🎉 אין משימות רלוונטיות היום — הכל סגור'
        : `🎉 כל הכבוד! כל המשימות הושלמו${esc(skipNote(P.skipped))}`));
  }

  // "הכל" הוא כותרת-על נפרדת (סך הכל), והשיוכים מתחתיה הם תתי-קבוצות שלו
  // בורר שיוך (מנהלת/בוקר/משמרת/אישי) — מוצג רק אם יש משימות מכמה שיוכים
  const scopeBar = scopeFilterBar(tasks, refreshKeepScroll);
  /* אם אין בפועל יותר מקבוצה אחת, הבורר חוזר ריק — ואז גם כותרת "הכל" מיותרת:
     היא כפתור איפוס לסינון שאין לו מה לסנן. לעובדת מסירים את שניהם.
     למנהלת המסך נשאר בדיוק כפי שהיה. */
  const hasScopeChips = scopeBar.children.length > 0;
  if (showAdminBand || hasScopeChips) {
    main.append(scopeTotalHeader(tasks, refreshKeepScroll));
    main.append(scopeBar);
  }
  // מקרא "מי רואה מה" — נפתח בלחיצה. מוצג תמיד, גם כשאין כרגע משימות משויכות:
  // דווקא אז אין מהמסך עצמו דרך להבין את ההבדל בין שיוך משמרת ל"אישי".
  if (showAdminBand) {
    const help = el('button', 'ho-band-toggle', (SHOW_SCOPE_HELP ? '▾' : '▸') + ' מי רואה מה? (תחילת משמרת / סוף משמרת / אישי)');
    help.addEventListener('click', () => { SHOW_SCOPE_HELP = !SHOW_SCOPE_HELP; refreshKeepScroll(); });
    main.append(help);
    if (SHOW_SCOPE_HELP) main.append(scopeLegend());
    main.append(viewToggleBar(refreshKeepScroll));
  }

  const visible = tasks.filter((t) => matchesScope(t, SCOPE_FILTER));
  if (!visible.length) main.append(el('div', 'empty-state', 'אין משימות להצגה בסינון הזה'));

  if (VIEW_MODE === 'table') {
    if (visible.length) main.append(tasksTable(visible, refreshKeepScroll));
    main.append(newTaskForm()); // ➕ הוספת משימה — בתחתית המסך
    return;
  }

  // משימות מסומנות בכוכב — תמיד למעלה, מעל כל הקטגוריות, ותמיד פתוחות
  const pinned = visible.filter((t) => t.pinned);
  if (pinned.length) {
    const box = el('div', 'cat-card pinned-card');
    box.append(el('div', 'cat-head pinned-head',
      `<span>⭐ חשוב — בראש הרשימה</span><span class="cat-count">${pinned.length}</span>`));
    pinned.forEach((t) => box.append(taskRow(t, refreshKeepScroll)));
    main.append(box);
  }

  // שאר המשימות מקובצות לקטגוריות. הכותרות סגורות כברירת מחדל ונפתחות בלחיצה —
  // כך הלוח הוא טבלת כותרות קצרה במקום רשימה אינסופית לגלילה.
  const rest = visible.filter((t) => !t.pinned);
  const cats = {};
  rest.forEach((t) => (cats[t.category] = cats[t.category] || []).push(t));
  const catNames = Object.keys(cats);
  // בפעם הראשונה שנכנסים למסך — כל הקטגוריות סגורות, כדי שהלוח ייפתח כטבלת כותרות
  if (!COLLAPSED_LOADED && catNames.length) {
    catNames.forEach((c) => COLLAPSED.add(c));
    COLLAPSED_LOADED = true;
    saveCollapsed();
  }

  if (catNames.length) {
    const bar = el('div', 'cat-tools');
    const openAll = el('button', 'chip', '▾ פתיחת הכל');
    openAll.addEventListener('click', () => { catNames.forEach((c) => COLLAPSED.delete(c)); saveCollapsed(); refreshKeepScroll(); });
    const closeAll = el('button', 'chip', '◂ סגירת הכל');
    closeAll.addEventListener('click', () => { catNames.forEach((c) => COLLAPSED.add(c)); saveCollapsed(); refreshKeepScroll(); });
    bar.append(openAll, closeAll);
    main.append(bar);
  }

  for (const [cat, list] of Object.entries(cats)) {
    const card = el('div', 'cat-card');
    // אותה לוגיקה כמו במחוון הראשי: "לא רלוונטי" יוצאת מהמכנה של הקטגוריה
    const cp = progressOf(list);
    // ברירת המחדל: סגור. קטגוריה נפתחת רק אם המשתמשת פתחה אותה, או אם הגיעה
    // אליה בלחיצה מלוח הבקרה.
    if (OPEN_CAT === cat) COLLAPSED.delete(cat);
    const collapsed = COLLAPSED.has(cat);
    // "X מתוך N" מבהיר שהמספר על הכרטיס הוא *נתח* מסך המשימות ולא תוספת עליו
    const head = el('div', 'cat-head',
      `<span class="cat-name">${catIcon(cat)} ${esc(cat)}` +
      `<span class="cat-share">${list.length} מתוך ${tasks.length} משימות</span></span>` +
      `<span class="cat-count ${cp.pct === 100 ? 'all-done' : ''}">` +
      `${cp.relevant ? `${cp.done}/${cp.relevant} בוצעו` : 'אין רלוונטיות'}` +
      `${esc(skipNote(cp.skipped))} ${collapsed ? '◂' : '▾'}</span>`);
    head.addEventListener('click', () => {
      collapsed ? COLLAPSED.delete(cat) : COLLAPSED.add(cat);
      OPEN_CAT = null;
      saveCollapsed();
      refreshKeepScroll();
    });
    card.append(head);
    if (!collapsed) list.forEach((t) => card.append(taskRow(t, refreshKeepScroll)));
    main.append(card);
  }
  OPEN_CAT = null;

  // ➕ הוספת משימה — בתחתית המסך, מתחת לכל הקטגוריות
  main.append(newTaskForm());
}

/* ---- פגישות/תורים אישיים בלוח השנה — פרטיים לגמרי, רק מי שיצרה אותם רואה ---- */
function personalEventRow(ev) {
  const row = el('div', 'task-row');
  row.style.borderInlineStart = '4px solid var(--blue-500)';
  const del = el('button', 'btn-secondary btn-sm', '🗑');
  del.title = 'מחיקת הפגישה';
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('למחוק את הפגישה?')) return;
    try { await api(`/api/personal-events/${ev.id}`, { method: 'DELETE' }); toast('הפגישה נמחקה', 'ok'); render(); }
    catch (err) { toast(err.message || 'המחיקה נכשלה', 'err'); }
  });
  row.append(
    el('div', 'task-check', '🕑'),
    el('div', 'task-title', `${ev.time ? `<b>${esc(ev.time)}</b> — ` : ''}${esc(ev.title)}${ev.notes ? `<div class="task-meta">${esc(ev.notes)}</div>` : ''}`),
    del
  );
  return row;
}

function personalEventForm(defaultDue) {
  const form = el('div', 'card new-task-card');
  const due = esc(defaultDue || CTX.today || '');
  form.innerHTML = `
    <div class="section-title" style="margin-top:0">🕑 הוספת פגישה/תור אישי</div>
    <div class="row">
      <input id="pe-title" class="in grow" placeholder="עם מי / מה הפגישה?">
      <input id="pe-time" class="in" type="time" style="max-width:120px">
      <input id="pe-date" class="in" type="date" style="max-width:170px" value="${due}">
    </div>
    <div class="row">
      <input id="pe-notes" class="in grow" placeholder="הערות (לא חובה)">
      <button class="btn-secondary" id="pe-btn">הוספה</button>
    </div>`;
  const q = (s) => form.querySelector(s);
  q('#pe-btn').addEventListener('click', async () => {
    const title = q('#pe-title').value.trim();
    if (!title) return;
    try {
      await api('/api/personal-events', { method: 'POST', body: {
        title, date: q('#pe-date').value || due, time: q('#pe-time').value || null, notes: q('#pe-notes').value.trim() || null,
      } });
      toast('הפגישה נוספה', 'ok');
      render();
    } catch (e) { toast(e.message || 'לא ניתן להוסיף את הפגישה', 'err'); }
  });
  return form;
}

/* ---- טופס משימה חד־פעמית חדשה (בתחתית לוח המשימות, וגם בלוח השנה לאחר פתיחת יום) ---- */
function newTaskForm(defaultDue) {
  const form = el('div', 'card new-task-card');
  // תאריך היעד: יום שנבחר בלוח השנה, או ברירת מחדל היום — לפי השרת, כדי שלא יהיו הפרשי אזור זמן
  const due = esc(defaultDue || CTX.today || '');
  form.innerHTML = `
    <div class="section-title" style="margin-top:0">➕ שיבוץ משימה${defaultDue ? ' ליום הזה' : ' חד־פעמית חדשה'}</div>
    <div class="row">
      <input id="new-task-title" class="in grow" placeholder="מה צריך לעשות?">
      <select id="new-task-pr" class="in" style="max-width:120px">${PRIORITIES.map((p) => `<option>${p}</option>`).join('')}</select>
      ${isManagerRole(USER.role) ? `<select id="new-task-scope" class="in" style="max-width:160px" title="שיוך">
        ${scopeOptions()}
      </select>
      <select id="new-task-who" class="in" style="max-width:160px" title="למי אישית?"><option value="">לא אישי</option></select>` : ''}
      <input id="new-task-due" class="in" type="date" title="תאריך יעד" style="max-width:170px" value="${due}">
    </div>
    <div class="row">
      <input id="new-task-desc" class="in grow" placeholder="תיאור קצר (לא חובה)" maxlength="300">
      <button class="btn-primary" id="new-task-btn">הוספה</button>
    </div>`;

  // ההאזנה נעשית על האלמנט עצמו — הוא עוד לא בתוך המסמך בשלב הזה
  const q = (s) => form.querySelector(s);
  fillNamesSelect2(form, '#new-task-who');
  q('#new-task-btn').addEventListener('click', async () => {
    const title = q('#new-task-title').value.trim();
    if (!title) return;
    try {
      await api('/api/tasks', {
        method: 'POST',
        body: {
          title,
          priority: q('#new-task-pr').value,
          due_date: q('#new-task-due').value || null,
          assignee: q('#new-task-who')?.value || null,
          scope: q('#new-task-scope')?.value || DEFAULT_SCOPE,
          description: q('#new-task-desc').value.trim() || null,
        },
      });
      toast('המשימה נוספה', 'ok');
      render();
    } catch (e) { toast(e.message || 'לא ניתן להוסיף את המשימה', 'err'); }
  });
  q('#new-task-title').addEventListener('keydown', (e) => { if (e.key === 'Enter') q('#new-task-btn').click(); });
  return form;
}

// כמו fillNamesSelect, אבל על אלמנט שעוד לא צורף למסמך
async function fillNamesSelect2(root, sel) {
  const box = root.querySelector(sel);
  if (!box) return;
  try {
    (await api('/api/users/names')).forEach((n) => box.append(el('option', '', esc(n))));
  } catch { /* לא קריטי */ }
}

/* ===================== לוח שנה ===================== */
const GREG_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
async function renderCalendar(main) {
  if (!CAL) { const [y, m] = CTX.today.split('-').map(Number); CAL = { y, m }; }
  const data = await api(`/api/calendar?y=${CAL.y}&m=${CAL.m}`);
  main.innerHTML = '';

  const nav = el('div', 'cal-nav');
  const prev = el('button', 'btn-secondary btn-sm', 'החודש הקודם ‹');
  const next = el('button', 'btn-secondary btn-sm', '› החודש הבא');
  const title = el('div', 'cal-title', `<strong>${GREG_MONTHS[data.month - 1]} ${data.year}</strong><span>${esc(data.hebTitle)}</span>`);
  prev.addEventListener('click', () => { CAL.m--; if (CAL.m < 1) { CAL.m = 12; CAL.y--; } CAL_SELECTED = null; render(); });
  next.addEventListener('click', () => { CAL.m++; if (CAL.m > 12) { CAL.m = 1; CAL.y++; } CAL_SELECTED = null; render(); });
  nav.append(next, title, prev);
  main.append(nav);

  const legend = el('div', 'cal-legend');
  PRIORITIES.slice(1).concat(['רגיל']).forEach((p) =>
    legend.append(el('span', 'legend-item', `<span class="chip-dot" style="background:${PR_META[p].color}"></span>${p}`)));
  legend.append(el('span', 'legend-item', '⚠️ בעיה עם תאריך יעד'));
  legend.append(el('span', 'legend-item', '🚫 אירוע מיוחד — יום חסום'));
  main.append(legend);

  const grid = el('div', 'cal-grid');
  ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'].forEach((d) => grid.append(el('div', 'cal-dow', d)));
  for (let i = 0; i < data.days[0].dow; i++) grid.append(el('div', 'cal-cell pad'));

  for (const day of data.days) {
    const blocked = !!(day.special && day.special.blocks);
    const cell = el('div', 'cal-cell' + (day.isToday ? ' today' : '') + (CAL_SELECTED === day.date ? ' selected' : '')
      + (day.dow >= 5 ? ' weekend' : '') + (blocked ? ' cal-blocked' : ''));
    const openItems = day.items.filter((it) => it.type === 'problem' || it.status === 'open');
    let dots = '';
    for (const it of openItems.slice(0, 3)) {
      dots += it.type === 'problem'
        ? '<span class="cal-dot prob">⚠️</span>'
        : `<span class="cal-dot" style="background:${(PR_META[it.priority] || PR_META['רגיל']).color}"></span>`;
    }
    if (openItems.length > 3) dots += `<span class="cal-more">+${openItems.length - 3}</span>`;
    const hasEvents = day.items.some((it) => it.type === 'event');
    // שורה אחת קצרה בלבד לחג/אירוע — פשטות כמו ביומן גוגל, בלי להציף את התא בטקסט
    const topLine = day.special
      ? `<div class="cal-special${blocked ? ' blocking' : ''}" title="${esc(day.special.title)}">${blocked ? '🚫 ' : '★ '}${esc(day.special.title)}</div>`
      : (day.holiday ? `<div class="cal-holiday" title="${esc(day.holiday)}">${esc(day.holiday)}</div>` : '');
    cell.innerHTML = `
      <div class="cal-daynum"><span>${day.day}</span><span class="cal-heb">${esc(day.hebDay)}</span></div>
      ${topLine}
      <div class="cal-dots">${dots}${hasEvents ? '<span class="cal-dot event" title="יש לך פגישה אישית">🕑</span>' : ''}</div>`;
    cell.addEventListener('click', () => { CAL_SELECTED = day.date; render(); });
    grid.append(cell);
  }
  main.append(grid);

  if (CAL_SELECTED) {
    const day = data.days.find((d) => d.date === CAL_SELECTED);
    if (day) {
      const panel = el('div', 'cal-panel');
      panel.append(el('div', 'section-title',
        `${day.day} ב${GREG_MONTHS[data.month - 1]} · ${esc(day.hebDay)}${day.holiday ? ' · ' + esc(day.holiday) : ''}${day.parsha ? ' · פרשת ' + esc(day.parsha) : ''}`));
      panel.append(specialDayBox(day));
      if (!day.items.length) panel.append(el('div', 'empty-state', 'אין משימות ליום הזה'));
      day.items.filter((it) => it.type === 'task').forEach((t) => panel.append(taskRow(t, refreshKeepScroll)));
      day.items.filter((it) => it.type === 'problem').forEach((p) => {
        const row = el('div', 'task-row');
        row.style.borderInlineStart = '4px solid #5b4b8a';
        row.append(el('div', 'task-check', '⚠️'), el('div', 'task-title',
          `${esc(p.title)}<div class="task-meta">בעיה בסטטוס "${esc(p.status)}" — תאריך יעד</div>`));
        row.addEventListener('click', () => { if ((USER.features || []).includes('problems')) { TAB = 'problems'; buildNav(); render(); } });
        panel.append(row);
      });
      const events = day.items.filter((it) => it.type === 'event').sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
      if (events.length) {
        panel.append(el('div', 'section-title', '🕑 פגישות אישיות ליום הזה'));
        events.forEach((ev) => panel.append(personalEventRow(ev)));
      }
      panel.append(personalEventForm(day.date));
      panel.append(newTaskForm(day.date));
      main.append(panel);
    }
  } else {
    main.append(el('div', 'empty-state', 'לחצי על יום כדי לראות את המשימות שלו'));
  }
}

/* ---- אירוע מיוחד ליום נבחר: תצוגה לכולן, הוספה/מחיקה למנהלת ומעלה ---- */
function specialDayBox(day) {
  const box = el('div', 'special-box');
  const manager = isManagerRole(USER.role);

  if (day.special) {
    const blocked = !!day.special.blocks;
    box.classList.add(blocked ? 'sb-blocked' : 'sb-note');
    box.append(el('div', 'sb-title',
      `${blocked ? '🚫' : '★'} ${esc(day.special.title)}` +
      `<div class="sb-sub">${blocked ? 'היום חסום — לא נוצרות בו משימות אוטומטיות, כמו חג' : 'אירוע מסומן ביומן (היום אינו חסום)'}</div>`));
    if (manager) {
      const del = el('button', 'btn-secondary btn-sm', '🗑 מחיקת האירוע');
      del.addEventListener('click', async () => {
        if (!confirm(`למחוק את האירוע "${day.special.title}" מהתאריך ${day.date}?`)) return;
        try {
          await api('/api/special-days/' + day.special.id, { method: 'DELETE' });
          toast('האירוע נמחק', 'ok');
          render();
        } catch (e) { toast(e.message || 'המחיקה נכשלה', 'err'); }
      });
      box.append(del);
    }
    return box;
  }

  if (!manager) return box; // לא מנהלת ואין אירוע — אין מה להציג

  box.classList.add('sb-new');
  box.innerHTML = `
    <div class="sb-title">📅 הוספת אירוע מיוחד ליום הזה</div>
    <div class="row">
      <input id="sd-title" class="in grow" placeholder="שם האירוע — למשל: אירוע המתנדבות" maxlength="100">
      <label class="sb-check"><input type="checkbox" id="sd-blocks" checked> לחסום את היום (כמו חג)</label>
      <button class="btn-primary" id="sd-add">הוספה</button>
    </div>
    <div id="sd-err" class="err-line"></div>`;
  const add = async () => {
    const title = box.querySelector('#sd-title').value.trim();
    box.querySelector('#sd-err').textContent = '';
    if (title.length < 2) { box.querySelector('#sd-err').textContent = 'שם האירוע חייב להיות לפחות 2 תווים'; return; }
    try {
      await api('/api/special-days', {
        method: 'POST',
        body: { date: day.date, title, blocks: box.querySelector('#sd-blocks').checked ? 1 : 0 },
      });
      toast('האירוע נוסף ליומן', 'ok');
      render();
    } catch (e) { box.querySelector('#sd-err').textContent = e.message || 'לא ניתן להוסיף את האירוע'; }
  };
  box.querySelector('#sd-add').addEventListener('click', add);
  box.querySelector('#sd-title').addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  return box;
}

/* ===================== לוח בעיות ===================== */
const PROB_STATUSES = ['פתוח', 'בטיפול', 'הוחלט', 'בוצע', 'נבדק'];
async function renderProblems(main) {
  const problems = await api('/api/problems');
  main.innerHTML = '';
  const btn = el('button', 'btn-primary', '+ בעיה חדשה');
  btn.addEventListener('click', () => problemModal(null));
  main.append(btn);
  main.append(el('div', 'section-title', 'תהליך 6 השלבים'));

  const board = el('div', 'kanban');
  for (const st of PROB_STATUSES) {
    const col = el('div', 'kan-col');
    const items = problems.filter((p) => p.status === st);
    col.append(el('h4', '', `${esc(st)} (${items.length})`));
    items.forEach((p) => {
      const overdue = p.due_date && p.due_date < CTX.today && st !== 'נבדק' && st !== 'בוצע';
      const c = el('div', 'prob-card' + (overdue ? ' prob-overdue' : ''));
      c.append(el('div', 'prob-title', esc(p.title)),
        el('div', 'prob-meta', `${esc(p.source_type || '')}${p.due_date ? ' · יעד: ' + esc(p.due_date) : ''}${overdue ? ' ⚠️' : ''}`));
      c.addEventListener('click', () => problemModal(p));
      col.append(c);
    });
    board.append(col);
  }
  main.append(board);
}

function problemModal(p) {
  const back = el('div', 'modal-back');
  const m = el('div', 'modal');
  m.innerHTML = `
    <div class="modal-head"><h3>${p ? 'טיפול בבעיה' : 'בעיה חדשה'}</h3></div>
    <div class="sub muted">בעיה ← גורם ← מניעה ← החלטה ← תאריך יעד ← מעקב</div>
    <label class="fld">הבעיה</label><input id="pm-title" class="in" value="${esc(p?.title || '')}">
    <label class="fld">פירוט</label><textarea id="pm-details" class="in">${esc(p?.details || '')}</textarea>
    <label class="fld">מקור</label>
    <select id="pm-source" class="in">${['זוהה עצמאית', 'עובדת', 'מתנדבת', 'לקוחה'].map((s) => `<option ${p?.source_type === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
    <label class="fld">הסקת מסקנות – הגורם לבעיה</label><textarea id="pm-cause" class="in">${esc(p?.cause || '')}</textarea>
    <label class="fld">מסקנות למניעה</label><textarea id="pm-prevention" class="in">${esc(p?.prevention || '')}</textarea>
    <label class="fld">מה הוחלט</label><textarea id="pm-decision" class="in">${esc(p?.decision || '')}</textarea>
    <label class="fld">תאריך יעד לביצוע</label><input id="pm-due" class="in" type="date" value="${esc(p?.due_date || '')}">
    <label class="fld">סטטוס</label>
    <select id="pm-status" class="in">${PROB_STATUSES.map((s) => `<option ${(p?.status || 'פתוח') === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
    <div class="form-actions">
      <button class="btn-primary" id="pm-save">שמירה</button>
      <button class="btn-ghost" id="pm-cancel">ביטול</button>
    </div>
    <div id="pm-err" class="err-line"></div>`;
  back.append(m);
  document.body.append(back);
  back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
  m.querySelector('#pm-cancel').addEventListener('click', () => back.remove());
  m.querySelector('#pm-save').addEventListener('click', async () => {
    const body = {
      title: m.querySelector('#pm-title').value.trim(),
      details: m.querySelector('#pm-details').value.trim(),
      source_type: m.querySelector('#pm-source').value,
      cause: m.querySelector('#pm-cause').value.trim(),
      prevention: m.querySelector('#pm-prevention').value.trim(),
      decision: m.querySelector('#pm-decision').value.trim(),
      due_date: m.querySelector('#pm-due').value || null,
      status: m.querySelector('#pm-status').value,
    };
    try {
      if (p) await api('/api/problems/' + p.id, { method: 'PATCH', body });
      else await api('/api/problems', { method: 'POST', body });
      toast('הבעיה נשמרה', 'ok');
      back.remove(); render();
    } catch (e) { m.querySelector('#pm-err').textContent = e.message; }
  });
}

/* ===================== העברת משמרת ===================== */
const HO_AUD_LABEL = { next: 'רק למשמרת הבאה', all: 'לכל המשמרות' };

// תאריך+שעה קצרים לתצוגה: "12/08 14:30"
function shortWhen(s) {
  const v = String(s || '');
  if (v.length < 10) return v;
  return v.slice(8, 10) + '/' + v.slice(5, 7) + (v.length >= 16 ? ' ' + v.slice(11, 16) : '');
}

async function renderHandover(main) {
  // הרשימה הפעילה היא מקור האמת; ההיסטוריה נטענת רק כשמבקשים אותה
  const open = await api('/api/handovers?open=1');
  const all = HO_SHOW_HISTORY ? await api('/api/handovers') : null;
  // המונה בכותרת זהה למונה שבסרגל: רק הערות שאני עוד לא אישרתי
  const pending = open.filter((h) => (h.audience === 'all' ? !h.my_acked_at : !h.acked_at)).length;

  main.innerHTML = `
    <div class="card">
      <div class="section-title" style="margin-top:0">🔄 הערה למשמרת</div>
      <textarea id="ho-notes" class="in" placeholder="מה חשוב שהמשמרת הבאה תדע?"></textarea>
      <label class="fld" for="ho-audience">למי ההערה מיועדת?</label>
      <select id="ho-audience" class="in" style="max-width:240px">
        <option value="next">רק למשמרת הבאה</option>
        <option value="all">לכל המשמרות</option>
      </select>
      <div class="form-actions"><button class="btn-primary" id="ho-btn">רישום העברת משמרת</button></div>
      <div id="ho-err" class="err-line"></div>
    </div>
    <div class="section-title">❗ הערות פעילות${pending ? ` (${pending})` : ''}</div>
    <div id="ho-list"></div>
    <div class="form-actions" style="margin-top:14px">
      <button class="btn-secondary btn-sm" id="ho-hist">${HO_SHOW_HISTORY ? 'הסתרת הערות שטופלו' : 'הצגת הערות שטופלו'}</button>
    </div>
    <div id="ho-hist-box"></div>`;

  // מה שנכתב היום מוצג גדול וברור; הערות פעילות מימים קודמים — קטנות מתחת
  const isToday = (h) => String(h.created_at || '').slice(0, 10) === CTX.today
    || String(h.shift_date || '') === CTX.today;
  const todayNotes = open.filter(isToday);
  const olderNotes = open.filter((h) => !isToday(h));

  const list = $('#ho-list');
  if (!open.length) list.append(el('div', 'empty-state', 'אין הערות פעילות — הכל טופל 🎉'));

  if (todayNotes.length) {
    list.append(el('div', 'ho-band', `📌 נכתב היום (${todayNotes.length})`));
    todayNotes.forEach((h) => list.append(handoverItem(h)));
  } else if (open.length) {
    list.append(el('div', 'empty-state ho-none-today', 'היום עוד לא נכתבה הערה'));
  }

  if (olderNotes.length) {
    const band = el('button', 'ho-band ho-band-toggle',
      `${HO_SHOW_OLDER ? '▾' : '▸'} הערות פעילות מימים קודמים (${olderNotes.length})`);
    band.addEventListener('click', () => { HO_SHOW_OLDER = !HO_SHOW_OLDER; render(); });
    list.append(band);
    if (HO_SHOW_OLDER) olderNotes.forEach((h) => list.append(handoverItem(h, { compact: true })));
  }

  if (HO_SHOW_HISTORY) {
    const box = $('#ho-hist-box');
    const openIds = new Set(open.map((h) => h.id));
    const past = (all || []).filter((h) => !openIds.has(h.id));
    box.append(el('div', 'section-title', '📁 הערות שכבר טופלו'));
    if (!past.length) box.append(el('div', 'empty-state', 'עדיין לא אושרו הערות'));
    past.forEach((h) => box.append(handoverItem(h, { history: true, compact: true })));
  }

  $('#ho-hist').addEventListener('click', () => { HO_SHOW_HISTORY = !HO_SHOW_HISTORY; render(); });
  $('#ho-btn').addEventListener('click', async () => {
    const notes = $('#ho-notes').value.trim();
    if (!notes) return;
    try {
      await api('/api/handovers', { method: 'POST', body: { notes, audience: $('#ho-audience').value } });
      toast('העברת המשמרת נרשמה', 'ok');
      render();
    } catch (e) { $('#ho-err').textContent = e.message || 'לא ניתן לרשום את ההערה'; }
  });
}

// שורת הערת משמרת. הערה פעילה מסומנת באדום עם כוכבית וכפתור אישור V.
function handoverItem(h, { history = false, compact = false } = {}) {
  // הערה "לכל המשמרות" נשארת פעילה עד ש*אני* אישרתי אותה, לא כשמישהי אחרת אישרה
  const acked = h.audience === 'all' ? !!h.my_acked_at : !!h.acked_at;
  const item = el('div', 'list-item ho-item' + (history || acked ? ' ho-acked' : ' ho-active') +
    (compact ? ' ho-compact' : ' ho-big'));
  const audBadge = `<span class="badge ho-aud">${esc(HO_AUD_LABEL[h.audience] || HO_AUD_LABEL.next)}</span>`;
  const star = (!history && !acked) ? '<span class="ho-star" title="הערה שטרם אושרה">✱</span>' : '';
  const ackLine = acked
    ? `<div class="ho-ack">✓ נקראה ואושרה ע"י ${esc(h.acked_by || '—')} · ${esc(shortWhen(h.my_acked_at || h.acked_at))}</div>`
    : (h.acked_at
        ? `<div class="ho-ack">✓ כבר אושרה ע"י ${esc(h.acked_by || '—')} · ${esc(shortWhen(h.acked_at))}</div>`
        : '');
  item.innerHTML =
    `<div class="meta">${star}${esc(h.user_name)} · ${esc(h.shift_date)} · ${esc((h.created_at || '').slice(11, 16))} ${audBadge}</div>` +
    `<div class="ho-notes">${esc(h.notes)}</div>${ackLine}`;

  if (!history && !acked) {
    const b = el('button', 'btn-secondary btn-sm ho-ack-btn', '✓ קראתי / טופל');
    b.title = h.audience === 'all'
      ? 'ההערה תישאר מוצגת (היא לכל המשמרות) ותסומן כנקראה על שמך'
      : 'ההערה תרד מרשימת ההערות הפעילות';
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await api(`/api/handovers/${h.id}/ack`, { method: 'POST', body: {} });
        toast('ההערה סומנה כנקראה', 'ok');
        render();
      } catch (e) { b.disabled = false; toast(e.message || 'האישור נכשל', 'err'); }
    });
    item.append(b);
  }
  return item;
}

/* ===================== הודעות ===================== */
const QUICK_EMOJI = ['👍', '❤️', '😊', '🙏', '✅', '👏'];

function emojiRow(onPick) {
  const row = el('div', 'row emoji-row');
  QUICK_EMOJI.forEach((em) => {
    const b = el('button', 'emoji-btn', em);
    b.type = 'button';
    b.addEventListener('click', () => onPick(em));
    row.append(b);
  });
  return row;
}

async function renderMessages(main) {
  const manager = isManagerRole(USER.role);
  const [reports, mine, drafts] = await Promise.all([
    manager ? api('/api/messages') : Promise.resolve([]),
    api('/api/messages/mine').catch(() => []),
    api('/api/messages/drafts').catch(() => []),
  ]);
  // מסמנים כנקראו אחרי שהבאנו את הרשימה (כדי שעדיין נראה מי היה חדש בתצוגה הזו), ומרעננים את מונה התפריט
  api('/api/messages/mark-read', { method: 'POST' }).then(refreshCounters).catch(() => {});
  main.innerHTML = `
    <div class="card">
      <div class="section-title" style="margin-top:0">✉️ הודעה חדשה להנהלה</div>
      <textarea id="msg-body" class="in" placeholder="כתבי כאן במקום מחברת ההודעות…" style="min-height:120px"></textarea>
      <div id="msg-emoji"></div>
      <div class="form-actions"><button class="btn-primary" id="msg-btn">שליחת ההודעה</button></div>
      <div id="msg-sent" class="ok-line"></div>
    </div>
    <div class="card">
      <div class="section-title" style="margin-top:0">📣 שליחת הודעה כללית</div>
      <div class="row">
        <select id="bc-to" class="in" style="max-width:200px"><option value="">— לכולם —</option></select>
        <input id="bc-body" class="in grow" placeholder="תוכן ההודעה — תוצג כבאנר בראש האתר">
      </div>
      <div class="row">
        <button class="btn-primary" id="bc-btn">שליחה</button>
        <button class="btn-secondary" id="bc-draft-btn">שמירה כטיוטה</button>
      </div>
      <div id="bc-emoji"></div>
      <div id="bc-sent" class="ok-line"></div>
    </div>
    <div class="msg-tabs">
      <button class="msg-tab active" data-tab="inbox">📥 נכנס</button>
      <button class="msg-tab" data-tab="sent">📤 נשלחו</button>
      <button class="msg-tab" data-tab="drafts">📝 טיוטות${drafts.length ? ` (${drafts.length})` : ''}</button>
    </div>
    <div id="msg-folder-inbox" class="msg-folder"></div>
    <div id="msg-folder-sent" class="msg-folder hidden"></div>
    <div id="msg-folder-drafts" class="msg-folder hidden"></div>
    ${manager ? '<div class="section-title">הודעות אחרונות (ניהול)</div><div id="msg-list"></div>' : ''}`;

  $('#msg-emoji').append(emojiRow(async (em) => {
    await api('/api/messages', { method: 'POST', body: { body: em } });
    toast('נשלח', 'ok');
    render();
  }));
  $('#msg-btn').addEventListener('click', async () => {
    const body = $('#msg-body').value.trim();
    if (!body) return;
    await api('/api/messages', { method: 'POST', body: { body } });
    toast('ההודעה נשלחה', 'ok');
    render();
  });

  fillNamesSelect2(document, '#bc-to');
  const sendBroadcast = async (text) => {
    try {
      await api('/api/messages/broadcast', { method: 'POST', body: { text, to_user: $('#bc-to').value || null } });
      toast('ההודעה נשלחה', 'ok');
      render();
    } catch (e) { toast(e.message || 'השליחה נכשלה', 'err'); }
  };
  $('#bc-emoji').append(emojiRow((em) => sendBroadcast(em)));
  $('#bc-btn').addEventListener('click', () => {
    const text = $('#bc-body').value.trim();
    if (text) sendBroadcast(text);
  });
  $('#bc-draft-btn').addEventListener('click', async () => {
    const text = $('#bc-body').value.trim();
    if (!text) return;
    try {
      await api('/api/messages/draft', { method: 'POST', body: { text, to_user: $('#bc-to').value || null } });
      toast('נשמר כטיוטה', 'ok');
      render();
    } catch (e) { toast(e.message || 'השמירה נכשלה', 'err'); }
  });

  // ---- טאבים: נכנס / נשלחו / טיוטות ----
  document.querySelectorAll('.msg-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.msg-tab').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.msg-folder').forEach((f) => f.classList.add('hidden'));
      btn.classList.add('active');
      $(`#msg-folder-${btn.dataset.tab}`).classList.remove('hidden');
    });
  });

  const received = mine.filter((m) => m.from_user !== USER.name);
  const sent = mine.filter((m) => m.from_user === USER.name);
  const unreadCount = received.filter((m) => !m.read).length;
  const inboxTabBtn = document.querySelector('.msg-tab[data-tab="inbox"]');
  if (inboxTabBtn && unreadCount) inboxTabBtn.textContent = `📥 נכנס (${unreadCount})`;

  const inboxBox = $('#msg-folder-inbox');
  if (!received.length) inboxBox.append(el('div', 'empty-state', 'אין הודעות נכנסות'));
  received.forEach((msg) => {
    const item = el('div', 'list-item' + (msg.read ? '' : ' unread-msg'));
    const whoLine = `${msg.read ? '' : '🔵 '}מאת ${esc(msg.from_user)}${msg.to_user ? '' : ' (לכולם)'}`;
    item.innerHTML = `<div class="meta">${whoLine} · ${esc((msg.created_at || '').slice(0, 16))}</div>${esc(msg.body)}`;
    inboxBox.append(item);
  });

  const sentBox = $('#msg-folder-sent');
  if (!sent.length) sentBox.append(el('div', 'empty-state', 'לא שלחת עדיין הודעות'));
  sent.forEach((msg) => {
    const item = el('div', 'list-item');
    item.innerHTML = `<div class="meta">אל ${esc(msg.to_user || 'כולם')} · ${esc((msg.created_at || '').slice(0, 16))}</div>${esc(msg.body)}`;
    sentBox.append(item);
  });

  const draftsBox = $('#msg-folder-drafts');
  if (!drafts.length) draftsBox.append(el('div', 'empty-state', 'אין טיוטות'));
  drafts.forEach((d) => {
    const item = el('div', 'list-item draft-item');
    item.innerHTML = `<div class="meta">אל ${esc(d.to_user || 'כולם')}</div>`;
    const textarea = el('textarea', 'in');
    textarea.value = d.body;
    textarea.style.minHeight = '70px';
    const actions = el('div', 'row');
    actions.style.marginTop = '8px';
    const saveBtn = el('button', 'btn-secondary btn-sm', 'שמירת שינויים');
    const sendBtn = el('button', 'btn-primary btn-sm', 'שליחה');
    const delBtn = el('button', 'btn-secondary btn-sm', 'מחיקה');
    saveBtn.addEventListener('click', async () => {
      try { await api(`/api/messages/${d.id}/draft`, { method: 'PUT', body: { text: textarea.value.trim(), to_user: d.to_user } }); toast('הטיוטה נשמרה', 'ok'); render(); }
      catch (e) { toast(e.message || 'השמירה נכשלה', 'err'); }
    });
    sendBtn.addEventListener('click', async () => {
      try { await api(`/api/messages/${d.id}/send`, { method: 'POST' }); toast('ההודעה נשלחה', 'ok'); render(); }
      catch (e) { toast(e.message || 'השליחה נכשלה', 'err'); }
    });
    delBtn.addEventListener('click', async () => {
      if (!confirm('למחוק את הטיוטה?')) return;
      await api(`/api/messages/${d.id}/draft`, { method: 'DELETE' });
      render();
    });
    actions.append(saveBtn, sendBtn, delBtn);
    item.append(textarea, actions);
    draftsBox.append(item);
  });

  if (!manager) return;
  const list = $('#msg-list');
  if (!reports.length) list.append(el('div', 'empty-state', 'אין הודעות'));
  reports.forEach((msg) => {
    const item = el('div', 'list-item' + (msg.handled_at ? ' handled' : ''));
    item.innerHTML = `<div class="meta"><b style="color:var(--navy-800);font-size:1.02em">✍️ ${esc(msg.from_user)}</b> · ${esc((msg.created_at || '').slice(0, 16).replace('T', ' '))}${msg.handled_at ? ` · טופל ע"י ${esc(msg.handled_by)}` : ''}</div>${esc(msg.body)}`;
    const replyRow = el('div', 'row', '');
    replyRow.style.marginTop = '8px';
    const replyInput = el('input', 'in grow');
    replyInput.placeholder = `תגובה ל${msg.from_user} — תוצג לה בראש האתר`;
    const replyBtn = el('button', 'btn-secondary btn-sm', 'שליחת תגובה');
    replyBtn.addEventListener('click', async () => {
      const text = replyInput.value.trim();
      if (!text) return;
      try { await api(`/api/messages/${msg.id}/reply`, { method: 'POST', body: { text } }); toast('התגובה נשלחה', 'ok'); render(); }
      catch (e) { toast(e.message || 'השליחה נכשלה', 'err'); }
    });
    replyRow.append(replyInput, replyBtn);
    item.append(replyRow);
    if (!msg.handled_at) {
      const b = el('button', 'btn-secondary btn-sm', 'סימון כטופל');
      b.style.marginTop = '8px';
      b.addEventListener('click', async () => { await api(`/api/messages/${msg.id}/handle`, { method: 'PATCH' }); render(); });
      item.append(b);
    }
    list.append(item);
  });
}

/* ===================== שעות נוכחות ===================== */
function fmtHours(h) {
  const totalMin = Math.round(h * 60);
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  return `${hh}:${String(mm).padStart(2, '0')}`;
}

function liveElapsedLabel(sinceIso) {
  const since = new Date(sinceIso.replace(' ', 'T'));
  const diffSec = Math.max(0, Math.floor((Date.now() - since.getTime()) / 1000));
  const h = Math.floor(diffSec / 3600);
  const m = Math.floor((diffSec % 3600) / 60);
  const s = diffSec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function timerCard(row) {
  const card = el('div', 'timer-card' + (row.onShift ? ' live' : ''));
  card.innerHTML = `
    <div class="tc-name">${esc(row.name)}${row.role ? ` <span class="tc-role">· ${esc(row.role)}</span>` : ''}</div>
    <div class="tc-ring"><div class="tc-hours">${fmtHours(row.hours)}</div><div class="tc-label">שעות החודש</div></div>
    <div class="tc-sessions">${row.sessions} כניסות החודש</div>
    ${row.onShift ? `<div class="tc-live"><span class="tc-dot"></span>מחוברת כרגע · <span class="tc-live-clock" data-since="${esc(row.liveSince)}">00:00:00</span></div>` : ''}`;
  return card;
}

function tickLiveClocks() {
  document.querySelectorAll('.tc-live-clock').forEach((el2) => {
    el2.textContent = liveElapsedLabel(el2.dataset.since);
  });
}

async function renderAttendance(main) {
  if (ATTENDANCE_LIVE_TIMER) { clearInterval(ATTENDANCE_LIVE_TIMER); ATTENDANCE_LIVE_TIMER = null; }
  const manager = isManagerRole(USER.role);
  if (!ATTENDANCE_MONTH) ATTENDANCE_MONTH = (CTX.today || new Date().toISOString().slice(0, 10)).slice(0, 7);

  const data = await api(`/api/attendance/summary?month=${ATTENDANCE_MONTH}`);
  const [y, mo] = ATTENDANCE_MONTH.split('-').map(Number);

  main.innerHTML = '';
  const nav = el('div', 'cal-nav');
  const prev = el('button', 'btn-secondary btn-sm', 'החודש הקודם ‹');
  const next = el('button', 'btn-secondary btn-sm', '› החודש הבא');
  const title = el('div', 'cal-title', `<strong>${GREG_MONTHS[mo - 1]} ${y}</strong>`);
  prev.addEventListener('click', () => {
    let nm = mo - 1, ny = y; if (nm < 1) { nm = 12; ny--; }
    ATTENDANCE_MONTH = `${ny}-${String(nm).padStart(2, '0')}`;
    render();
  });
  next.addEventListener('click', () => {
    let nm = mo + 1, ny = y; if (nm > 12) { nm = 1; ny++; }
    ATTENDANCE_MONTH = `${ny}-${String(nm).padStart(2, '0')}`;
    render();
  });
  nav.append(next, title, prev);
  main.append(nav);

  const grid = el('div', 'timer-grid');
  data.rows.forEach((row) => {
    const card = timerCard(row);
    if (manager) {
      card.style.cursor = 'pointer';
      card.title = 'לחיצה לפירוט כניסות ויציאות';
      card.addEventListener('click', async () => {
        document.querySelectorAll('.attendance-detail-box').forEach((b) => b.remove());
        const detail = await api(`/api/attendance/detail?month=${ATTENDANCE_MONTH}&user=${encodeURIComponent(row.name)}`);
        const box = el('div', 'card attendance-detail-box');
        box.append(el('div', 'section-title', `📋 פירוט כניסות ויציאות — ${esc(row.name)}`), attendanceDetailTable(detail.rows));
        main.append(box);
        box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    }
    grid.append(card);
  });
  if (!data.rows.length) grid.append(el('div', 'empty-state', 'אין עדיין נתוני נוכחות לחודש הזה'));
  main.append(grid);

  if (!manager && data.rows.length) {
    main.append(el('div', 'section-title', '📋 פירוט כניסות ויציאות'));
    const detail = await api(`/api/attendance/detail?month=${ATTENDANCE_MONTH}`);
    main.append(attendanceDetailTable(detail.rows));
  }

  if (document.querySelectorAll('.tc-live-clock').length) {
    tickLiveClocks();
    ATTENDANCE_LIVE_TIMER = setInterval(tickLiveClocks, 1000);
  }
}

function attendanceDetailTable(rows) {
  const t = el('table', 'data');
  t.innerHTML = '<tr><th>כניסה</th><th>יציאה</th><th>משך</th></tr>' +
    (rows.length ? rows.map((r) => `<tr>
      <td>${esc((r.check_in || '').slice(0, 16))}</td>
      <td>${r.check_out ? esc(r.check_out.slice(0, 16)) : '<span class="badge-live">מחוברת כעת</span>'}</td>
      <td>${fmtHours(r.hours)}</td>
    </tr>`).join('') : '<tr><td colspan="3" class="muted">אין נתונים</td></tr>');
  return t;
}

/* ===================== ניהול ===================== */
async function renderAdmin(main) {
  const [templates, users, report] = await Promise.all([
    api('/api/templates'), api('/api/users'), api('/api/reports/summary'),
  ]);
  // רשימת הדרגות מגיעה מהשרת; אם השדה חסר — נופלים לסדר המקומי
  let roleList = ROLE_ORDER;
  try {
    const r = await api('/api/permissions');
    if (Array.isArray(r.roles) && r.roles.length) roleList = r.roles;
  } catch { /* לא קריטי */ }
  main.innerHTML = '';

  main.append(el('div', 'section-title', '📊 ביצוע משימות – 30 הימים האחרונים'));
  const repT = el('table', 'data');
  repT.innerHTML = '<tr><th>קטגוריה</th><th>סה"כ</th><th>בוצעו</th><th>אחוז</th></tr>' +
    report.byCat.map((r) => `<tr><td>${catIcon(r.category)} ${esc(r.category)}</td><td>${r.total}</td><td>${r.done}</td>
      <td>${r.total ? Math.round((r.done / r.total) * 100) : 0}%</td></tr>`).join('');
  main.append(repT);

  main.append(el('div', 'section-title', '👥 צוות'));
  const uT = el('table', 'data');
  uT.innerHTML = '<tr><th>שם</th><th>תפקיד</th><th>קוד</th><th>פעילה</th><th></th></tr>' +
    users.map((u) => `<tr class="${u.active ? '' : 'inactive'}" data-uid="${u.id}">
      <td>${esc(u.name)}</td>
      <td><select class="in u-role" style="min-width:120px">${roleList.map((r) => `<option${r === u.role ? ' selected' : ''}>${esc(r)}</option>`).join('')}</select></td>
      <td><input class="in u-code" value="${esc(u.code)}" style="max-width:120px" inputmode="numeric"></td>
      <td><input type="checkbox" class="u-active"${u.active ? ' checked' : ''}></td>
      <td><button class="btn-secondary btn-sm u-save">שמירה</button></td>
    </tr>`).join('');
  main.append(uT);
  const uErr = el('div', 'err-line');
  main.append(uErr);
  // עדכון עובדת — בעיקר כדי שאפשר יהיה להחליף את קוד הגיבוי בקוד משלך
  uT.addEventListener('click', async (e) => {
    const btn = e.target.closest('.u-save');
    if (!btn) return;
    const tr = btn.closest('tr');
    uErr.textContent = '';
    try {
      const r = await api('/api/users/' + tr.dataset.uid, { method: 'PATCH', body: {
        role: tr.querySelector('.u-role').value,
        code: tr.querySelector('.u-code').value.trim(),
        active: tr.querySelector('.u-active').checked ? 1 : 0,
      } });
      toast(`${r.user.name} עודכנה`, 'ok');
      tr.classList.toggle('inactive', !r.user.active);
    } catch (err) { uErr.textContent = err.message; toast(err.message, 'err'); }
  });
  const uForm = el('div', 'card');
  uForm.innerHTML = `
    <div class="section-title" style="margin-top:0">הוספת עובדת</div>
    <div class="row">
      <input id="nu-name" class="in grow" placeholder="שם">
      <select id="nu-role" class="in" style="max-width:130px">${roleList.map((r) => `<option>${esc(r)}</option>`).join('')}</select>
      <input id="nu-code" class="in" placeholder="קוד כניסה" style="max-width:130px">
      <button class="btn-primary" id="nu-btn">הוספה</button>
    </div>
    <div id="nu-err" class="err-line"></div>`;
  main.append(uForm);
  $('#nu-btn').addEventListener('click', async () => {
    try {
      await api('/api/users', { method: 'POST', body: { name: $('#nu-name').value.trim(), role: $('#nu-role').value, code: $('#nu-code').value.trim() } });
      toast('העובדת נוספה', 'ok'); render();
    } catch (e) { $('#nu-err').textContent = e.message; }
  });

  // קישור ללוח הקמפיין החי (דשבורד/אישורים/מוקדים/יומן) — נשאר מסך נפרד, תפעולי יומיומי
  if ((USER.features || []).includes('campaign')) {
    const campaignLink = el('div', 'card');
    campaignLink.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap';
    campaignLink.innerHTML = `
      <div>
        <div class="section-title" style="margin:0">🎗 קמפיין המכירה הסינית</div>
        <div class="sub muted">לוח בקרה חי, אישורי נקודות, מוקדים ויומן פעולות</div>
      </div>
      <a href="/campaign.html" class="btn-primary">ללוח הקמפיין ←</a>`;
    main.append(campaignLink);
  }
  // ניהול הקמפיין עצמו (מתנות/מוקדים/הגדרות/ייבוא) — כאן, לפי הרשאה לכל פעולה בנפרד
  await renderCampaignAdminCards(main);

  // מטריצת ההרשאות (כולל גישה לקמפיין) — ממש ליד יצירת המשתמשת, לא בסוף העמוד הארוך
  if ((USER.features || []).includes('admin') || isManagerRole(USER.role)) {
    await renderPermissions(main);
  }

  main.append(el('div', 'section-title', '🔁 תבניות משימות'));
  const SCOPES = SCOPE_ORDER;
  // שמות הצוות לבורר "אחראית" — נשלפים פעם אחת ומשמשים גם בטבלה וגם בטופס
  let teamNames = [];
  try { teamNames = await api('/api/users/names'); } catch { /* לא קריטי */ }
  // רשימת הקטגוריות = הקבועות במערכת + כל מה שכבר קיים בתבניות
  const catList = [...new Set([...Object.keys(CAT_EMOJI), ...templates.map((t) => t.category).filter(Boolean)])];

  const tplBox = el('div', 'tpl-box');
  tplBox.innerHTML = `
    <div class="tpl-filters">
      <div class="tpl-search-row">
        <input id="tpl-q" class="in grow" type="search" placeholder="🔍 חיפוש לפי שם משימה או קטגוריה…" value="${esc(TPL_SEARCH)}">
        <button class="btn-secondary btn-sm" id="tpl-clear" title="ניקוי החיפוש והסינון">ניקוי</button>
      </div>
      <div class="tpl-chips">${
        [['all', 'הכל'], ...FREQ_ORDER.map((f) => [f, FREQ_HE[f]])]
          .map(([v, l]) => `<button class="tpl-chip${TPL_FREQ === v ? ' on' : ''}" data-freq="${v}">${esc(l)}</button>`).join('')
      }</div>
      <div class="tpl-own" id="tpl-own">
        <span class="tpl-own-lbl">שיוך אחראית:</span>
        ${[['all', 'כל התבניות'], ['none', '👤 ללא אחראית'], ['some', '✓ יש אחראית']]
          .map(([v, l]) => `<button class="tpl-chip${TPL_OWNER === v ? ' on' : ''}" data-own="${v}">${esc(l)}</button>`).join('')}
        <span class="tpl-own-bar" id="tpl-own-bar"></span>
      </div>
      <div class="tpl-count" id="tpl-count"></div>
    </div>
    <div class="tpl-bulk" id="tpl-bulk">
      <label class="tpl-bulk-all"><input type="checkbox" id="tpl-all"> סימון כל המוצגות</label>
      <span class="tpl-bulk-n" id="tpl-bulk-n">לא נבחרו תבניות</span>
      <select id="tpl-bulk-scope" class="in" style="max-width:190px">
        <option value="">— שיוך —</option>
        ${SCOPES.map((s) => `<option>${esc(s)}</option>`).join('')}
      </select>
      <select id="tpl-bulk-who" class="in" style="max-width:200px">
        <option value="">— אחראית —</option>
        <option value="__none__">ללא — לכל האחמ"שיות</option>
        ${teamNames.map((n) => `<option>${esc(n)}</option>`).join('')}
      </select>
      <button class="btn-primary btn-sm" id="tpl-bulk-go">החלה על המסומנות</button>
    </div>
    <div id="tpl-rows"></div>`;
  main.append(tplBox);

  const rowsBox = tplBox.querySelector('#tpl-rows');
  const countBox = tplBox.querySelector('#tpl-count');

  const matches = (t) => {
    if (TPL_FREQ !== 'all' && t.frequency !== TPL_FREQ) return false;
    // סינון לפי מצב השיוך — כדי שאפשר יהיה לעבור על מה שעדיין לא שויך עד שנגמר
    if (TPL_OWNER === 'none' && t.assignee) return false;
    if (TPL_OWNER === 'some' && !t.assignee) return false;
    const q = TPL_SEARCH.trim().toLowerCase();
    if (!q) return true;
    return `${t.title || ''} ${t.category || ''} ${t.assignee || ''}`.toLowerCase().includes(q);
  };

  // מונה התקדמות השיוך: כמה תבניות כבר קיבלו אחראית מתוך הכל
  function paintOwnProgress() {
    const withOwner = templates.filter((t) => t.assignee).length;
    const total = templates.length;
    const pct = total ? Math.round((withOwner / total) * 100) : 0;
    const bar = tplBox.querySelector('#tpl-own-bar');
    if (!bar) return;
    bar.innerHTML = `<span class="tob-track"><span class="tob-fill" style="width:${pct}%"></span></span>
      <b>${withOwner} מתוך ${total}</b> שויכו${withOwner === total && total ? ' 🎉' : ''}`;
  }

  function paintTemplates() {
    const shown = templates.filter(matches);
    countBox.textContent = shown.length === templates.length
      ? `מוצגות כל ${templates.length} התבניות`
      : `מוצגות ${shown.length} מתוך ${templates.length}`;
    if (!shown.length) {
      // כשמסננים "ללא אחראית" ואין תוצאות — זו בשורה טובה, לא כישלון חיפוש
      rowsBox.innerHTML = (TPL_OWNER === 'none' && !TPL_SEARCH.trim() && TPL_FREQ === 'all')
        ? '<div class="empty-state">🎉 כל התבניות שויכו לאחראית — לא נשארה אף אחת ללא שיוך.</div>'
        : '<div class="empty-state">לא נמצאו תבניות שמתאימות לחיפוש. נסי מילה אחרת או לחצי "ניקוי".</div>';
      paintBulk();
      paintOwnProgress();
      return;
    }
    const t2 = el('table', 'data tpl-table');
    t2.innerHTML = '<tr><th class="tpl-pick"></th><th>משימה</th><th>קטגוריה</th><th>תדירות</th><th>עדיפות</th><th>שיוך</th><th>אחראית אישית</th><th></th></tr>' +
      shown.map((t) => `<tr class="${t.active ? '' : 'inactive'}" data-row="${t.id}">
        <td class="tpl-pick"><input type="checkbox" class="tpl-sel" data-tpl="${t.id}" ${TPL_SELECTED.has(t.id) ? 'checked' : ''}></td>
        <td><input class="in tpl-title" data-tpl="${t.id}" value="${esc(t.title)}">${t.assignee ? `<span class="tpl-personal">👤 ${esc(t.assignee)}</span>` : ''}</td>
        <td><span class="tpl-cat-icon">${catIcon(t.category)}</span><select class="in tpl-cat" data-tpl="${t.id}">${
          catList.map((c) => `<option ${t.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')
        }</select></td>
        <td><select class="in tpl-freq" data-tpl="${t.id}">${
          FREQ_ORDER.map((f) => `<option value="${f}" ${t.frequency === f ? 'selected' : ''}>${FREQ_HE[f]}</option>`).join('')
        }</select></td>
        <td><select class="in tpl-pr" data-tpl="${t.id}">${PRIORITIES.map((p) => `<option ${t.priority === p ? 'selected' : ''}>${p}</option>`).join('')}</select></td>
        <td><select class="in tpl-scope" data-tpl="${t.id}">${SCOPES.map((s) => `<option ${(t.scope || DEFAULT_SCOPE) === s ? 'selected' : ''}>${s}</option>`).join('')}</select></td>
        <td><select class="in tpl-who" data-tpl="${t.id}"><option value="">ללא — לכל האחמ"שיות</option>${
          teamNames.map((n) => `<option ${t.assignee === n ? 'selected' : ''}>${esc(n)}</option>`).join('')
        }</select></td>
        <td><button class="btn-secondary btn-sm" data-tpl-toggle="${t.id}" data-active="${t.active}">${t.active ? 'השבתה' : 'הפעלה'}</button></td>
      </tr>`).join('');
    rowsBox.innerHTML = '';
    rowsBox.append(t2);
    paintBulk();
    paintOwnProgress();
  }

  // --- שיוך מרוכז: סימון כמה תבניות והחלת שיוך/אחראית על כולן בבת אחת ---
  const bulkN = tplBox.querySelector('#tpl-bulk-n');
  function paintBulk() {
    // מנקים מהבחירה תבניות שכבר לא מוצגות בסינון הנוכחי
    const visibleIds = new Set(templates.filter(matches).map((t) => t.id));
    [...TPL_SELECTED].forEach((id) => { if (!visibleIds.has(id)) TPL_SELECTED.delete(id); });
    const n = TPL_SELECTED.size;
    bulkN.textContent = n ? `${n} תבניות מסומנות` : 'לא נבחרו תבניות';
    bulkN.classList.toggle('on', n > 0);
    const allBox = tplBox.querySelector('#tpl-all');
    allBox.checked = n > 0 && n === visibleIds.size;
    tplBox.querySelector('#tpl-bulk-go').disabled = !n;
  }

  rowsBox.addEventListener('change', (e) => {
    const box = e.target.closest('.tpl-sel');
    if (!box) return;
    const id = +box.dataset.tpl;
    box.checked ? TPL_SELECTED.add(id) : TPL_SELECTED.delete(id);
    paintBulk();
  });

  tplBox.querySelector('#tpl-all').addEventListener('change', (e) => {
    const shown = templates.filter(matches);
    if (e.target.checked) shown.forEach((t) => TPL_SELECTED.add(t.id));
    else shown.forEach((t) => TPL_SELECTED.delete(t.id));
    paintTemplates();
  });

  tplBox.querySelector('#tpl-bulk-go').addEventListener('click', async () => {
    const scope = tplBox.querySelector('#tpl-bulk-scope').value;
    const whoRaw = tplBox.querySelector('#tpl-bulk-who').value;
    if (!scope && !whoRaw) { toast('בחרי שיוך או אחראית להחלה', 'err'); return; }
    const ids = [...TPL_SELECTED];
    const body = { ids };
    if (scope) body.scope = scope;
    if (whoRaw) body.assignee = whoRaw === '__none__' ? '' : whoRaw;
    try {
      const r = await api('/api/templates/bulk', { method: 'POST', body });
      toast(`עודכנו ${r.changed} תבניות`, 'ok');
      TPL_SELECTED.clear();
      render();
    } catch (e) { toast(e.message || 'העדכון נכשל', 'err'); }
  });

  paintTemplates();

  // שמירת שדה בודד: מעדכן בשרת, מסנכרן את העותק המקומי ומצייר מחדש בלי לאבד חיפוש/גלילה
  async function saveField(id, patch, okMsg) {
    const tpl = templates.find((x) => String(x.id) === String(id));
    const before = tpl ? { ...tpl } : null;
    try {
      const res = await api('/api/templates/' + id, { method: 'PATCH', body: patch });
      if (tpl) Object.assign(tpl, res.template || patch);
      toast(okMsg, 'ok');
    } catch (e) {
      if (tpl && before) Object.assign(tpl, before);
      toast(e.message || 'השמירה נכשלה', 'err');
    }
    const y = window.scrollY;
    paintTemplates();
    window.scrollTo({ top: y, behavior: 'instant' });
  }

  tplBox.querySelector('#tpl-q').addEventListener('input', (e) => { TPL_SEARCH = e.target.value; paintTemplates(); });
  // שני סרגלי הצ'יפים (תדירות ומצב שיוך) חולקים את המחלקה .tpl-chip —
  // ולכן כל סימון "on" מוגבל לסרגל שלו בלבד, אחרת לחיצה באחד הייתה מכבה את השני
  const freqBar = tplBox.querySelector('.tpl-chips');
  const ownBar = tplBox.querySelector('#tpl-own');
  const markOn = (bar, attr, val) =>
    $$('.tpl-chip', bar).forEach((c) => c.classList.toggle('on', c.dataset[attr] === val));

  tplBox.querySelector('#tpl-clear').addEventListener('click', () => {
    TPL_SEARCH = ''; TPL_FREQ = 'all'; TPL_OWNER = 'all';
    tplBox.querySelector('#tpl-q').value = '';
    markOn(freqBar, 'freq', 'all');
    markOn(ownBar, 'own', 'all');
    paintTemplates();
  });
  freqBar.addEventListener('click', (e) => {
    const c = e.target.closest('.tpl-chip');
    if (!c) return;
    TPL_FREQ = c.dataset.freq;
    markOn(freqBar, 'freq', TPL_FREQ);
    paintTemplates();
  });
  ownBar.addEventListener('click', (e) => {
    const c = e.target.closest('.tpl-chip');
    if (!c) return;
    TPL_OWNER = c.dataset.own;
    markOn(ownBar, 'own', TPL_OWNER);
    paintTemplates();
  });
  rowsBox.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-tpl-toggle]');
    if (!b) return;
    await saveField(b.dataset.tplToggle, { active: b.dataset.active !== '1' }, b.dataset.active !== '1' ? 'התבנית הופעלה' : 'התבנית הושבתה');
  });
  rowsBox.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.classList.contains('tpl-freq'))  return saveField(t.dataset.tpl, { frequency: t.value }, 'התדירות עודכנה');
    if (t.classList.contains('tpl-cat'))   return saveField(t.dataset.tpl, { category: t.value }, 'הקטגוריה עודכנה');
    if (t.classList.contains('tpl-pr'))    return saveField(t.dataset.tpl, { priority: t.value }, 'העדיפות עודכנה');
    if (t.classList.contains('tpl-scope')) return saveField(t.dataset.tpl, { scope: t.value }, 'השיוך עודכן');
    if (t.classList.contains('tpl-who'))   return saveField(t.dataset.tpl, { assignee: t.value || null }, t.value ? `המשימה שויכה ל${t.value}` : 'המשימה חזרה לכל האחמ"שיות');
  });
  // כותרת: שמירה ביציאה מהשדה או ב-Enter, ורק אם באמת השתנתה
  async function commitTitle(input) {
    const tpl = templates.find((x) => String(x.id) === String(input.dataset.tpl));
    const val = input.value.trim();
    if (!tpl || !val || val === tpl.title) { if (tpl) input.value = tpl.title; return; }
    await saveField(input.dataset.tpl, { title: val }, 'הכותרת עודכנה');
  }
  rowsBox.addEventListener('focusout', (e) => {
    if (e.target.classList && e.target.classList.contains('tpl-title')) commitTitle(e.target);
  });
  rowsBox.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.classList || !e.target.classList.contains('tpl-title')) return;
    e.preventDefault();
    commitTitle(e.target);
  });

  const tForm = el('div', 'card');
  tForm.innerHTML = `
    <div class="section-title" style="margin-top:0">משימה מחזורית חדשה</div>
    <div class="row">
      <input id="nt-title" class="in grow" placeholder="כותרת המשימה">
      <select id="nt-cat" class="in" style="max-width:190px" title="קטגוריה">
        ${catList.map((c) => `<option value="${esc(c)}">${catIcon(c)} ${esc(c)}</option>`).join('')}
        <option value="__new__">➕ קטגוריה חדשה…</option>
      </select>
      <input id="nt-cat-new" class="in hidden" placeholder="שם הקטגוריה החדשה" style="max-width:170px">
      <select id="nt-freq" class="in" style="max-width:130px">
        <option value="daily">יומי</option><option value="weekly">שבועי</option>
        <option value="biweekly">דו־שבועי</option><option value="monthly">חודשי</option>
        <option value="quarterly">רבעוני</option>
      </select>
      <select id="nt-pr" class="in" style="max-width:110px">${PRIORITIES.map((p) => `<option>${p}</option>`).join('')}</select>
      <select id="nt-scope" class="in" style="max-width:160px" title="שיוך">
        ${scopeOptions()}
      </select>
      <select id="nt-who" class="in" style="max-width:200px" title="אחראית קבועה למשימה"><option value="">ללא — לכל האחמ"שיות</option></select>
      <button class="btn-primary" id="nt-btn">הוספה</button>
    </div>
    <div class="sub muted" style="margin-top:8px">שיוך קובע מתי ומי: "תחילת משמרת" / "סוף משמרת" — צ׳ק-ליסט לכל הצוות · "מנהלת" סגור לעובדות · "מוקדנית בוקר" לכל מוקדנית · בחירת אחראית הופכת את המשימה ל"אישי" (רק היא והמנהלת רואות). אפשר לשנות שיוך לכל תבנית ישירות בטבלה למטה.</div>`;
  main.append(tForm);
  fillNamesSelect('#nt-who');
  // "קטגוריה חדשה…" חושף שדה טקסט; בכל שאר המקרים בוחרים מתוך הקיימות
  $('#nt-cat').addEventListener('change', () => {
    const isNew = $('#nt-cat').value === '__new__';
    $('#nt-cat-new').classList.toggle('hidden', !isNew);
    if (isNew) $('#nt-cat-new').focus();
  });
  $('#nt-btn').addEventListener('click', async () => {
    const sel = $('#nt-cat').value;
    const category = sel === '__new__' ? $('#nt-cat-new').value.trim() : sel;
    if (!category) { toast('בחרי קטגוריה או הקלידי שם לקטגוריה חדשה', 'err'); return; }
    try {
      await api('/api/templates', { method: 'POST', body: {
        title: $('#nt-title').value.trim(), category,
        frequency: $('#nt-freq').value, priority: $('#nt-pr').value,
        assignee: $('#nt-who')?.value || null, scope: $('#nt-scope')?.value || DEFAULT_SCOPE } });
      toast('התבנית נוספה', 'ok'); render();
    } catch (e) { toast(e.message || 'לא ניתן להוסיף את התבנית', 'err'); }
  });

  main.append(el('div', 'section-title', '🕐 יומן פעולות אחרון (Audit)'));
  const aT = el('table', 'data');
  aT.innerHTML = '<tr><th>מי</th><th>פעולה</th><th>מתי</th></tr>' +
    report.auditTail.map((a) => `<tr><td>${esc(a.user_name || '')}</td><td>${esc(a.action)}</td><td>${esc(a.at)}</td></tr>`).join('');
  main.append(aT);
}

/* ---- ניהול הקמפיין (מתנות/מוקדים/הגדרות/ייבוא) — כאן במסך הניהול הראשי, לפי הרשאה לכל פעולה ---- */
async function renderCampaignAdminCards(main) {
  const feats = USER.features || [];
  const canPrizes = feats.includes('campaign_prizes');
  const canHubs = feats.includes('campaign_hubs');
  const canSettings = feats.includes('campaign_settings');
  const canImport = feats.includes('campaign_import');
  if (!canPrizes && !canHubs && !canSettings && !canImport) return;

  let data, geoLeaves = [];
  try {
    [data, geoLeaves] = await Promise.all([
      api('/api/campaign/dashboard'),
      api('/api/campaign/geo-leaves').catch(() => []),
    ]);
  } catch { return; }

  main.append(el('div', 'section-title', '🎗 ניהול קמפיין המכירה הסינית'));

  if (canImport) {
    const unidentified = data.volunteers.filter((v) => !v.name);
    const card = el('div', 'card');
    card.innerHTML = `
      <div class="section-title" style="margin-top:0">מתנדבות שעדיין לא זוהו בשם</div>
      <table class="data" id="ca-unident"><tr><th>טלפון</th><th>קביעת שם</th></tr>${
        unidentified.map((v) => `<tr><td>${esc(v.phone)}</td><td>
          <input class="in" id="ca-name-${v.id}" placeholder="שם המתנדבת" style="max-width:150px">
          <button class="btn-secondary btn-sm" data-vol="${v.id}">שמירה</button></td></tr>`).join('')
      }</table>
      ${!unidentified.length ? '<div class="empty-state">כל המתנדבות מזוהות בשם</div>' : ''}
      <div class="row" style="margin-top:12px">
        <label class="btn-secondary" style="cursor:pointer">📥 ייבוא רשימת מתנדבות מאקסל<input type="file" id="ca-imp-vol" accept=".xlsx,.xls,.csv" class="hidden"></label>
        <span class="sub muted">עמודות: טלפון, שם</span>
      </div>
      <div id="ca-imp-vol-result" class="sub muted"></div>
      <div class="row" style="margin-top:12px">
        <label class="btn-secondary" style="cursor:pointer">📥 ייבוא דיווחי גיוס מוצרים מאקסל<input type="file" id="ca-imp-rec" accept=".xlsx,.xls,.csv" class="hidden"></label>
        <span class="sub muted">טלפון+שווי → נקודות אוטומטיות (לפי אחוז המרה בהגדרות)</span>
      </div>
      <div id="ca-imp-rec-result" class="sub muted"></div>`;
    main.append(card);
    card.querySelectorAll('[data-vol]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = $(`#ca-name-${btn.dataset.vol}`).value.trim();
        try { await api(`/api/campaign/volunteers/${btn.dataset.vol}`, { method: 'PUT', body: { name } }); toast('נשמר', 'ok'); render(); }
        catch (e) { toast(e.message || 'השמירה נכשלה', 'err'); }
      });
    });
    campaignFileImport('ca-imp-vol', '/api/campaign/import/volunteers', 'ca-imp-vol-result');
    campaignFileImport('ca-imp-rec', '/api/campaign/import/recruitment', 'ca-imp-rec-result');
  }

  if (canPrizes) {
    const card = el('div', 'card');
    card.innerHTML = `
      <div class="section-title" style="margin-top:0">קטלוג מתנות בנקודות</div>
      <div class="row">
        <input id="ca-pz-code" class="in" placeholder="קוד מוצר" style="max-width:100px">
        <input id="ca-pz-name" class="in" placeholder="שם המתנה" style="max-width:180px">
        <input id="ca-pz-value" class="in" placeholder="שווי בש״ח" style="max-width:100px">
        <input id="ca-pz-points" class="in" placeholder="עלות בנקודות" style="max-width:110px">
        <button class="btn-primary" id="ca-pz-add">הוספת מתנה</button>
      </div>
      <table class="data"><tr><th>קוד</th><th>שם</th><th>שווי</th><th>נקודות</th><th>פעיל</th><th></th></tr>${
        data.prizes.map((pr) => `<tr>
          <td>${pr.code}</td><td>${esc(pr.name)}</td><td>${pr.value_nis ?? '—'}</td><td>${pr.points_cost}</td>
          <td><button class="btn-secondary btn-sm" data-toggle-prize="${pr.id}">${pr.active ? '✓ פעיל' : 'לא פעיל'}</button></td>
          <td><button class="btn-secondary btn-sm" data-del-prize="${pr.id}">מחיקה</button></td>
        </tr>`).join('')
      }</table>
      ${canImport ? `<div class="row" style="margin-top:12px">
        <label class="btn-secondary" style="cursor:pointer">📥 ייבוא קטלוג מתנות מאקסל<input type="file" id="ca-imp-prz" accept=".xlsx,.xls,.csv" class="hidden"></label>
        <span class="sub muted">עמודות: קוד, שם, שווי, נקודות — נכנס לא-פעיל לבדיקה</span>
      </div><div id="ca-imp-prz-result" class="sub muted"></div>` : ''}`;
    main.append(card);
    $('#ca-pz-add').addEventListener('click', async () => {
      try {
        await api('/api/campaign/prizes', { method: 'POST', body: {
          code: $('#ca-pz-code').value, name: $('#ca-pz-name').value,
          value_nis: $('#ca-pz-value').value, points_cost: $('#ca-pz-points').value,
        } });
        toast('המתנה נוספה', 'ok'); render();
      } catch (e) { toast(e.message || 'ההוספה נכשלה', 'err'); }
    });
    card.querySelectorAll('[data-toggle-prize]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const target = data.prizes.find((p) => p.id === Number(btn.dataset.togglePrize));
        try {
          await api(`/api/campaign/prizes/${target.id}`, { method: 'PUT', body: {
            name: target.name, value_nis: target.value_nis, points_cost: target.points_cost, active: !target.active,
          } });
          render();
        } catch (e) { toast(e.message || 'העדכון נכשל', 'err'); }
      });
    });
    card.querySelectorAll('[data-del-prize]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('למחוק את המתנה?')) return;
        await api(`/api/campaign/prizes/${btn.dataset.delPrize}`, { method: 'DELETE' });
        render();
      });
    });
    if (canImport) campaignFileImport('ca-imp-prz', '/api/campaign/import/prizes', 'ca-imp-prz-result');
  }

  if (canHubs) {
    const card = el('div', 'card');
    card.innerHTML = `
      <div class="section-title" style="margin-top:0">מוקדי הפצה — הוספה</div>
      <p class="sub muted">קוד המוקד מתמספר אוטומטית. "אזור בשלוחת ימות" הוא מה שהמתנדבת שומעת בטלפון.</p>
      <div class="row">
        <input id="ca-hub-name" class="in" placeholder="שם המוקד" style="max-width:160px">
        <input id="ca-hub-total" class="in" placeholder="כמות ערכות" style="max-width:100px">
        <select id="ca-hub-area" class="in" style="max-width:200px"><option value="">— ללא אזור בשלוחה —</option></select>
      </div>
      <div class="row">
        <input id="ca-hub-pickup" class="in grow" placeholder="פרטי מסירה שיוקראו בטלפון">
        <button class="btn-primary" id="ca-hub-add">הוספת מוקד</button>
      </div>`;
    main.append(card);
    const areaSel = $('#ca-hub-area');
    geoLeaves.forEach((leaf) => {
      const opt = el('option', '', leaf.label);
      opt.value = leaf.path;
      areaSel.append(opt);
    });
    $('#ca-hub-add').addEventListener('click', async () => {
      try {
        const r = await api('/api/campaign/hubs', { method: 'POST', body: {
          name: $('#ca-hub-name').value, kits_total: $('#ca-hub-total').value,
          area_path: $('#ca-hub-area').value, pickup_info: $('#ca-hub-pickup').value,
        } });
        toast(`המוקד נוסף — קוד PIN: ${r.pin}`, 'ok'); render();
      } catch (e) { toast(e.message || 'ההוספה נכשלה', 'err'); }
    });
  }

  if (canSettings) {
    const s = data.settings;
    const card = el('div', 'card');
    card.innerHTML = `
      <div class="section-title" style="margin-top:0">מיתוג הקמפיין</div>
      <div class="row">
        <div><label class="sub muted">לוגו</label><br><input type="file" id="ca-logo" accept="image/*"></div>
        <div><label class="sub muted">צבע עיקרי</label><br><input type="color" id="ca-c1" value="${esc(s.campaign_brand_primary || '#14497c')}"></div>
        <div><label class="sub muted">צבע הדגשה</label><br><input type="color" id="ca-c2" value="${esc(s.campaign_brand_accent || '#1e5fa8')}"></div>
        <div><label class="sub muted">צבע כהה</label><br><input type="color" id="ca-c3" value="${esc(s.campaign_brand_dark || '#0b2a4a')}"></div>
      </div>
      <button class="btn-secondary" id="ca-save-brand" style="margin-top:10px">שמירת מיתוג</button>
      <div class="section-title">נקודות וחישובים</div>
      <p class="sub muted">שינוי כאן חל מיידית גם בטלפון, בלי תכנות.</p>
      <div class="row">
        <div><label class="sub muted">נקודות לפנייה לעסק</label><br><input type="number" class="in" id="ca-pts-out" style="max-width:90px" value="${esc(s.campaign_points_outreach ?? 2)}"></div>
        <div><label class="sub muted">נקודות לשליחות</label><br><input type="number" class="in" id="ca-pts-err" style="max-width:90px" value="${esc(s.campaign_points_errand ?? 4)}"></div>
        <div><label class="sub muted">אחוז בונוס יעד שבועי</label><br><input type="number" class="in" id="ca-goal-bonus" style="max-width:90px" value="${esc(s.campaign_goal_bonus_percent ?? 10)}"></div>
        <div><label class="sub muted">אחוז המרה לגיוס מוצר</label><br><input type="number" class="in" id="ca-conv" placeholder="ריק = אין" style="max-width:130px" value="${esc(s.campaign_product_conversion_percent ?? '')}"></div>
      </div>
      <button class="btn-secondary" id="ca-save-calc" style="margin-top:10px">שמירת הגדרות נקודות</button>`;
    main.append(card);
    $('#ca-save-brand').addEventListener('click', async () => {
      const payload = { campaign_brand_primary: $('#ca-c1').value, campaign_brand_accent: $('#ca-c2').value, campaign_brand_dark: $('#ca-c3').value };
      const file = $('#ca-logo').files[0];
      if (file) payload.campaign_brand_logo = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
      try { await api('/api/campaign/settings', { method: 'PUT', body: payload }); toast('המיתוג נשמר', 'ok'); }
      catch (e) { toast(e.message || 'השמירה נכשלה', 'err'); }
    });
    $('#ca-save-calc').addEventListener('click', async () => {
      try {
        await api('/api/campaign/settings', { method: 'PUT', body: {
          campaign_points_outreach: $('#ca-pts-out').value, campaign_points_errand: $('#ca-pts-err').value,
          campaign_goal_bonus_percent: $('#ca-goal-bonus').value, campaign_product_conversion_percent: $('#ca-conv').value,
        } });
        toast('ההגדרות נשמרו', 'ok');
      } catch (e) { toast(e.message || 'השמירה נכשלה', 'err'); }
    });
  }
}

function campaignFileImport(inputId, endpoint, resultId) {
  const input = $('#' + inputId);
  if (!input) return;
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    const resultBox = $('#' + resultId);
    resultBox.textContent = 'מייבאת...';
    try {
      const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });
      const r = await api(endpoint, { method: 'POST', body: { data } });
      const updatedPart = r.updated !== undefined ? `, עודכנו ${r.updated}` : '';
      resultBox.textContent = `נוספו ${r.added}${updatedPart}, דולגו ${r.skipped} (מתוך ${r.total} שורות)`;
      render();
    } catch (e) { resultBox.textContent = e.message || 'הייבוא נכשל'; }
    input.value = '';
  });
}

/* ===================== עוזרת AI ===================== */
const AI_HISTORY = []; // נשמר לזמן הסשן בלבד

async function renderAI(main) {
  main.innerHTML = `
    <div class="card chat-wrap">
      <div id="chat-log" class="chat-log">
        ${AI_HISTORY.length ? '' : `<div class="chat-msg bot">שלום! אני העוזרת של מערכת הגמ"ח ✦<br>
          אפשר לשאול אותי למשל: <i>"מה הכי דחוף היום?"</i>, <i>"מי מאחרת להחזיר שמלה?"</i>, <i>"כמה נכנס לקופה היום?"</i></div>`}
      </div>
      <div class="row chat-input-row">
        <input id="chat-q" class="in grow" placeholder="שאלי אותי כל דבר על המערכת…" autocomplete="off">
        <button class="btn-primary" id="chat-send">שליחה</button>
      </div>
      <div id="chat-err" class="err-line"></div>
    </div>`;

  const log = $('#chat-log');
  const addMsg = (role, text) => {
    const m = el('div', 'chat-msg ' + (role === 'user' ? 'me' : 'bot'));
    m.textContent = text;
    log.append(m);
    log.scrollTop = log.scrollHeight;
    return m;
  };
  AI_HISTORY.forEach((m) => addMsg(m.role === 'user' ? 'user' : 'bot', m.content));

  const send = async () => {
    const q = $('#chat-q').value.trim();
    if (!q) return;
    $('#chat-q').value = '';
    $('#chat-err').textContent = '';
    addMsg('user', q);
    const thinking = addMsg('bot', 'חושבת…');
    $('#chat-send').disabled = true;
    try {
      const r = await api('/api/integrations/ai/chat', { method: 'POST', body: { question: q, history: AI_HISTORY } });
      thinking.textContent = r.answer;
      AI_HISTORY.push({ role: 'user', content: q }, { role: 'assistant', content: r.answer });
    } catch (e) {
      thinking.remove();
      $('#chat-err').textContent = e.message;
    } finally {
      $('#chat-send').disabled = false;
      $('#chat-q').focus();
    }
  };
  $('#chat-send').addEventListener('click', send);
  $('#chat-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  $('#chat-q').focus();
}

/* ===================== חיבורים ===================== */
async function renderIntegrations(main) {
  const [settings, backup] = await Promise.all([
    api('/api/integrations/settings'),
    api('/api/integrations/backup/status'),
  ]);
  const yemotUrl = `${location.origin}/yemot`;
  main.innerHTML = `
    <div class="integ-grid">

      <div class="card">
        <div class="section-title" style="margin-top:0">☎️ ימות המשיח — שלוחה ללקוחות</div>
        <div class="sub">לקוחה שמתקשרת יכולה לשמוע את מצב ההזמנה שלה (זיהוי אוטומטי לפי הטלפון או ת"ז)
          או להשאיר בקשה לחזרה — שנכנסת ישר ללשונית ההודעות.</div>
        <div class="sub" style="margin-top:10px"><b>ההגדרה בימות המשיח:</b> בניהול השלוחה מגדירים
          <code>api_url=</code> לכתובת:</div>
        <div class="row" style="margin-top:6px">
          <input class="in grow" readonly value="${esc(yemotUrl)}" id="yemot-url">
          <button class="btn-secondary" id="yemot-copy">העתקה</button>
        </div>
        <div class="sub muted" style="margin-top:8px">שימי לב: כדי שימות המשיח יגיעו לשרת, המערכת צריכה כתובת חיצונית
          (כשנעלה לענן זה אוטומטי; בינתיים אפשר עם כלי כמו ngrok).</div>
      </div>

      <div class="card">
        <div class="section-title" style="margin-top:0">📧 מייל (Gmail)</div>
        <label class="fld">כתובת Gmail של הגמ"ח</label>
        <input class="in" id="set-gmail_user" value="${esc(settings.gmail_user)}" placeholder="gemach@gmail.com">
        <label class="fld">סיסמת אפליקציה (App Password)</label>
        <input class="in" id="set-gmail_app_password" type="password" value="${esc(settings.gmail_app_password)}" placeholder="16 תווים מהגדרות גוגל">
        <label class="fld">כתובת לדוחות (למשל יוטי)</label>
        <input class="in" id="set-report_email" value="${esc(settings.report_email)}" placeholder="report@example.com">
        <div class="row" style="margin-top:12px">
          <button class="btn-secondary" id="email-test">שליחת מייל בדיקה</button>
          <button class="btn-secondary" id="email-report">📊 שליחת דוח יומי עכשיו</button>
        </div>
        <label class="fld" style="display:flex;align-items:center;gap:8px;margin-top:14px">
          <input type="checkbox" id="set-daily_report_auto" ${settings.daily_report_auto === '1' ? 'checked' : ''} style="width:auto">
          שליחת דוח יומי אוטומטית (משימות + פעילות קמפיין)
        </label>
        <label class="fld">בשעה (0-23)</label>
        <input class="in" id="set-daily_report_hour" type="number" min="0" max="23" style="max-width:90px" value="${esc(settings.daily_report_hour || '20')}">
        <div class="sub muted" style="margin-top:8px">סיסמת אפליקציה מנפיקים בחשבון גוגל ← אבטחה ← אימות דו-שלבי ← סיסמאות אפליקציה.</div>
      </div>

      <div class="card">
        <div class="section-title" style="margin-top:0">✦ בוט AI (Claude)</div>
        <label class="fld">מפתח API של Anthropic</label>
        <input class="in" id="set-anthropic_api_key" type="password" value="${esc(settings.anthropic_api_key)}" placeholder="sk-ant-...">
        <div class="sub muted" style="margin-top:8px">מנפיקים מפתח ב-platform.claude.com. אחרי השמירה, לשונית
          "עוזרת AI" תדע לענות על שאלות מתוך נתוני המערכת בזמן אמת.</div>
      </div>

      <div class="card">
        <div class="section-title" style="margin-top:0">☁️ גיבוי לענן / דרייב</div>
        <label class="fld">תיקיית גיבוי (תיקייה שמסונכרנת ל-Google Drive / OneDrive)</label>
        <input class="in" id="set-backup_dir" value="${esc(settings.backup_dir)}" placeholder="G:\\My Drive\\GemachBackups">
        <label class="fld" style="display:flex;align-items:center;gap:8px;margin-top:12px">
          <input type="checkbox" id="set-backup_auto" ${settings.backup_auto === '1' ? 'checked' : ''} style="width:auto"> גיבוי אוטומטי כל 24 שעות
        </label>
        <div class="row" style="margin-top:12px">
          <button class="btn-secondary" id="backup-now">💾 גיבוי עכשיו</button>
        </div>
        <div class="sub" id="backup-list" style="margin-top:10px">${backup.files.length
          ? '<b>גיבויים אחרונים:</b><br>' + backup.files.map((f) => `${esc(f.name)} (${Math.round(f.size / 1024)}KB)`).join('<br>')
          : '<span class="muted">עדיין אין גיבויים</span>'}</div>
      </div>

      <div class="card">
        <div class="section-title" style="margin-top:0">🔄 עדכוני תוכנה אוטומטיים</div>
        <label class="fld">מקור עדכונים — תיקייה או כתובת אינטרנט</label>
        <input class="in" id="set-update_source" value="${esc(settings.update_source)}" placeholder="G:\\My Drive\\GemachUpdates או https://updates.example.com">
        <div class="sub muted" style="margin-top:8px">
          <b>תיקייה:</b> מניחים בה קובץ <code>GemachSystem-Setup-X.Y.Z.exe</code> חדש (למשל תיקיית דרייב משותפת) —
          בהפעלה הבאה התוכנה תציע להתעדכן. הנתונים נשמרים.<br>
          <b>כתובת אינטרנט:</b> שרת עדכונים (latest.yml) — ההורדה וההתקנה אוטומטיות.<br>
          שינוי המקור נכנס לתוקף בהפעלה הבאה של התוכנה.
        </div>
      </div>

      <div class="card">
        <div class="section-title" style="margin-top:0">🚚 מחירי משלוח</div>
        <label class="fld">מחיר משלוח הלוך (₪)</label>
        <input class="in" id="set-delivery_price" type="number" min="0" value="${esc(settings.delivery_price)}" placeholder="לדוגמה: 30">
        <label class="fld">מחיר משלוח חזור (₪) — ריק = כמו הלוך</label>
        <input class="in" id="set-delivery_price_back" type="number" min="0" value="${esc(settings.delivery_price_back)}" placeholder="ריק = אותו מחיר">
        <div class="sub muted" style="margin-top:8px">
          המחיר מתווסף אוטומטית לחיוב ההזמנה כשמסמנים משלוח הלוך ו/או חזור.
          הזמנה עם שני הכיוונים תחויב בשניהם.
        </div>
      </div>

      <div class="card">
        <div class="section-title" style="margin-top:0">◨ מודול מלאי והשכרה</div>
        <label class="sub" style="display:flex;align-items:center;gap:10px;font-size:1.05rem">
          <input type="checkbox" id="set-inventory_module" ${settings.inventory_module !== '0' ? 'checked' : ''}>
          המודול פעיל
        </label>
        <div class="sub muted" style="margin-top:8px">
          כשמכובה — לשונית "מלאי והשכרה" נעלמת לכולן (גם למנהלת), הכניסה הישירה לכתובת הדף נחסמת,
          וכל פעולות ההשכרה בשרת מוחזרות בשגיאה. <b>הנתונים נשמרים במלואם</b> וחוזרים בהפעלה מחדש.<br>
          המערכת עובדת אז כמערכת ניהול משימות בלבד.
        </div>
      </div>

      <div class="card">
        <div class="section-title" style="margin-top:0">⌨️ הזמנה לפי דגם (בלי ברקוד)</div>
        <label class="sub" style="display:flex;align-items:center;gap:10px;font-size:1.05rem">
          <input type="checkbox" id="set-manual_model_order" ${settings.manual_model_order !== '0' ? 'checked' : ''}>
          מותר להזמין בהקלדת קוד דגם בלבד
        </label>
        <div class="sub muted" style="margin-top:8px">
          כשמסומן — העובדת יכולה להקליד קוד דגם (למשל 533) ולבחור מתוך המידות
          <b>הפנויות בפועל</b> בתאריכי ההזמנה, בלי לסרוק ברקוד.<br>
          כשמכובה — ההזמנה אפשרית רק דרך ברקוד, וגם ניסיון לעקוף מהממשק נחסם בשרת.<br>
          כל הזמנה שנעשתה כך נרשמת ביומן הפעולות, כדי שתוכלי לבחון בהמשך אם זה מועיל.
        </div>
      </div>
    </div>

    <div class="row" style="margin-top:18px">
      <button class="btn-primary" id="integ-save">💾 שמירת כל ההגדרות</button>
      <span id="integ-msg" class="ok-line" style="margin:0"></span>
    </div>`;

  $('#yemot-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(yemotUrl).then(() => toast('הכתובת הועתקה', 'ok'));
  });

  const collect = () => ({
    gmail_user: $('#set-gmail_user').value.trim(),
    gmail_app_password: $('#set-gmail_app_password').value.trim(),
    report_email: $('#set-report_email').value.trim(),
    daily_report_auto: $('#set-daily_report_auto').checked ? '1' : '',
    daily_report_hour: $('#set-daily_report_hour').value.trim(),
    anthropic_api_key: $('#set-anthropic_api_key').value.trim(),
    backup_dir: $('#set-backup_dir').value.trim(),
    backup_auto: $('#set-backup_auto').checked ? '1' : '',
    update_source: $('#set-update_source').value.trim(),
    delivery_price: $('#set-delivery_price').value.trim(),
    delivery_price_back: $('#set-delivery_price_back').value.trim(),
    manual_model_order: $('#set-manual_model_order').checked ? '1' : '0',
    inventory_module: $('#set-inventory_module').checked ? '1' : '0',
  });
  const save = async () => { await api('/api/integrations/settings', { method: 'PUT', body: collect() }); };

  const invWas = settings.inventory_module !== '0';
  $('#integ-save').addEventListener('click', async () => {
    try {
      await save(); toast('ההגדרות נשמרו', 'ok'); $('#integ-msg').textContent = '✓ נשמר';
      // הדלקה/כיבוי של מודול המלאי משנה את התפריט — טוענים מחדש כדי שייכנס לתוקף מיד
      if ($('#set-inventory_module').checked !== invWas) setTimeout(() => location.reload(), 700);
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#email-test').addEventListener('click', async () => {
    try { await save(); await api('/api/integrations/email/test', { method: 'POST', body: {} }); toast('מייל בדיקה נשלח! בדקי את התיבה', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  });
  $('#email-report').addEventListener('click', async () => {
    try { await save(); const r = await api('/api/integrations/email/daily-report', { method: 'POST', body: {} }); toast('הדוח נשלח אל ' + r.to, 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  });
  $('#backup-now').addEventListener('click', async () => {
    try { await save(); const r = await api('/api/integrations/backup/now', { method: 'POST', body: {} }); toast('הגיבוי נשמר: ' + r.file, 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); }
  });
}

/* ===================== אירועי כניסה ===================== */
$('#login-btn').addEventListener('click', doLogin);
$('#login-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

boot();
