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
        });
    });

    document.getElementById('activitySearch').addEventListener('input', (e) => {
        activityQuery = e.target.value.trim();
        if (activityLoaded) renderActivity(window.__activityRows || []);
    });
    document.getElementById('volunteerSearch').addEventListener('input', (e) => {
        volunteerQuery = e.target.value.trim();
        if (lastData) renderVolunteers(lastData);
    });
    document.getElementById('hubSearch').addEventListener('input', (e) => {
        hubQuery = e.target.value.trim();
        if (lastData) renderHubs(lastData);
    });

    loadDashboard();
    setInterval(loadDashboard, 5000);
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

function timeAgo(s) {
    if (!s) return '';
    const diffMin = Math.round((Date.now() - new Date(s.replace(' ', 'T')).getTime()) / 60000);
    if (diffMin < 1) return 'הרגע';
    if (diffMin < 60) return `לפני ${diffMin} דק׳`;
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return `לפני ${diffHr} שעות`;
    return `לפני ${Math.round(diffHr / 24)} ימים`;
}

/* בנר "התקשרה לאחרונה" — זיהוי מיידי כשמתנדבת מתקשרת ודיווחה דרך הטלפון */
function renderLastCall(data) {
    const banner = document.getElementById('lastCallBanner');
    const last = data.recentTxns.find((t) => t.type !== 'manual');
    if (!last) { banner.classList.add('hidden'); return; }
    const vol = data.volunteers.find((v) => v.phone === last.phone);
    banner.classList.remove('hidden');
    banner.innerHTML = `📞 התקשרה לאחרונה: <b>${last.name || last.phone}</b>` +
        `<span class="lcb-balance">${vol ? vol.balance : '—'} נקודות</span>` +
        `<span class="lcb-time">${timeAgo(last.created_at)} · ${TXN_TYPE_LABEL[last.type] || last.type}</span>`;
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

function renderStats(data) {
    const weekPoints = data.recentTxns
        .filter((t) => t.status === 'approved' && t.points > 0 && t.created_at >= data.weekStart)
        .reduce((sum, t) => sum + t.points, 0);
    const lowHubs = data.hubs.filter((h) => h.kits_total > 0 && h.kits_available / h.kits_total <= 0.2).length;
    const cards = [
        { num: data.volunteers.length, label: 'מתנדבות', alert: false },
        { num: weekPoints, label: 'נקודות השבוע', alert: false },
        { num: data.pending.length, label: 'ממתינות לאישור', alert: data.pending.length > 0 },
        { num: data.hubs.length, label: 'מוקדי הפצה', alert: false },
        { num: lowHubs, label: 'מוקדים כמעט ריקים', alert: lowHubs > 0 },
    ];
    document.getElementById('statRow').innerHTML = cards.map((c) => `
        <div class="stat-card${c.alert ? ' alert' : ''}">
            <div class="stat-num">${c.num}</div>
            <div class="stat-label">${c.label}</div>
        </div>`).join('');
}

function renderVolunteers(data) {
    const goalByVol = {};
    data.goals.forEach((g) => { goalByVol[g.volunteer_id] = g.goal_points; });
    const q = volunteerQuery.toLowerCase();
    const filtered = data.volunteers
        .filter((v) => !q || (v.name || '').toLowerCase().includes(q) || v.phone.includes(q))
        .sort((a, b) => b.balance - a.balance);
    document.getElementById('volunteersEmpty').style.display = filtered.length ? 'none' : 'block';
    document.querySelector('#volunteersTable tbody').innerHTML = filtered.map((v) => `
        <tr>
            <td>${v.name || '<span class="badge warn">לא מזוהה</span>'}</td>
            <td>${v.phone}</td>
            <td><b>${v.balance}</b></td>
            <td>${goalByVol[v.id] ?? '—'}</td>
            <td><button class="btn secondary" onclick="adjustPoints(${v.id})">✎ נקודות</button></td>
        </tr>`).join('');
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
    renderStats(data);
    renderLastCall(data);
    renderVolunteers(data);

    document.querySelector('#activityTable tbody').innerHTML = data.recentTxns.map((tx) => `
        <tr>
            <td>${tx.name || tx.phone}</td>
            <td>${TXN_TYPE_LABEL[tx.type] || tx.type}</td>
            <td>${tx.points ?? '—'}</td>
            <td><span class="badge ${tx.status === 'approved' ? 'ok' : tx.status === 'pending' ? 'warn' : ''}">${STATUS_LABEL[tx.status] || tx.status}</span></td>
            <td>${fmtDate(tx.created_at)}</td>
        </tr>`).join('');

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
async function adjustPoints(id) {
    const v = lastData.volunteers.find((x) => x.id === id);
    const val = prompt(`כמה נקודות להוסיף ל${v ? (v.name || v.phone) : 'המתנדבת'}? (מספר שלילי = הפחתה)`);
    if (val === null) return;
    const pts = parseInt(val, 10);
    if (!Number.isFinite(pts) || pts === 0) { alert('יש להזין מספר שלם תקין, לא אפס'); return; }
    try {
        await api(`/api/campaign/volunteers/${id}/points`, { method: 'POST', body: { points: pts } });
        loadDashboard();
    } catch (e) { alert(e.message); }
}
document.getElementById('addVolBtn').addEventListener('click', async () => {
    const phone = document.getElementById('newVolPhone').value.trim();
    const name = document.getElementById('newVolName').value.trim();
    const err = document.getElementById('newVolErr');
    err.textContent = '';
    if (!phone) { err.textContent = 'יש להזין מספר טלפון'; return; }
    try {
        await api('/api/campaign/volunteers', { method: 'POST', body: { phone, name } });
        document.getElementById('newVolPhone').value = '';
        document.getElementById('newVolName').value = '';
        loadDashboard();
    } catch (e) { err.textContent = e.message || 'ההוספה נכשלה'; }
});
async function deleteHub(id) { if (!confirm('למחוק את המוקד?')) return; await api(`/api/campaign/hubs/${id}`, { method: 'DELETE' }); loadDashboard(); }

if (USER) startApp(); else initLogin();
