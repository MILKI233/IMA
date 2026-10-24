/* דף הקישור למתנדבת: מאמת את הטוקן, מבקש שם, ומכין את אותן פונקציות עזר
   ש-sinit.js מצפה להן (api/fmtDate/USER) — בלי כניסה למערכת ובלי גישה לשאר המסכים. */

var USER = { name: '', features: ['campaign'] };   // משתמשת מדומה כדי ש-sinit.js יידע שמותר לו לרוץ
var SINIT_SHARE = null;

const TOKEN = new URLSearchParams(location.search).get('t') || '';
const NAME_KEY = `sinit_share_name_${TOKEN}`;

function fmtDate(s) {
    if (!s) return '';
    return String(s).replace('T', ' ').slice(0, 16);
}

function setNavTooltip() { /* אין ניווט צדי בדף השיתוף */ }

async function api(path, opts = {}) {
    const res = await fetch(path, {
        ...opts,
        headers: {
            'Content-Type': 'application/json',
            'x-share-token': TOKEN,
            // עברית גולמית בכותרת HTTP מתפרקת — מעבירים מקודד ומפענחים בשרת
            'x-share-name': encodeURIComponent(USER.name || ''),
            ...(opts.headers || {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const err = new Error(data.error || 'שגיאה'); err.status = res.status; err.data = data; throw err; }
    return data;
}

async function downloadFile(endpoint, filename) {
    const res = await fetch(endpoint, { headers: { 'x-share-token': TOKEN } });
    if (!res.ok) return alert('ההורדה נכשלה');
    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement('a');
    link.href = url; link.download = filename;
    document.body.append(link); link.click(); link.remove();
    URL.revokeObjectURL(url);
}

function showGateError(msg) {
    document.getElementById('shareError').textContent = msg;
}

function openSection(info) {
    SINIT_SHARE = { section: info.section, canWrite: info.canWrite, label: info.label };
    window.SINIT_SHARE = SINIT_SHARE;
    document.getElementById('share-gate').classList.add('hidden');
    document.getElementById('share-app').classList.remove('hidden');
    document.getElementById('shareTitle').textContent = info.sectionLabel;
    document.getElementById('shareSub').textContent =
        `${info.label} · שלום ${USER.name}${info.canWrite ? '' : ' · צפייה בלבד'}`;
    document.getElementById(`share-${info.section}`)?.classList.remove('hidden');
    window.sinitInit?.();
}

(async function boot() {
    if (!TOKEN) return showGateError('הקישור חסר. יש לפתוח את הקישור המלא שנשלח אליך.');
    let info;
    try { info = await api('/api/sinit/share/info'); }
    catch (e) { return showGateError(e.message || 'הקישור אינו תקין'); }

    document.getElementById('gateSub').textContent = `${info.sectionLabel} · ${info.label}`;
    const saved = localStorage.getItem(NAME_KEY);
    const nameInput = document.getElementById('shareName');
    if (saved) nameInput.value = saved;

    const enter = () => {
        const name = nameInput.value.trim();
        if (!name) return showGateError('יש להזין שם, כדי שנדע מי כתבה כל דבר');
        localStorage.setItem(NAME_KEY, name);
        USER.name = name;
        openSection(info);
    };
    document.getElementById('shareEnter').addEventListener('click', enter);
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') enter(); });
    nameInput.focus();
})();
