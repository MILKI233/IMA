let USER = JSON.parse(localStorage.getItem('gemach_user') || 'null');

// ריחוף על תגית ניווט בצד מציג סיכום נתונים עדכני של הקטגוריה (title native — לא תלוי עיצוב)
function setNavTooltip(targetId, text) {
    const btn = document.querySelector(`.side-nav button[data-target="${targetId}"]`);
    if (btn) btn.title = text;
}

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
    'campaign.business.note_add': 'תגובה על עסק',
    'campaign.business.note_delete': 'מחיקת תגובה על עסק',
    'campaign.business_status.create': 'הוספת סטטוס לעסקים',
    'campaign.sinit.sync': 'סנכרון עסקים מהטפסים',
    'campaign.sinit.stage_mark': 'עדכון שלב סגירה',
    'campaign.sinit.stage_add': 'הוספת שלב סגירה',
    'campaign.sinit.stage_delete': 'מחיקת שלב סגירה',
    'campaign.sinit.question_add': 'שאלה למנהלת המערכת',
    'campaign.sinit.question_step': 'שלב מענה לשאלה',
    'campaign.sinit.question_update': 'עדכון שאלה',
    'campaign.sinit.question_delete': 'מחיקת שאלה',
    'campaign.sinit.ai_escalate': 'שאלה הועברה למנהלת (AI)',
    'campaign.sinit.kb_upload': 'העלאת קובץ וורד לבסיס הידע',
    'campaign.sinit.kb_delete': 'מחיקת קובץ מבסיס הידע',
    'campaign.sinit.source_add': 'הוספת מקור סנכרון',
    'campaign.sinit.source_delete': 'מחיקת מקור סנכרון',
    'campaign.sinit.settings': 'עדכון הגדרות מכירה סינית',
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
let volunteerQuery = '';
let txQuery = '';
let kitRecipientsQuery = '';
let recruitedQuery = '';

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
    // לשונית "מכירה סינית" מנוהלת בקובץ sinit.js
    if (tab === 'sinit') window.sinitActivate?.();
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
    document.getElementById('txSearch').addEventListener('input', (e) => {
        txQuery = e.target.value.trim();
        if (lastSheetsData) renderSheetsDashboard(lastSheetsData);
    });
    document.getElementById('kitRecipientsSearch').addEventListener('input', (e) => {
        kitRecipientsQuery = e.target.value.trim();
        if (lastSheetsData) renderSheetsDashboard(lastSheetsData);
    });
    document.getElementById('recruitedSearch').addEventListener('input', (e) => {
        recruitedQuery = e.target.value.trim();
        if (lastSheetsData) renderSheetsDashboard(lastSheetsData);
    });

    loadDashboard();
    setInterval(loadDashboard, 5000);
    loadSheetsData();
    setInterval(loadSheetsData, 15000);
    // טוענים את יומן הפעולות מראש, כדי שתקציר הריחוף בניווט הצדי יהיה נכון עוד לפני כניסה ללשונית
    loadActivity();
    window.sinitInit?.();
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

// עדיין נחוץ רק כדי למשוך את צבעי/לוגו המיתוג (נשמרים במסך "ניהול" הראשי) — שאר הדשבורד הישן הוחלף בגיליונות האמיתיים
async function loadDashboard() {
    try {
        const data = await api('/api/campaign/dashboard');
        applySettings(data.settings || {});
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

    const rq = recruitedQuery.toLowerCase();
    const recruited = (data.recruitedProducts || []).filter((p) => !rq
        || (p.recruiterName || '').toLowerCase().includes(rq)
        || (p.businessName || '').toLowerCase().includes(rq)
        || (p.productDescription || '').toLowerCase().includes(rq));
    document.getElementById('recruitedEmpty').style.display = recruited.length ? 'none' : 'block';
    document.querySelector('#recruitedTable tbody').innerHTML = recruited.map((p) => `
        <tr>
            <td>${p.timestamp || ''}</td>
            <td>${p.recruiterName || ''}</td>
            <td>${p.recruiterPhone || ''}</td>
            <td>${p.businessName || ''}</td>
            <td>${p.businessPhone || ''}</td>
            <td>${p.businessEmail || ''}</td>
            <td>${p.productDescription || ''}</td>
            <td>${p.productValue || ''}</td>
            <td>${p.pickup || ''}</td>
            <td>${p.validity || ''}</td>
            <td>${p.logoUrl ? `<a href="${p.logoUrl}" target="_blank" rel="noopener">לוגו</a>` : ''}</td>
            <td>${p.notes || ''}</td>
            <td>${p.filledBy || ''}</td>
        </tr>`).join('');
    setNavTooltip('hd-recruited', `מוצרים שגויסו: ${(data.recruitedProducts || []).length}`);
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

document.getElementById('kitRecipientsExportBtn').addEventListener('click', () => downloadFile('/api/campaign/sheets-data/kit-recipients.xlsx', 'מקבלי ערכות.xlsx'));
document.getElementById('recruitedExportBtn').addEventListener('click', () => downloadFile('/api/campaign/sheets-data/recruited-products.xlsx', 'מוצרים שגויסו.xlsx'));

if (USER) startApp(); else initLogin();
