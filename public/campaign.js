let USER = JSON.parse(localStorage.getItem('gemach_user') || 'null');

const TXN_TYPE_LABEL = { outreach: 'פנייה לעסק', errand: 'שליחות', product: 'גיוס מוצר', bonus: 'בונוס יעד', redeem: 'מימוש מתנה' };
const STATUS_LABEL = { approved: 'מאושר', pending: 'ממתין', rejected: 'נדחה' };
let brandingFormInitialized = false;

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
        });
    });
    loadDashboard();
    setInterval(loadDashboard, 5000);
    loadGeoLeaves();
}

async function loadGeoLeaves() {
    const leaves = await api('/api/campaign/geo-leaves');
    const select = document.getElementById('hubAreaPath');
    select.innerHTML = '<option value="">— ללא אזור בשלוחה —</option>';
    for (const leaf of leaves) {
        const opt = document.createElement('option');
        opt.value = leaf.path;
        opt.textContent = leaf.label;
        select.appendChild(opt);
    }
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

function applySettings(s) {
    const root = document.documentElement.style;
    if (s.campaign_brand_primary) root.setProperty('--c-rose', s.campaign_brand_primary);
    if (s.campaign_brand_accent) root.setProperty('--c-raspberry', s.campaign_brand_accent);
    if (s.campaign_brand_dark) root.setProperty('--c-dark', s.campaign_brand_dark);
    const logo = document.getElementById('brandLogo');
    if (s.campaign_brand_logo) { logo.src = s.campaign_brand_logo; logo.style.display = 'block'; }
    else { logo.style.display = 'none'; }

    if (!brandingFormInitialized) {
        document.getElementById('brandPrimary').value = s.campaign_brand_primary || '#b06970';
        document.getElementById('brandAccent').value = s.campaign_brand_accent || '#cc3366';
        document.getElementById('brandDark').value = s.campaign_brand_dark || '#132d23';
        document.getElementById('setPointsOutreach').value = s.campaign_points_outreach ?? 2;
        document.getElementById('setPointsErrand').value = s.campaign_points_errand ?? 4;
        document.getElementById('setGoalBonus').value = s.campaign_goal_bonus_percent ?? 10;
        document.getElementById('setProductConversion').value = s.campaign_product_conversion_percent ?? '';
        brandingFormInitialized = true;
    }
}

function render(data) {
    applySettings(data.settings || {});
    const goalByVol = {};
    data.goals.forEach((g) => { goalByVol[g.volunteer_id] = g.goal_points; });

    document.querySelector('#volunteersTable tbody').innerHTML = data.volunteers.map((v) => `
        <tr>
            <td>${v.name || '<span class="badge warn">לא מזוהה</span>'}</td>
            <td>${v.phone}</td>
            <td><b>${v.balance}</b></td>
            <td>${goalByVol[v.id] ?? '—'}</td>
        </tr>`).join('');

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
    document.querySelector('#pendingTable tbody').innerHTML = data.pending.map((p) => `
        <tr>
            <td>${p.name || p.phone}</td>
            <td>${p.phone}</td>
            <td>${p.value_nis ?? '—'}</td>
            <td>${p.recording_path ? `<code>${p.recording_path}</code>` : '—'}</td>
            <td>${fmtDate(p.created_at)}</td>
            <td>
                <input type="number" min="0" placeholder="נקודות" style="width:75px" id="pts-${p.id}" value="${p.suggested_points ?? ''}">
                ${p.suggested_points != null ? `<span class="hint">(הצעה)</span>` : ''}
                <button class="btn" onclick="approveTxn(${p.id})">אישור</button>
                <button class="btn danger" onclick="rejectTxn(${p.id})">דחייה</button>
            </td>
        </tr>`).join('');

    document.querySelector('#hubsTable tbody').innerHTML = data.hubs.map((h) => `
        <tr>
            <td>${h.name}</td>
            <td>${h.pin}</td>
            <td>${h.area_path ? h.area_path.replace(/\//g, ' / ') : '<span class="badge warn">ללא אזור</span>'}</td>
            <td>${h.pickup_info || '—'}</td>
            <td>${h.kits_available}</td>
            <td>${h.kits_total}</td>
            <td><button class="btn danger" onclick="deleteHub(${h.id})">מחיקה</button></td>
        </tr>`).join('');

    document.querySelector('#hubLogsTable tbody').innerHTML = data.hubLogs.map((l) => `
        <tr>
            <td>${l.hub_name}</td>
            <td>${l.kind === 'catalogs_taken' ? 'קטלוגים נלקחו' : 'הודעה'}</td>
            <td>${l.kind === 'catalogs_taken' ? `${l.amount} ל-${l.phone}` : (l.message || '')}</td>
            <td>${fmtDate(l.created_at)}</td>
        </tr>`).join('');

    const unidentified = data.volunteers.filter((v) => !v.name);
    document.getElementById('unidentifiedEmpty').style.display = unidentified.length ? 'none' : 'block';
    document.querySelector('#unidentifiedTable tbody').innerHTML = unidentified.map((v) => `
        <tr>
            <td>${v.phone}</td>
            <td><input id="name-${v.id}" placeholder="שם המתנדבת" style="width:150px"> <button class="btn" onclick="setName(${v.id})">שמירה</button></td>
        </tr>`).join('');

    document.querySelector('#prizesTable tbody').innerHTML = data.prizes.map((pr) => `
        <tr>
            <td>${pr.code}</td><td>${pr.name}</td><td>${pr.value_nis ?? '—'}</td><td>${pr.points_cost}</td>
            <td>${pr.active ? 'כן' : 'לא'}</td>
            <td><button class="btn danger" onclick="deletePrize(${pr.id})">מחיקה</button></td>
        </tr>`).join('');
}

async function approveTxn(id) {
    const pts = document.getElementById(`pts-${id}`).value;
    if (!pts) { alert('יש להזין מספר נקודות'); return; }
    try { await api(`/api/campaign/approve/${id}`, { method: 'POST', body: { points: pts } }); loadDashboard(); }
    catch (e) { alert(e.message); }
}
async function rejectTxn(id) { await api(`/api/campaign/reject/${id}`, { method: 'POST' }); loadDashboard(); }
async function setName(id) {
    const name = document.getElementById(`name-${id}`).value;
    try { await api(`/api/campaign/volunteers/${id}`, { method: 'PUT', body: { name } }); loadDashboard(); }
    catch (e) { alert(e.message); }
}
async function deletePrize(id) { if (!confirm('למחוק את המתנה?')) return; await api(`/api/campaign/prizes/${id}`, { method: 'DELETE' }); loadDashboard(); }
async function deleteHub(id) { if (!confirm('למחוק את המוקד?')) return; await api(`/api/campaign/hubs/${id}`, { method: 'DELETE' }); loadDashboard(); }

document.getElementById('addPrizeBtn').addEventListener('click', async () => {
    try {
        await api('/api/campaign/prizes', { method: 'POST', body: {
            code: document.getElementById('prizeCode').value,
            name: document.getElementById('prizeName').value,
            value_nis: document.getElementById('prizeValue').value,
            points_cost: document.getElementById('prizePoints').value,
        } });
        document.getElementById('prizeCode').value = '';
        document.getElementById('prizeName').value = '';
        document.getElementById('prizeValue').value = '';
        document.getElementById('prizePoints').value = '';
        loadDashboard();
    } catch (e) { alert(e.message); }
});

document.getElementById('addHubBtn').addEventListener('click', async () => {
    try {
        await api('/api/campaign/hubs', { method: 'POST', body: {
            name: document.getElementById('hubName').value,
            pin: document.getElementById('hubPin').value,
            kits_total: document.getElementById('hubTotal').value,
            area_path: document.getElementById('hubAreaPath').value,
            pickup_info: document.getElementById('hubPickupInfo').value,
        } });
        document.getElementById('hubName').value = '';
        document.getElementById('hubPin').value = '';
        document.getElementById('hubTotal').value = '';
        document.getElementById('hubAreaPath').value = '';
        document.getElementById('hubPickupInfo').value = '';
        loadDashboard();
    } catch (e) { alert(e.message); }
});

document.getElementById('saveBrandingBtn').addEventListener('click', async () => {
    const payload = {
        campaign_brand_primary: document.getElementById('brandPrimary').value,
        campaign_brand_accent: document.getElementById('brandAccent').value,
        campaign_brand_dark: document.getElementById('brandDark').value,
    };
    const file = document.getElementById('logoFile').files[0];
    if (file) {
        payload.campaign_brand_logo = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }
    await api('/api/campaign/settings', { method: 'PUT', body: payload });
    alert('המיתוג נשמר');
    loadDashboard();
});

document.getElementById('saveCalcBtn').addEventListener('click', async () => {
    await api('/api/campaign/settings', { method: 'PUT', body: {
        campaign_points_outreach: document.getElementById('setPointsOutreach').value,
        campaign_points_errand: document.getElementById('setPointsErrand').value,
        campaign_goal_bonus_percent: document.getElementById('setGoalBonus').value,
        campaign_product_conversion_percent: document.getElementById('setProductConversion').value,
    } });
    alert('ההגדרות נשמרו, בתוקף מהשיחה הבאה בטלפון');
    loadDashboard();
});

if (USER) startApp(); else initLogin();
