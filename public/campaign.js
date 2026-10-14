let USER = JSON.parse(localStorage.getItem('gemach_user') || 'null');

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

function startApp() {
    if (!USER || !(USER.features || []).includes('campaign')) {
        initLogin();
        document.getElementById('login-error').textContent = 'אין לך הרשאת גישה לקמפיין';
        return;
    }
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    document.querySelectorAll('nav.c-nav button').forEach((btn) => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('nav.c-nav button').forEach((b) => b.classList.remove('active'));
            document.querySelectorAll('main.c-main section').forEach((s) => s.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(btn.dataset.tab).classList.add('active');
            if (btn.dataset.tab === 'activity') loadActivity();
            if (btn.dataset.tab === 'businesses') loadBusinesses();
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

    loadDashboard();
    setInterval(loadDashboard, 5000);
    loadSheetsData();
    setInterval(loadSheetsData, 15000);
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

/* ---- לוח בקרה חי מהגליונות של "אוצרותינו" (ימות המשיח) — קריאה בלבד, לעולם לא כותבים לשם ---- */
let lastSheetsData = null;

async function loadSheetsData() {
    try {
        const data = await api('/api/campaign/sheets-data');
        lastSheetsData = data;
        renderSheetsDashboard(data);
    } catch (e) { /* לא מציקים עם alert על כל פעימת רענון — השגיאה תוצג בבאנר אם קיימת */ }
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

    document.getElementById('volunteersEmpty').style.display = filtered.length ? 'none' : 'block';
    document.querySelector('#volunteersTable tbody').innerHTML = filtered.map((p) => `
        <tr>
            <td>${p['שם (אפשר למלא ידנית)'] || '—'}</td>
            <td>${p['טלפון'] || ''}</td>
            <td>${p['נקודות השבוע'] || 0}</td>
            <td>${p['יעד שבועי'] || '—'}</td>
            <td>${p['סך נצבר'] || 0}</td>
            <td>${p['סך מומש'] || 0}</td>
            <td>${p['מספר דיווחים'] || 0}</td>
        </tr>`).join('');

    const txns = data.transactions || [];
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
        </div>`;
    }).join('');
}

function renderHubs(data) {
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
    document.getElementById('pendingEmpty').style.display = data.pending.length ? 'none' : 'block';
    document.getElementById('pendingList').innerHTML = data.pending.map((p) => `
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

    document.querySelector('#hubLogsTable tbody').innerHTML = data.hubLogs.map((l) => `
        <tr>
            <td>${l.hub_name}</td>
            <td>${l.kind === 'catalogs_taken' ? 'קטלוגים נלקחו' : 'הודעה'}</td>
            <td>${l.kind === 'catalogs_taken' ? `${l.amount} ל-${l.phone}` : (l.message || '')}</td>
            <td>${fmtDate(l.created_at)}</td>
        </tr>`).join('');
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
    if (editingBizId !== null) return;
    const q = bizQuery.toLowerCase();
    const filtered = rows.filter((b) => !q || b.name.toLowerCase().includes(q));
    document.getElementById('bizEmpty').style.display = filtered.length ? 'none' : 'block';
    document.getElementById('bizCards').innerHTML = filtered.map((b) => `
        <div class="hub-card">
            <div class="hc-name">${b.name}</div>
            <div class="hc-meta">${b.contacted_by ? 'פנתה: ' + b.contacted_by : 'לא ידוע מי פנתה'}${b.phone ? ' · ' + b.phone : ''}</div>
            <div class="hc-meta"><span class="badge ${BIZ_STATUS_CLASS[b.status] || ''}">${b.status}</span></div>
            <div class="hc-meta">${b.response || 'אין עדיין תגובה רשומה'}</div>
            <div class="hc-actions">
                <button class="btn secondary" onclick="toggleBizEdit(${b.id})">עריכה</button>
                <button class="btn danger" onclick="deleteBusiness(${b.id})">מחיקה</button>
            </div>
            <div class="hub-edit-row hidden" id="biz-edit-${b.id}">
                <select id="be-status-${b.id}">
                    ${['ממתין', 'נוצר קשר', 'תרם', 'סירב'].map((s) => `<option${s === b.status ? ' selected' : ''}>${s}</option>`).join('')}
                </select>
                <input id="be-response-${b.id}" placeholder="תגובה" value="${b.response || ''}" style="flex:2">
                <button class="btn" onclick="saveBizEdit(${b.id})">שמירה</button>
            </div>
        </div>`).join('');
}

function toggleBizEdit(id) {
    const open = document.getElementById(`biz-edit-${id}`).classList.toggle('hidden') === false;
    editingBizId = open ? id : null;
}

async function saveBizEdit(id) {
    try {
        await api(`/api/campaign/businesses/${id}`, { method: 'PUT', body: {
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
            status: document.getElementById('bizStatus').value,
            response: document.getElementById('bizResponse').value,
        } });
        document.getElementById('bizName').value = '';
        document.getElementById('bizContactedBy').value = '';
        document.getElementById('bizPhone').value = '';
        document.getElementById('bizResponse').value = '';
        loadBusinesses();
    } catch (e) { alert(e.message); }
});

if (USER) startApp(); else initLogin();
