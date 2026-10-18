let USER = JSON.parse(localStorage.getItem('gemach_user') || 'null');

// ריחוף על תגית ניווט בצד מציג סיכום נתונים עדכני של הקטגוריה (title native — לא תלוי עיצוב)
function setNavTooltip(targetId, text) {
    const btn = document.querySelector(`.side-nav button[data-target="${targetId}"]`);
    if (btn) btn.title = text;
}

const TXN_TYPE_LABEL = { outreach: 'פנייה לעסק', errand: 'שליחות', product: 'גיוס מוצר', bonus: 'בונוס יעד', redeem: 'מימוש מתנה', manual: 'עדכון ידני' };
const STATUS_LABEL = { approved: 'מאושר', pending: 'ממתין', rejected: 'נדחה' };
const ACTION_LABEL = {
    'campaign.settings.update': 'עדכון הגדרות',
    'campaign.points.approve': 'אישור נקודות',
    'campaign.points.manual_adjust': 'עדכון נקודות ידני',
    'campaign.points.reject': 'דחיית דיווח',
    'campaign.volunteer.identify': 'קביעת שם מתנדבת',
    'campaign.prize.create': 'הוספת מתנה',
    'campaign.prize.update': 'עדכון מתנה',
    'campaign.prize.delete': 'מחיקת מתנה',
    'campaign.hub.create': 'הוספת מוקד',
    'campaign.hub.update': 'עדכון מוקד',
    'campaign.hub.delete': 'מחיקת מוקד',
    'campaign.business.create': 'הוספת עסק',
    'campaign.business.update': 'עדכון עסק',
    'campaign.business.delete': 'מחיקת עסק',
    'campaign.phone.outreach': 'דיווח פנייה לעסק (טלפון)',
    'campaign.phone.errand': 'דיווח שליחות (טלפון)',
    'campaign.phone.product': 'דיווח גיוס מוצר (טלפון)',
    'campaign.phone.bonus': 'בונוס יעד שבועי (טלפון)',
    'campaign.phone.redeem': 'מימוש מתנה (טלפון)',
    'campaign.phone.goal_set': 'קביעת יעד שבועי (טלפון)',
    'campaign.phone.new_volunteer': 'מתנדבת חדשה נרשמה (טלפון)',
    'campaign.hub.catalogs_taken': 'דיווח קטלוגים שנלקחו (טלפון)',
    'campaign.hub.message': 'הודעה למזכירות (טלפון)',
    'campaign.import.volunteers': 'ייבוא רשימת מתנדבות מאקסל',
    'campaign.import.prizes': 'ייבוא קטלוג מתנות מאקסל',
    'campaign.import.recruitment': 'ייבוא דיווחי גיוס מוצרים מאקסל',
};
let activityQuery = '';
let activityLoaded = false;
let lastData = null;
let volunteerQuery = '';
let hubQuery = '';
let editingHubId = null;
let bizQuery = '';
let bizLoaded = false;
let editingBizId = null;
let txQuery = '';
let pendingQuery = '';
let hubLogsQuery = '';
let kitRecipientsQuery = '';

async function api(path, opts = {}) {
    const res = await fetch(path, {
        ...opts,
        headers: {
            'Content-Type': 'application/json',
            'x-user-id': USER ? USER.id : '',
            ...(opts.headers || {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const err = new Error(data.error || 'שגיאה'); err.data = data; err.status = res.status; throw err; }
    return data;
}

function initLogin() {
    const doLogin = async () => {
        const code = document.getElementById('login-code').value.trim();
        document.getElementById('login-error').textContent = '';
        if (!code) return;
        try {
            const u = await api('/api/login', { method: 'POST', body: { code } });
            USER = u;
            localStorage.setItem('gemach_user', JSON.stringify(u));
            startApp();
        } catch (e) { document.getElementById('login-error').textContent = e.message; }
    };
    document.getElementById('login-btn').addEventListener('click', doLogin);
    document.getElementById('login-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
    document.getElementById('login-code').focus();
}

function activateTab(tab) {
    document.querySelectorAll('nav.c-nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('main.c-main section').forEach((s) => s.classList.toggle('active', s.id === tab));
    if (tab === 'activity') loadActivity();
    if (tab === 'businesses') loadBusinesses();
}

function startApp() {
    if (!USER || !(USER.features || []).includes('campaign')) {
        initLogin();
        document.getElementById('login-error').textContent = 'אין לך הרשאת גישה לקמפיין';
        return;
    }
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    document.querySelectorAll('nav.c-nav button').forEach((btn) => {
        btn.addEventListener('click', () => activateTab(btn.dataset.tab));
    });

    document.querySelectorAll('.side-nav button').forEach((btn) => {
        btn.addEventListener('click', () => {
            activateTab(btn.dataset.tab);
            document.querySelectorAll('.side-nav button').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(btn.dataset.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    });

    document.getElementById('activitySearch').addEventListener('input', (e) => {
        activityQuery = e.target.value.trim();
        if (activityLoaded) renderActivity(window.__activityRows || []);
    });
    document.getElementById('volunteerSearch').addEventListener('input', (e) => {
        volunteerQuery = e.target.value.trim();
        if (lastSheetsData) renderSheetsDashboard(lastSheetsData);
    });
    document.getElementById('hubSearch').addEventListener('input', (e) => {
        hubQuery = e.target.value.trim();
        if (lastData) renderHubs(lastData);
    });
    document.getElementById('bizSearch').addEventListener('input', (e) => {
        bizQuery = e.target.value.trim();
        if (bizLoaded) renderBusinesses(window.__bizRows || []);
    });
    document.getElementById('txSearch').addEventListener('input', (e) => {
        txQuery = e.target.value.trim();
        if (lastSheetsData) renderSheetsDashboard(lastSheetsData);
    });
    document.getElementById('pendingSearch').addEventListener('input', (e) => {
        pendingQuery = e.target.value.trim();
        if (lastData) render(lastData);
    });
    document.getElementById('hubLogsSearch').addEventListener('input', (e) => {
        hubLogsQuery = e.target.value.trim();
        if (lastData) render(lastData);
    });
    document.getElementById('kitRecipientsSearch').addEventListener('input', (e) => {
        kitRecipientsQuery = e.target.value.trim();
        if (lastSheetsData) renderSheetsDashboard(lastSheetsData);
    });

    loadDashboard();
    setInterval(loadDashboard, 5000);
    loadSheetsData();
    setInterval(loadSheetsData, 15000);
    // טוענים גם עסקים/יומן פעולות מראש, כדי שתקציר הריחוף בניווט הצדי יהיה נכון עוד לפני כניסה ללשונית
    loadBusinesses();
    loadActivity();
}

async function loadActivity() {
    try {
        const rows = await api('/api/campaign/activity');
        window.__activityRows = rows;
        activityLoaded = true;
        renderActivity(rows);
    } catch (e) { alert(e.message); }
}

function describeActivity(row) {
    try {
        const after = row.after_state ? JSON.parse(row.after_state) : null;
        if (!after) return '';
        if (row.action === 'campaign.points.approve') return `${after.volunteer || ''} · ${after.points} נקודות`;
        if (row.action === 'campaign.points.manual_adjust') return `${after.volunteer || ''} · ${after.points > 0 ? '+' : ''}${after.points} נקודות`;
        if (row.action === 'campaign.phone.new_volunteer') return after.phone || '';
        if (row.action === 'campaign.phone.goal_set') return `יעד ${after.goal_points} נקודות`;
        if (row.action === 'campaign.hub.catalogs_taken') return `${after.amount} קטלוגים ל-${after.phone}`;
        if (row.action === 'campaign.hub.message') return 'הודעה מוקלטת למזכירות';
        if (row.action === 'campaign.import.volunteers' || row.action === 'campaign.import.prizes' || row.action === 'campaign.import.recruitment') {
            const updatedPart = after.updated !== undefined ? `, עודכנו ${after.updated}` : '';
            return `נוספו ${after.added}${updatedPart}, דולגו ${after.skipped} (מתוך ${after.total})`;
        }
        if (row.action && row.action.startsWith('campaign.phone.') && after.points != null) {
            return `${after.points} נקודות (${STATUS_LABEL[after.status] || after.status})${after.value_nis != null ? ` · שווי ${after.value_nis} ₪` : ''}`;
        }
        if (after.name) return after.name;
        return '';
    } catch { return ''; }
}

function renderActivity(rows) {
    const q = activityQuery.toLowerCase();
    const filtered = rows.filter((r) => !q
        || (r.user_name || '').toLowerCase().includes(q)
        || (ACTION_LABEL[r.action] || r.action).toLowerCase().includes(q));
    document.querySelector('#activityLogTable tbody').innerHTML = filtered.map((r) => `
        <tr>
            <td>${r.user_name || '—'}</td>
            <td>${ACTION_LABEL[r.action] || r.action}</td>
            <td>${describeActivity(r)}</td>
            <td>${fmtDate(r.at)}</td>
        </tr>`).join('');
    setNavTooltip('hd-activity', `יומן פעולות: ${rows.length} רשומות`);
}

function fmtDate(s) {
    if (!s) return '';
    return s.replace('T', ' ').slice(0, 16);
}

async function loadDashboard() {
    try {
        const data = await api('/api/campaign/dashboard');
        render(data);
    } catch (e) {
        if (e.status === 401) { localStorage.removeItem('gemach_user'); location.href = '/'; }
    }
}

// עריכת המיתוג עברה למסך "ניהול" הראשי — כאן רק מיישמים את הצבעים/לוגו השמורים על הדף
function applySettings(s) {
    const root = document.documentElement.style;
    if (s.campaign_brand_primary) root.setProperty('--c-rose', s.campaign_brand_primary);
    if (s.campaign_brand_accent) root.setProperty('--c-raspberry', s.campaign_brand_accent);
    if (s.campaign_brand_dark) root.setProperty('--c-dark', s.campaign_brand_dark);
    const logo = document.getElementById('brandLogo');
    if (s.campaign_brand_logo) { logo.src = s.campaign_brand_logo; logo.style.display = 'block'; }
    else { logo.style.display = 'none'; }
}

/* ---- לוח בקרה חי מהגליונות של "אוצרותינו" (ימות המשיח) — קריאה מתמדת, כתיבה אופציונלית מאובטחת ---- */
let lastSheetsData = null;
let editingSheetPointsRow = null;
let editingSheetHubRow = null;

async function loadSheetsData() {
    try {
        const data = await api('/api/campaign/sheets-data');
        lastSheetsData = data;
        renderSheetsDashboard(data);
    } catch (e) { /* לא מציקים עם alert על כל פעימת רענון — השגיאה תוצג בבאנר אם קיימת */ }
}

// לפני עריכה — מרעננים מיידית מהטבלה, כדי שמספר השורה שעליו כותבים יהיה עדכני ולא מהקאש של 3 הדקות האחרונות
async function refreshSheetsThenEdit(openFn) {
    try {
        const data = await api('/api/campaign/sheets-data/refresh', { method: 'POST' });
        lastSheetsData = data;
        renderSheetsDashboard(data);
        openFn();
    } catch (e) { alert(e.message || 'הרענון נכשל'); }
}

function renderSheetsDashboard(data) {
    const synced = document.getElementById('sheetsSyncedAt');
    synced.textContent = data.syncedAt ? `עודכן לאחרונה מהטבלה: ${fmtDate(data.syncedAt)}` : '';

    const errBanner = document.getElementById('sheetsErrBanner');
    if (data.error) { errBanner.textContent = `שגיאה בסנכרון מהטבלה: ${data.error}`; errBanner.classList.remove('hidden'); }
    else { errBanner.classList.add('hidden'); }

    const participants = data.participants || [];
    const q = volunteerQuery.toLowerCase();
    const filtered = participants.filter((p) => !q
        || (p['שם (אפשר למלא ידנית)'] || '').toLowerCase().includes(q)
        || (p['טלפון'] || '').toLowerCase().includes(q));

    document.getElementById('statRow').innerHTML = `
        <div class="stat-card"><div class="stat-num">${participants.length}</div><div class="stat-label">משתתפות</div></div>
        <div class="stat-card"><div class="stat-num">${(data.transactions || []).length}</div><div class="stat-label">תנועות אחרונות</div></div>
        <div class="stat-card"><div class="stat-num">${(data.hubs || []).length}</div><div class="stat-label">מוקדים</div></div>
    `;
    setNavTooltip('hd-volunteers', `משתתפות: ${participants.length}`);
    setNavTooltip('hd-tx', `תנועות אחרונות: ${(data.transactions || []).length}`);

    document.getElementById('volunteersEmpty').style.display = filtered.length ? 'none' : 'block';
    if (editingSheetPointsRow === null) {
        document.querySelector('#volunteersTable tbody').innerHTML = filtered.map((p) => `
            <tr>
                <td>${p['שם (אפשר למלא ידנית)'] || '—'}</td>
                <td>${p['טלפון'] || ''}</td>
                <td>${p['נקודות השבוע'] || 0}</td>
                <td>${p['יעד שבועי'] || '—'}</td>
                <td>${p['סך נצבר'] || 0}</td>
                <td>${p['סך מומש'] || 0}</td>
                <td>${p['מספר דיווחים'] || 0}</td>
                <td><button class="btn secondary" onclick="refreshSheetsThenEdit(() => openSheetPointsEdit(${p.__row}))">עריכה</button></td>
            </tr>
            <tr class="hub-edit-row hidden" id="sheet-points-edit-${p.__row}">
                <td colspan="8">
                    <input id="sp-week-${p.__row}" type="number" placeholder="נקודות השבוע" value="${p['נקודות השבוע'] || 0}" style="width:110px">
                    <input id="sp-accrued-${p.__row}" type="number" placeholder="סך נצבר" value="${p['סך נצבר'] || 0}" style="width:100px">
                    <input id="sp-redeemed-${p.__row}" type="number" placeholder="סך מומש" value="${p['סך מומש'] || 0}" style="width:100px">
                    <button class="btn" onclick="saveSheetPointsEdit(${p.__row})">שמירה לטבלה</button>
                    <button class="btn secondary" onclick="closeSheetPointsEdit(${p.__row})">ביטול</button>
                </td>
            </tr>`).join('');
    }

    const tq = txQuery.toLowerCase();
    const txns = (data.transactions || []).filter((t) => !tq
        || (t['שם'] || '').toLowerCase().includes(tq)
        || (t['טלפון'] || '').toLowerCase().includes(tq)
        || (t['פעולה / מוצר'] || '').toLowerCase().includes(tq));
    document.getElementById('txEmpty').style.display = txns.length ? 'none' : 'block';
    document.querySelector('#activityTable tbody').innerHTML = txns.map((t) => `
        <tr>
            <td>${t['תאריך ושעה'] || ''}</td>
            <td>${t['שם'] || t['טלפון'] || ''}</td>
            <td>${t['פעולה / מוצר'] || ''}</td>
            <td>${t['סה"כ נקודות'] || 0}</td>
            <td>${t['נקודות בונוס'] || 0}</td>
        </tr>`).join('');

    const hubs = data.hubs || [];
    document.getElementById('sheetHubsEmpty').style.display = hubs.length ? 'none' : 'block';

    const kitsTotalSum = hubs.reduce((s, h) => s + (parseFloat(h['כמות ערכות כוללת']) || 0), 0);
    const kitsDistSum = hubs.reduce((s, h) => s + (parseFloat(h['ערכות שחולקו בפועל']) || 0), 0);
    const kitsLeftSum = hubs.reduce((s, h) => s + (parseFloat(h['נשארו במלאי']) || 0), 0);
    document.getElementById('kitsSummaryRow').innerHTML = `
        <div class="stat-card"><div class="stat-num">${kitsTotalSum}</div><div class="stat-label">סה״כ ערכות בכל המוקדים</div></div>
        <div class="stat-card"><div class="stat-num">${kitsDistSum}</div><div class="stat-label">חולקו בפועל</div></div>
        <div class="stat-card"><div class="stat-num">${kitsLeftSum}</div><div class="stat-label">נשארו במלאי</div></div>
    `;
    setNavTooltip('hd-kitsstock', `${hubs.length} מוקדים · סה״כ ${kitsTotalSum} ערכות · חולקו ${kitsDistSum} · נשארו ${kitsLeftSum}`);

    if (editingSheetHubRow !== null) return;
    document.getElementById('sheetHubCards').innerHTML = hubs.map((h) => {
        const total = parseFloat(h['כמות ערכות כוללת']) || 0;
        const left = parseFloat(h['נשארו במלאי']) || 0;
        const pct = total > 0 ? Math.round((left / total) * 100) : 0;
        const low = total > 0 && pct <= 20;
        return `
        <div class="hub-card">
            <div class="hc-name">${h['שם מוקד / שכונה'] || '—'}</div>
            <div class="hc-meta">אחראית: ${h['שם האחראית'] || '—'}${h['מספר טלפון של האחראית'] ? ' · ' + h['מספר טלפון של האחראית'] : ''}</div>
            <div class="hc-meta">${h['סטטוס מוקד'] || ''}</div>
            <div class="hub-bar"><div class="hub-bar-fill${low ? ' low' : ''}" style="width:${pct}%"></div></div>
            <div class="hc-count">${left} פנויות מתוך ${total}${low ? ' ⚠️' : ''} (חולקו: ${h['ערכות שחולקו בפועל'] || 0})</div>
            <div class="hc-actions">
                <button class="btn secondary" onclick="refreshSheetsThenEdit(() => openSheetHubEdit(${h.__row}))">עריכת מלאי</button>
            </div>
            <div class="hub-edit-row hidden" id="sheet-hub-edit-${h.__row}">
                <input id="sh-total-${h.__row}" type="number" placeholder="כמות כוללת" value="${h['כמות ערכות כוללת'] || 0}" style="width:100px">
                <input id="sh-dist-${h.__row}" type="number" placeholder="חולקו בפועל" value="${h['ערכות שחולקו בפועל'] || 0}" style="width:100px">
                <input id="sh-avail-${h.__row}" type="number" placeholder="נשארו במלאי" value="${h['נשארו במלאי'] || 0}" style="width:100px">
                <input id="sh-status-${h.__row}" placeholder="סטטוס מוקד" value="${h['סטטוס מוקד'] || ''}" style="flex:1">
                <button class="btn" onclick="saveSheetHubEdit(${h.__row})">שמירה לטבלה</button>
                <button class="btn secondary" onclick="closeSheetHubEdit(${h.__row})">ביטול</button>
            </div>
        </div>`;
    }).join('');

    const krq = kitRecipientsQuery.toLowerCase();
    const kitRecipients = (data.kitRecipients || []).filter((k) => !krq
        || (k['מספר טלפון של התושב'] || '').toLowerCase().includes(krq)
        || (k['אזור / מוקד'] || '').toLowerCase().includes(krq)
        || (k['שם האחראית'] || '').toLowerCase().includes(krq));
    document.getElementById('kitRecipientsEmpty').style.display = kitRecipients.length ? 'none' : 'block';
    document.querySelector('#kitRecipientsTable tbody').innerHTML = kitRecipients.map((k) => `
        <tr>
            <td>${k['תאריך ושעה'] || ''}</td>
            <td>${k['מספר טלפון של התושב'] || ''}</td>
            <td>${k['אזור / מוקד'] || ''}</td>
            <td>${k['שם האחראית'] || ''}</td>
        </tr>`).join('');
    setNavTooltip('hd-kitrecipients', `מקבלי ערכות: ${(data.kitRecipients || []).length}`);
}

function openSheetPointsEdit(row) {
    const el = document.getElementById(`sheet-points-edit-${row}`);
    if (!el) return;
    el.classList.remove('hidden');
    editingSheetPointsRow = row;
}
function closeSheetPointsEdit(row) {
    editingSheetPointsRow = null;
    if (lastSheetsData) renderSheetsDashboard(lastSheetsData);
}
async function saveSheetPointsEdit(row) {
    const pw = prompt('סיסמת מנהל לאישור כתיבה לטבלה:');
    if (pw === null) return;
    try {
        const data = await api('/api/campaign/sheets-write/points', { method: 'POST', body: {
            row,
            weeklyPoints: document.getElementById(`sp-week-${row}`).value,
            totalAccrued: document.getElementById(`sp-accrued-${row}`).value,
            totalRedeemed: document.getElementById(`sp-redeemed-${row}`).value,
            syncPassword: pw,
        } });
        editingSheetPointsRow = null;
        lastSheetsData = data;
        renderSheetsDashboard(data);
    } catch (e) { alert(e.message || 'השמירה לטבלה נכשלה'); }
}

function openSheetHubEdit(row) {
    const el = document.getElementById(`sheet-hub-edit-${row}`);
    if (!el) return;
    el.classList.remove('hidden');
    editingSheetHubRow = row;
}
function closeSheetHubEdit(row) {
    editingSheetHubRow = null;
    if (lastSheetsData) renderSheetsDashboard(lastSheetsData);
}
async function saveSheetHubEdit(row) {
    const pw = prompt('סיסמת מנהל לאישור כתיבה לטבלה:');
    if (pw === null) return;
    try {
        const data = await api('/api/campaign/sheets-write/hub', { method: 'POST', body: {
            row,
            kitsTotal: document.getElementById(`sh-total-${row}`).value,
            kitsDistributed: document.getElementById(`sh-dist-${row}`).value,
            kitsAvailable: document.getElementById(`sh-avail-${row}`).value,
            status: document.getElementById(`sh-status-${row}`).value,
            syncPassword: pw,
        } });
        editingSheetHubRow = null;
        lastSheetsData = data;
        renderSheetsDashboard(data);
    } catch (e) { alert(e.message || 'השמירה לטבלה נכשלה'); }
}

function renderHubs(data) {
    setNavTooltip('hd-hubslist', `מוקדי הפצה: ${data.hubs.length}`);
    // לא בונים מחדש בזמן שמישהי באמצע עריכת מוקד — אחרת הרענון התקופתי מוחק מה שהיא הקלידה
    if (editingHubId !== null) return;
    const q = hubQuery.toLowerCase();
    const filtered = data.hubs.filter((h) => !q || h.name.toLowerCase().includes(q));
    document.getElementById('hubsEmpty').style.display = filtered.length ? 'none' : 'block';
    document.getElementById('hubCards').innerHTML = filtered.map((h) => {
        const pct = h.kits_total > 0 ? Math.round((h.kits_available / h.kits_total) * 100) : 0;
        const low = h.kits_total > 0 && pct <= 20;
        return `
        <div class="hub-card">
            <div class="hc-name">${h.name}</div>
            <div class="hc-meta">קוד ${h.pin} · ${h.area_path ? h.area_path.replace(/\//g, ' / ') : '<span class="badge warn">ללא אזור בשלוחה</span>'}</div>
            <div class="hc-meta">${h.pickup_info || 'אין פרטי מסירה'}</div>
            <div class="hub-bar"><div class="hub-bar-fill${low ? ' low' : ''}" style="width:${pct}%"></div></div>
            <div class="hc-count">${h.kits_available} פנויות מתוך ${h.kits_total}${low ? ' ⚠️' : ''}</div>
            <div class="hc-actions">
                <button class="btn secondary" onclick="toggleHubEdit(${h.id})">עריכה</button>
                <button class="btn danger" onclick="deleteHub(${h.id})">מחיקה</button>
            </div>
            <div class="hub-edit-row hidden" id="hub-edit-${h.id}">
                <input id="he-total-${h.id}" type="number" placeholder="סה״כ ערכות" value="${h.kits_total}">
                <input id="he-avail-${h.id}" type="number" placeholder="פנויות כעת" value="${h.kits_available}">
                <input id="he-pickup-${h.id}" placeholder="פרטי מסירה" value="${h.pickup_info || ''}" style="flex:2">
                <button class="btn" onclick="saveHubEdit(${h.id})">שמירה</button>
            </div>
        </div>`;
    }).join('');
}

function toggleHubEdit(id) {
    const open = document.getElementById(`hub-edit-${id}`).classList.toggle('hidden') === false;
    editingHubId = open ? id : null;
}

async function saveHubEdit(id) {
    const hub = lastData.hubs.find((h) => h.id === id);
    try {
        await api(`/api/campaign/hubs/${id}`, { method: 'PUT', body: {
            name: hub.name,
            area_path: hub.area_path,
            kits_total: document.getElementById(`he-total-${id}`).value,
            kits_available: document.getElementById(`he-avail-${id}`).value,
            pickup_info: document.getElementById(`he-pickup-${id}`).value,
        } });
        editingHubId = null;
        loadDashboard();
    } catch (e) { alert(e.message); }
}

function render(data) {
    lastData = data;
    applySettings(data.settings || {});

    document.getElementById('pendingCount').textContent = data.pending.length ? `(${data.pending.length})` : '';
    setNavTooltip('hd-pending', `ממתינים לאישור: ${data.pending.length}`);
    const pq = pendingQuery.toLowerCase();
    const pendingFiltered = data.pending.filter((p) => !pq
        || (p.name || '').toLowerCase().includes(pq)
        || (p.phone || '').toLowerCase().includes(pq));
    document.getElementById('pendingEmpty').style.display = pendingFiltered.length ? 'none' : 'block';
    document.getElementById('pendingList').innerHTML = pendingFiltered.map((p) => `
        <div class="pending-card">
            <div>
                <div class="pc-who">${p.name || p.phone}</div>
                <div class="pc-meta">${p.phone} · ${fmtDate(p.created_at)}${p.recording_path ? ` · <code>${p.recording_path}</code>` : ''}</div>
            </div>
            <div class="pc-value">${p.value_nis ?? '—'} ₪</div>
            <div class="pc-actions">
                <input type="number" min="0" placeholder="נקודות" id="pts-${p.id}" value="${p.suggested_points ?? ''}">
                ${p.suggested_points != null ? `<span class="hint">(הצעה)</span>` : ''}
                <button class="btn" onclick="approveTxn(${p.id})">אישור</button>
                <button class="btn danger" onclick="rejectTxn(${p.id})">דחייה</button>
            </div>
        </div>`).join('');

    renderHubs(data);

    const hlq = hubLogsQuery.toLowerCase();
    const hubLogsFiltered = data.hubLogs.filter((l) => !hlq
        || (l.hub_name || '').toLowerCase().includes(hlq)
        || (l.message || '').toLowerCase().includes(hlq)
        || (l.phone || '').toLowerCase().includes(hlq));
    document.querySelector('#hubLogsTable tbody').innerHTML = hubLogsFiltered.map((l) => `
        <tr>
            <td>${l.hub_name}</td>
            <td>${l.kind === 'catalogs_taken' ? 'קטלוגים נלקחו' : 'הודעה'}</td>
            <td>${l.kind === 'catalogs_taken' ? `${l.amount} ל-${l.phone}` : (l.message || '')}</td>
            <td>${fmtDate(l.created_at)}</td>
        </tr>`).join('');
    setNavTooltip('hd-hublogs', `רשומות ביומן המוקדים: ${data.hubLogs.length}`);
}

async function approveTxn(id) {
    const pts = document.getElementById(`pts-${id}`).value;
    if (!pts) { alert('יש להזין מספר נקודות'); return; }
    try { await api(`/api/campaign/approve/${id}`, { method: 'POST', body: { points: pts } }); loadDashboard(); }
    catch (e) { alert(e.message); }
}
async function rejectTxn(id) { await api(`/api/campaign/reject/${id}`, { method: 'POST' }); loadDashboard(); }
async function deleteHub(id) { if (!confirm('למחוק את המוקד?')) return; await api(`/api/campaign/hubs/${id}`, { method: 'DELETE' }); loadDashboard(); }

/* ---- עסקים: מי פנתה ולמה ---- */
const BIZ_STATUS_CLASS = { 'ממתין': 'warn', 'נוצר קשר': '', 'תרם': 'ok', 'סירב': '' };

async function loadBusinesses() {
    try {
        const rows = await api('/api/campaign/businesses');
        window.__bizRows = rows;
        bizLoaded = true;
        renderBusinesses(rows);
    } catch (e) { alert(e.message); }
}

function renderBusinesses(rows) {
    setNavTooltip('hd-biz', `עסקים: ${rows.length}`);
    if (editingBizId !== null) return;
    const q = bizQuery.toLowerCase();
    const filtered = rows.filter((b) => !q || b.name.toLowerCase().includes(q));
    document.getElementById('bizEmpty').style.display = filtered.length ? 'none' : 'block';
    document.querySelector('#bizTable tbody').innerHTML = filtered.map((b) => `
        <tr>
            <td>${b.name}</td>
            <td>${b.contacted_by || '—'}</td>
            <td>${b.phone || ''}</td>
            <td>${b.email || ''}</td>
            <td><span class="badge ${BIZ_STATUS_CLASS[b.status] || ''}">${b.status}</span></td>
            <td>${b.response || ''}</td>
            <td>
                <button class="btn secondary" onclick="toggleBizEdit(${b.id})">עריכה</button>
                <button class="btn danger" onclick="deleteBusiness(${b.id})">מחיקה</button>
            </td>
        </tr>
        <tr class="hub-edit-row hidden" id="biz-edit-${b.id}">
            <td colspan="7">
                <input id="be-email-${b.id}" placeholder="מייל" value="${b.email || ''}" style="width:180px">
                <select id="be-status-${b.id}">
                    ${['ממתין', 'נוצר קשר', 'תרם', 'סירב'].map((s) => `<option${s === b.status ? ' selected' : ''}>${s}</option>`).join('')}
                </select>
                <input id="be-response-${b.id}" placeholder="תגובה" value="${b.response || ''}" style="flex:2">
                <button class="btn" onclick="saveBizEdit(${b.id})">שמירה</button>
            </td>
        </tr>`).join('');
}

function toggleBizEdit(id) {
    const open = document.getElementById(`biz-edit-${id}`).classList.toggle('hidden') === false;
    editingBizId = open ? id : null;
}

async function saveBizEdit(id) {
    try {
        await api(`/api/campaign/businesses/${id}`, { method: 'PUT', body: {
            email: document.getElementById(`be-email-${id}`).value,
            status: document.getElementById(`be-status-${id}`).value,
            response: document.getElementById(`be-response-${id}`).value,
        } });
        editingBizId = null;
        loadBusinesses();
    } catch (e) { alert(e.message); }
}

async function deleteBusiness(id) {
    if (!confirm('למחוק את העסק מהרשימה?')) return;
    try { await api(`/api/campaign/businesses/${id}`, { method: 'DELETE' }); loadBusinesses(); }
    catch (e) { alert(e.message); }
}

document.getElementById('addBizBtn').addEventListener('click', async () => {
    try {
        await api('/api/campaign/businesses', { method: 'POST', body: {
            name: document.getElementById('bizName').value,
            contacted_by: document.getElementById('bizContactedBy').value,
            phone: document.getElementById('bizPhone').value,
            email: document.getElementById('bizEmail').value,
            status: document.getElementById('bizStatus').value,
            response: document.getElementById('bizResponse').value,
        } });
        document.getElementById('bizName').value = '';
        document.getElementById('bizContactedBy').value = '';
        document.getElementById('bizPhone').value = '';
        document.getElementById('bizEmail').value = '';
        document.getElementById('bizResponse').value = '';
        loadBusinesses();
    } catch (e) { alert(e.message); }
});

async function downloadFile(endpoint, filename) {
    try {
        const res = await fetch(endpoint, { headers: { 'x-user-id': USER ? USER.id : '' } });
        if (!res.ok) throw new Error('ההורדה נכשלה');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url; link.download = filename;
        document.body.append(link); link.click(); link.remove();
        URL.revokeObjectURL(url);
    } catch (e) { alert(e.message || 'ההורדה נכשלה'); }
}

document.getElementById('bizExportBtn').addEventListener('click', () => downloadFile('/api/campaign/businesses/export.xlsx', 'עסקים.xlsx'));
document.getElementById('kitRecipientsExportBtn').addEventListener('click', () => downloadFile('/api/campaign/sheets-data/kit-recipients.xlsx', 'מקבלי ערכות.xlsx'));

if (USER) startApp(); else initLogin();
