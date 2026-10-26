/* לשונית "מכירה סינית" — עסקים (טבלה / רשימה / לוח לפי סטטוס), שאלות ושלבי מענה, וצ'אט AI.
   אותו קובץ משרת שני דפים: campaign.html (צוות מחובר) ו-share.html (קישור למתנדבת למקטע אחד).
   כל מקטע מרונדר רק אם המיכל שלו קיים בדף — כך דף השיתוף מקבל בדיוק את מה שהותר לו. */

const S = {
    businesses: [], stages: [], statuses: [], questions: [], aiLog: [],
    overview: null, modalId: null, wired: false, asking: false,
    view: localStorage.getItem('sinit_view') || 'table',
    f: { q: '', status: '', stage: '', source: '', color: '', question: '' },
};

// מצב שיתוף נקבע ב-share-boot.js רק אחרי שהמתנדבת מזינה את שמה — לכן נקרא בכל פעם מחדש
// ולא נשמר בקבוע בזמן הטעינה (באג שנתפס בבדיקה: הדף הוצג כאילו הוא המסך המלא).
const shareMode = () => (typeof window !== 'undefined' ? (window.SINIT_SHARE || null) : null);
const canWrite = () => { const s = shareMode(); return s ? !!s.canWrite : true; };
const showsSection = (name) => { const s = shareMode(); return !s || s.section === name; };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const el = (id) => document.getElementById(id);
const on = (id, ev, fn) => el(id)?.addEventListener(ev, fn);

const STATUS_CLASS = { 'ממתין': 'warn', 'תרם': 'ok', 'סופי סופי': 'done', 'סירב': 'bad', 'נוצר קשר': '' };
const Q_STATUS_CLASS = { 'נשאלה': 'warn', 'נשלחה למנהלת': 'warn', 'בטיפול': '', 'נענתה': 'ok', 'נסגרה': 'ok' };
const AI_OUTCOME_CLASS = { 'מהחומר': 'ok', 'AI מהחומר': 'ok', 'אין מענה': 'bad' };

/* ---------- טעינה ---------- */
async function sinitLoadOverview() {
    const o = await api('/api/sinit/overview');
    S.overview = o;
    S.businesses = o.businesses;
    S.stages = o.stages;
    S.statuses = o.statuses;
    renderStats();
    renderSyncInfo();
    fillSelects();
    renderBusinesses();
    if (el('saiReadyHint')) {
        el('saiReadyHint').textContent = o.kbDocs
            ? `עונה מתוך ${o.kbDocs} קבצים · ${o.kbPairs} שאלות${o.aiReady ? '' : ' · ללא מפתח AI — רק התאמה ישירה'}`
            : 'עדיין לא הועלו קבצי וורד — אפשר לשלוח כל שאלה למנהלת המערכת';
    }
    if (el('squestionMailHint')) {
        el('squestionMailHint').textContent = o.adminEmail
            ? `המייל יישלח ל${o.adminEmail}${o.mailReady ? '' : ' — אך חיבור ה-Gmail עדיין לא מוגדר'}`
            : 'לא הוגדרה כתובת מייל למנהלת — ההגדרה נמצאת במסך הניהול';
    }
}

async function sinitLoadQuestions() {
    if (!el('squestionsList')) return;
    S.questions = await api('/api/sinit/questions');
    renderQuestions();
}

async function sinitLoadAi() {
    if (!el('saiChat')) return;
    S.aiLog = await api('/api/sinit/ai/log');
    renderAiChat();
}

// הסתרת כל אזורי הכתיבה בקישור "צפייה בלבד". נקרא בכל טעינה ולא רק בחיווט הראשוני,
// כי בדף השיתוף מצב ההרשאה ידוע רק אחרי שהמתנדבת נכנסה.
function applyWriteMode() {
    const readOnly = !canWrite();
    document.querySelectorAll('.write-only').forEach((n) => {
        if (readOnly) { n.dataset.wasHidden = n.classList.contains('hidden') ? '1' : '0'; n.classList.add('hidden'); }
        else if (n.dataset.wasHidden === '1') n.classList.add('hidden');
    });
}

async function sinitLoadAll() {
    applyWriteMode();
    const jobs = [sinitLoadOverview()];
    if (showsSection('questions')) jobs.push(sinitLoadQuestions());
    if (showsSection('ai')) jobs.push(sinitLoadAi());
    try { await Promise.all(jobs); }
    catch (e) {
        if (e.status === 403 || e.status === 401) {
            const box = el('sinitSyncInfo') || el('sbizCount');
            if (box) box.innerHTML = `<span class="err-line">${esc(e.message)}</span>`;
        } else console.error('טעינת מכירה סינית נכשלה:', e.message);
    }
}

// הודעת אישור צפה, במקום alert שחוסם את הדף
function sinitToast(msg, kind = 'ok') {
    let t = el('sinitToast');
    if (!t) {
        t = document.createElement('div');
        t.id = 'sinitToast';
        document.body.append(t);
    }
    t.className = `sinit-toast ${kind}`;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), kind === 'err' ? 7000 : 4000);
}

/* ---------- חלונית הקלדה ---------- */
// מחליפה את prompt() של הדפדפן: נפתחת במרכז המסך, רחבה, עם שדה טקסט גדול.
// נבנית פעם אחת ומוזרקת ל-DOM, כדי שתעבוד גם בדף הקמפיין וגם בדף המתנדבות.
function sinitPrompt({ title, hint = '', value = '', placeholder = '', okLabel = 'שמירה', rows = 6 }) {
    return new Promise((resolve) => {
        let box = el('sinitPromptOverlay');
        if (!box) {
            box = document.createElement('div');
            box.id = 'sinitPromptOverlay';
            box.className = 'modal-overlay hidden';
            box.innerHTML = `
                <div class="modal-box prompt-box">
                    <div class="modal-head">
                        <h3 id="sinitPromptTitle"></h3>
                        <button class="modal-close" id="sinitPromptClose">✕</button>
                    </div>
                    <div class="modal-meta" id="sinitPromptHint"></div>
                    <textarea id="sinitPromptInput" class="prompt-input"></textarea>
                    <div class="prompt-actions">
                        <button class="btn" id="sinitPromptOk"></button>
                        <button class="btn secondary" id="sinitPromptCancel">ביטול</button>
                        <span class="hint">Ctrl+Enter לשמירה מהירה</span>
                    </div>
                </div>`;
            document.body.append(box);
        }
        const input = el('sinitPromptInput');
        el('sinitPromptTitle').textContent = title;
        el('sinitPromptHint').textContent = hint;
        el('sinitPromptHint').style.display = hint ? '' : 'none';
        el('sinitPromptOk').textContent = okLabel;
        input.value = value;
        input.placeholder = placeholder;
        input.rows = rows;
        box.classList.remove('hidden');
        setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 30);

        const close = (result) => {
            box.classList.add('hidden');
            el('sinitPromptOk').onclick = null;
            el('sinitPromptCancel').onclick = null;
            el('sinitPromptClose').onclick = null;
            box.onclick = null;
            input.onkeydown = null;
            resolve(result);
        };
        el('sinitPromptOk').onclick = () => close(input.value);
        el('sinitPromptCancel').onclick = () => close(null);
        el('sinitPromptClose').onclick = () => close(null);
        box.onclick = (e) => { if (e.target === box) close(null); };
        input.onkeydown = (e) => {
            if (e.key === 'Escape') close(null);
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) close(input.value);
        };
    });
}

/* ---------- סטטיסטיקה ---------- */
function renderStats() {
    if (!el('sinitStats')) return;
    const o = S.overview || {};
    const biz = S.businesses;
    const donated = biz.filter((b) => b.status === 'תרם').length;
    const closed = biz.filter((b) => b.stages_total && b.stages_done === b.stages_total).length;
    const cards = [
        `<div class="stat-card"><div class="stat-num">${biz.length}</div><div class="stat-label">עסקים</div></div>`,
        `<div class="stat-card"><div class="stat-num">${donated}</div><div class="stat-label">תרמו</div></div>`,
        `<div class="stat-card"><div class="stat-num">${closed}</div><div class="stat-label">סגורים לגמרי</div></div>`,
    ];
    if (showsSection('questions')) {
        cards.push(`<div class="stat-card${o.questionsOpen ? ' alert' : ''}"><div class="stat-num">${o.questionsOpen || 0}</div><div class="stat-label">שאלות פתוחות</div></div>`);
    }
    if (showsSection('ai')) {
        cards.push(`<div class="stat-card"><div class="stat-num">${o.kbPairs || 0}</div><div class="stat-label">שאלות בבסיס הידע</div></div>`);
    }
    el('sinitStats').innerHTML = cards.join('');
    if (typeof setNavTooltip === 'function') {
        setNavTooltip('hd-sbiz', `${biz.length} עסקים · ${donated} תרמו · ${closed} סגורים`);
        setNavTooltip('hd-squestions', `${o.questionsOpen || 0} שאלות פתוחות`);
    }
}

function renderSyncInfo() {
    if (!el('sinitSyncInfo')) return;
    const o = S.overview || {};
    const parts = [];
    if (o.sheetsSyncedAt) parts.push(`הטפסים סונכרנו: ${fmtDate(o.sheetsSyncedAt)}`);
    parts.push(`${o.recruitedRows || 0} שורות בטופס התרומות`);
    parts.push(`${S.businesses.filter((b) => b.source && b.source !== 'ידני').length} עסקים נכנסו מהטפסים`);
    el('sinitSyncInfo').innerHTML = `<span class="hint">⟳ ${parts.join(' · ')}</span>`
        + (o.sheetsError ? `<div class="err-line">שגיאת סנכרון: ${esc(o.sheetsError)}</div>` : '');
}

function fillSelects() {
    const statusOpts = S.statuses.map((s) => `<option>${esc(s)}</option>`).join('');
    if (el('sbizStatus')) el('sbizStatus').innerHTML = statusOpts;
    if (el('sbizModalStatus')) el('sbizModalStatus').innerHTML = statusOpts;
    if (el('sbizStatusFilter')) {
        el('sbizStatusFilter').innerHTML = '<option value="">כל הסטטוסים</option>' + statusOpts;
        el('sbizStatusFilter').value = S.f.status;
    }
    if (el('sbizStageFilter')) {
        el('sbizStageFilter').innerHTML = '<option value="">כל שלבי הסגירה</option>'
            + S.stages.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')
            + '<option value="none">לא התחילו שלבים</option><option value="all">סיימו את כל השלבים</option>';
        el('sbizStageFilter').value = S.f.stage;
    }
    if (el('sbizSourceFilter')) {
        const sources = [...new Set(S.businesses.map((b) => b.source || 'ידני'))];
        el('sbizSourceFilter').innerHTML = '<option value="">כל המקורות</option>'
            + sources.map((s) => `<option>${esc(s)}</option>`).join('');
        el('sbizSourceFilter').value = S.f.source;
    }
    if (el('sbizColorFilter')) el('sbizColorFilter').value = S.f.color;
    if (el('squestionBiz')) {
        el('squestionBiz').innerHTML = '<option value="">ללא קשר לעסק מסוים</option>'
            + S.businesses.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
    }
}

/* ---------- עסקים: סינון ושלוש תצוגות ---------- */
function filteredBusinesses() {
    const q = S.f.q.toLowerCase();
    return S.businesses.filter((b) => {
        if (q && ![b.name, b.contacted_by, b.phone, b.reporter_phone, b.email, b.product, b.response]
            .some((v) => String(v || '').toLowerCase().includes(q))) return false;
        if (S.f.status && b.status !== S.f.status) return false;
        if (S.f.source && (b.source || 'ידני') !== S.f.source) return false;
        if (S.f.stage === 'none' && b.stages_done > 0) return false;
        if (S.f.stage === 'all' && !(b.stages_total && b.stages_done === b.stages_total)) return false;
        if (S.f.stage && !['none', 'all'].includes(S.f.stage) && !b.done_stage_ids.includes(Number(S.f.stage))) return false;
        if (S.f.color === 'marked' && !b.highlight) return false;
        if (S.f.color === 'colored' && !b.color) return false;
        if (S.f.color === 'plain' && b.color) return false;
        if (S.f.unnamed && !isUnnamed(b)) return false;
        return true;
    });
}

// עסק שנוצר מדיווח טלפוני בלי שם תורם — ממתין לשם אמיתי
const isUnnamed = (b) => String(b.name || '').startsWith('ללא שם ·');

function stageBar(b, big = false) {
    if (!b.stages_total) return '<span class="hint">אין שלבים</span>';
    const pct = Math.round((b.stages_done / b.stages_total) * 100);
    return `<div class="stage-mini${big ? ' big' : ''}" title="${esc(b.current_stage || 'טרם התחיל')}">
        <div class="stage-mini-bar"><div class="stage-mini-fill" style="width:${pct}%"></div></div>
        <span class="stage-mini-txt">${b.stages_done}/${b.stages_total}${b.current_stage ? ` · ${esc(b.current_stage)}` : ' · טרם התחיל'}</span>
    </div>`;
}

// פעולות על עסק: העברה ללשונית השאלות לטיפול, ומחיקה (למנהלת בלבד)
function rowActions(b) {
    const parts = [];
    if (canWrite() && isUnnamed(b)) {
        parts.push(`<button class="btn act-btn" title="מתן שם לעסק שנקלט מדיווח טלפוני"
            onclick="event.stopPropagation();sinitRename(${b.id})">✎ שם</button>`);
    }
    if (canWrite()) {
        parts.push(`<button class="btn secondary act-btn" title="פתיחת שאלה על העסק הזה בלשונית שאלות ומענה"
            onclick="event.stopPropagation();sinitMoveToQuestions(${b.id})">➜ לשאלות</button>`);
    }
    if (S.overview?.isManager) {
        parts.push(`<button class="btn danger act-btn" title="מחיקת העסק וכל ההיסטוריה שלו"
            onclick="event.stopPropagation();sinitDeleteBiz(${b.id})">מחיקה</button>`);
    }
    return parts.join(' ');
}

function colorButtons(b) {
    if (!canWrite()) return '';
    return `<button class="dot-btn${b.highlight ? ' on' : ''}" title="הדגשה" onclick="event.stopPropagation();sinitToggleHighlight(${b.id})">⭐</button>`
        + (S.overview?.colors || []).map((c) => `<button class="dot-swatch${b.color === c ? ' on' : ''}" style="background:${c}"
            title="צביעה" onclick="event.stopPropagation();sinitSetColor(${b.id},'${c}')"></button>`).join('')
        + `<button class="dot-swatch clear" title="ביטול צבע" onclick="event.stopPropagation();sinitSetColor(${b.id},'')">✕</button>`;
}

function renderBusinesses() {
    const host = el('sbizView');
    if (!host) return;
    const rows = filteredBusinesses();
    if (el('sbizCount')) {
        const unnamed = S.businesses.filter(isUnnamed).length;
        el('sbizCount').innerHTML = `מוצגים ${rows.length} מתוך ${S.businesses.length}`
            + (unnamed ? ` · <button class="chip-filter${S.f.unnamed ? ' on' : ''}" onclick="sinitToggleUnnamed()"
                 title="עסקים שנוצרו מדיווח טלפוני בלי שם תורם — ממתינים לשם">ללא שם (${unnamed})</button>` : '');
    }
    if (el('sbizEmpty')) el('sbizEmpty').style.display = rows.length ? 'none' : 'block';
    document.querySelectorAll('.view-switch button').forEach((b) => b.classList.toggle('on', b.dataset.view === S.view));
    host.className = `biz-view view-${S.view}`;
    if (S.view === 'board') host.innerHTML = boardHtml(rows);
    else if (S.view === 'cards') host.innerHTML = cardsHtml(rows);
    else host.innerHTML = tableHtml(rows);
}

function tableHtml(rows) {
    return `<table class="biz-table"><thead><tr>
        <th>שם העסק</th><th>מי פנתה</th><th>טלפון העסק</th><th>דווח מהטלפון</th><th>מייל</th><th>מוצר</th>
        <th>סטטוס</th><th>שלבי סגירה</th><th>תגובה אחרונה</th><th>מקור</th>${canWrite() ? '<th>צבע</th>' : ''}<th></th>
    </tr></thead><tbody>${rows.map((b) => `
        <tr class="biz-row${b.highlight ? ' marked' : ''}" style="${b.color ? `background:${esc(b.color)}` : ''}" onclick="sinitOpenBiz(${b.id})">
            <td>${b.highlight ? '⭐ ' : ''}${esc(b.name)}</td>
            <td>${esc(b.contacted_by || '—')}</td>
            <td>${esc(b.phone || '')}</td>
            <td>${b.reporter_phone ? esc(b.reporter_phone) : '<span class="hint">—</span>'}${b.reported_at ? `<br><span class="hint">${esc(b.reported_at)}</span>` : ''}</td>
            <td>${esc(b.email || '')}</td>
            <td>${esc(b.product || '')}${b.value_nis ? ` <span class="hint">(${esc(b.value_nis)} ₪)</span>` : ''}</td>
            <td><span class="badge ${STATUS_CLASS[b.status] || ''}">${esc(b.status)}</span></td>
            <td>${stageBar(b)}</td>
            <td class="cell-wrap">${b.response ? esc(b.response) : '<span class="hint">אין תגובה</span>'}</td>
            <td><span class="src-tag">${esc(b.source || 'ידני')}</span></td>
            ${canWrite() ? `<td class="color-cell">${colorButtons(b)}</td>` : ''}
            <td class="act-cell">${rowActions(b)}</td>
        </tr>`).join('')}</tbody></table>`;
}

function bizCard(b) {
    return `<article class="biz-card${b.highlight ? ' marked' : ''}" style="${b.color ? `background:${esc(b.color)}` : ''}"
             onclick="sinitOpenBiz(${b.id})">
        <header class="bc-head">
            <span class="bc-name">${b.highlight ? '⭐ ' : ''}${esc(b.name)}</span>
            <span class="badge ${STATUS_CLASS[b.status] || ''}">${esc(b.status)}</span>
        </header>
        ${b.product ? `<div class="bc-product">${esc(b.product)}${b.value_nis ? ` · ${esc(b.value_nis)} ₪` : ''}</div>` : ''}
        <div class="bc-meta">
            ${b.contacted_by ? `<span>👤 ${esc(b.contacted_by)}</span>` : ''}
            ${b.phone ? `<span>📞 ${esc(b.phone)}</span>` : ''}
            ${b.reporter_phone ? `<span title="הטלפון שממנו התקבל הדיווח">☎ דווח מ-${esc(b.reporter_phone)}</span>` : ''}
            ${b.email ? `<span>✉ ${esc(b.email)}</span>` : ''}
        </div>
        ${stageBar(b, true)}
        <div class="bc-response">${b.response ? esc(b.response) : '<span class="hint">אין עדיין תגובה</span>'}</div>
        <footer class="bc-foot">
            <span class="src-tag">${esc(b.source || 'ידני')}</span>
            ${b.notes_count ? `<span class="hint">${b.notes_count} רשומות</span>` : ''}
            <span class="bc-colors">${colorButtons(b)}</span>
        </footer>
        ${rowActions(b) ? `<div class="bc-actions">${rowActions(b)}</div>` : ''}
    </article>`;
}

function cardsHtml(rows) {
    return `<div class="biz-cards">${rows.map(bizCard).join('')}</div>`;
}

// "ריבועים מסודרים לפי סטטוס" — עמודה לכל סטטוס, כמו לוח קנבן
function boardHtml(rows) {
    // מציגים את כל הסטטוסים — גם ריקים — כדי שרואים את כל המסלול, לא רק את מה שכבר קרה
    return `<div class="biz-board">${S.statuses.map((st) => {
        const inCol = rows.filter((b) => b.status === st);
        return `<section class="board-col">
            <header class="board-col-head ${STATUS_CLASS[st] || ''}">
                <span>${esc(st)}</span><span class="board-count">${inCol.length}</span>
            </header>
            <div class="board-col-body">
                ${inCol.map(bizCard).join('') || '<div class="hint board-empty">אין עסקים בסטטוס הזה</div>'}
            </div>
        </section>`;
    }).join('')}</div>`;
}

function sinitToggleUnnamed() {
    S.f.unnamed = !S.f.unnamed;
    renderBusinesses();
}

// שינוי מהיר של שם עסק — בלי לפתוח את כל חלון העסק
async function sinitRename(id) {
    const b = S.businesses.find((x) => x.id === id);
    if (!b) return;
    const name = await sinitPrompt({
        title: 'שם העסק',
        hint: b.product ? `המוצר שדווח: ${b.product}` : '',
        value: isUnnamed(b) ? '' : b.name,
        placeholder: 'שם העסק כפי שצריך להופיע ברשימה', rows: 2, okLabel: 'שמירת השם',
    });
    if (name === null || !name.trim()) return;
    try {
        await api(`/api/sinit/businesses/${id}`, { method: 'PUT', body: { name: name.trim() } });
        await sinitLoadOverview();
        if (S.modalId === id) await refreshModal();
        sinitToast('השם נשמר');
    } catch (e) { sinitToast(e.message, 'err'); }
}

/* ---------- עריכת פרטי העסק ---------- */
// גם עסק שהגיע מסנכרון ניתן לעריכה. שדה שנערך כאן ננעל ולא נדרס בשליפה הבאה.
const BIZ_FIELDS = [
    { k: 'name', label: 'שם העסק' },
    { k: 'phone', label: 'טלפון העסק', type: 'tel' },
    { k: 'email', label: 'מייל העסק', type: 'email' },
    { k: 'contacted_by', label: 'מי פנתה' },
    { k: 'product', label: 'המוצר שגויס', wide: true },
    { k: 'value_nis', label: 'שווי בש"ח' },
    { k: 'pickup', label: 'איסוף' },
    { k: 'validity', label: 'תוקף' },
    { k: 'logo_url', label: 'קישור ללוגו', wide: true },
    { k: 'contact_number', label: 'מס\' פנייה' },
    { k: 'message_number', label: 'מס\' הודעה' },
];

function sinitEditFields(d) {
    const b = d.biz;
    const locked = new Set(b.manualFields || []);
    const extra = b.extra || {};
    const rows = BIZ_FIELDS.map(({ k, label, type, wide }) => `
        <label class="biz-field${wide ? ' wide' : ''}">
            <span>${label}${locked.has(k) ? ' <i class="lock" title="נערך ידנית — סנכרון לא ידרוס">✎</i>' : ''}</span>
            <input id="bf-${k}" type="${type || 'text'}" value="${esc(b[k] || '')}">
        </label>`).join('');
    // שורות ריקות נוספות כדי שתמיד יהיה מקום להוסיף שדה חדש
    const extraRows = [...Object.entries(extra), ['', ''], ['', '']].map(([k, v], i) => `
        <div class="biz-extra-row">
            <input class="bx-k" data-i="${i}" placeholder="שם השדה (למשל: איש קשר)" value="${esc(k)}">
            <input class="bx-v" data-i="${i}" placeholder="הערך" value="${esc(v)}">
        </div>`).join('');
    return `
        <div class="biz-fields">${rows}</div>
        <div class="biz-extra">
            <div class="hint">שדות נוספים משלך — אפשר להוסיף כל פרט שחסר (שעות פתיחה, איש קשר, כתובת…)</div>
            ${extraRows}
        </div>
        <div class="row" style="margin-top:10px">
            <button class="btn" onclick="sinitSaveBizFields()">שמירת הפרטים</button>
            <span class="hint" id="bizFieldsHint"></span>
        </div>`;
}

async function sinitSaveBizFields() {
    const body = { extra: {} };
    for (const { k } of BIZ_FIELDS) {
        const input = el(`bf-${k}`);
        if (input) body[k] = input.value.trim();
    }
    if (!body.name) { el('bizFieldsHint').textContent = 'שם העסק לא יכול להישאר ריק'; return; }
    document.querySelectorAll('.biz-extra-row').forEach((row) => {
        const k = row.querySelector('.bx-k').value.trim();
        const v = row.querySelector('.bx-v').value.trim();
        if (k && v) body.extra[k] = v;
    });
    try {
        await api(`/api/sinit/businesses/${S.modalId}`, { method: 'PUT', body });
        await sinitLoadOverview();
        await refreshModal();
        sinitToast('הפרטים נשמרו');
    } catch (e) { sinitToast(e.message, 'err'); }
}

function setView(view) {
    S.view = view;
    localStorage.setItem('sinit_view', view);
    renderBusinesses();
}

async function sinitSetColor(id, color) {
    try {
        await api(`/api/sinit/businesses/${id}`, { method: 'PUT', body: { color } });
        const b = S.businesses.find((x) => x.id === id);
        if (b) b.color = color || null;
        renderBusinesses();
    } catch (e) { alert(e.message); }
}

async function sinitToggleHighlight(id) {
    const b = S.businesses.find((x) => x.id === id);
    if (!b) return;
    try {
        await api(`/api/sinit/businesses/${id}`, { method: 'PUT', body: { highlight: b.highlight ? 0 : 1 } });
        b.highlight = b.highlight ? 0 : 1;
        renderBusinesses();
    } catch (e) { alert(e.message); }
}

async function sinitDeleteBiz(id) {
    const b = S.businesses.find((x) => x.id === id);
    if (!confirm(`למחוק את "${b?.name || 'העסק'}"? יימחקו גם כל התגובות וההיסטוריה שלו, וזה בלתי הפיך.`)) return;
    try {
        await api(`/api/sinit/businesses/${id}`, { method: 'DELETE' });
        if (S.modalId === id) { S.modalId = null; el('sbizModalOverlay')?.classList.add('hidden'); }
        await sinitLoadOverview();
    } catch (e) { alert(e.message); }
}

// העברת עסק לטיפול בלשונית "שאלות ומענה" — נפתחת שאלה מקושרת לעסק, עם שלבי מענה
async function sinitMoveToQuestions(id) {
    const b = S.businesses.find((x) => x.id === id);
    if (!b) return;
    const text = await sinitPrompt({
        title: `העברה לטיפול — ${b.name}`,
        hint: 'הטקסט ייפתח כשאלה בלשונית "שאלות ומענה", מקושרת לעסק הזה.',
        value: `לטפל בעסק ${b.name}${b.status ? ` (סטטוס: ${b.status})` : ''}`,
        okLabel: 'העברה לשאלות', rows: 5,
    });
    if (text === null || !text.trim()) return;
    try {
        const r = await api('/api/sinit/questions', { method: 'POST', body: {
            text: text.trim(), business_id: id, send_email: false,
        } });
        await Promise.all([sinitLoadQuestions(), sinitLoadOverview()]);
        if (S.modalId === id) await refreshModal();
        // גלילה ישירה לרשומה החדשה, כדי שרואים לאן זה הלך
        el('hd-squestions')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        sinitToast(r.ok ? 'העסק הועבר לטיפול — ראי בלשונית "שאלות ומענה"' : 'ההעברה נכשלה', r.ok ? 'ok' : 'err');
    } catch (e) { alert(e.message); }
}

/* ---------- חלון עסק ---------- */
async function sinitOpenBiz(id) {
    if (!el('sbizModalOverlay')) return;
    S.modalId = id;
    el('sbizModalOverlay').classList.remove('hidden');
    el('sbizModalTitle').textContent = 'טוענת...';
    try { renderBizModal(await api(`/api/sinit/businesses/${id}/detail`)); }
    catch (e) { el('sbizModalTitle').textContent = e.message || 'שגיאה'; }
}

function renderBizModal(d) {
    const b = d.biz;
    el('sbizModalTitle').textContent = b.name;
    el('sbizModalMeta').innerHTML = [
        b.contacted_by ? `פנתה: ${esc(b.contacted_by)}` : '',
        b.phone ? `טלפון העסק: ${esc(b.phone)}` : '',
        b.reporter_phone ? `דווח מהטלפון: ${esc(b.reporter_phone)}` : '',
        b.reported_at ? `מועד הדיווח: ${esc(b.reported_at)}` : '',
        b.email ? `מייל: ${esc(b.email)}` : '',
        b.product ? `מוצר: ${esc(b.product)}` : '',
        b.value_nis ? `שווי: ${esc(b.value_nis)} ₪` : '',
        b.pickup ? `איסוף: ${esc(b.pickup)}` : '',
        b.validity ? `תוקף: ${esc(b.validity)}` : '',
        b.contact_number ? `מס' פנייה: ${esc(b.contact_number)}` : '',
        b.message_number ? `מס' הודעה: ${esc(b.message_number)}` : '',
        `מקור: ${esc(b.source || 'ידני')}`,
        b.synced_at ? `סונכרן: ${fmtDate(b.synced_at)}` : '',
    ].filter(Boolean).join(' · ')
        + ` <span class="badge ${STATUS_CLASS[b.status] || ''}">${esc(b.status)}</span>`
        + (b.logo_url ? ` · <a href="${esc(b.logo_url)}" target="_blank" rel="noopener">לוגו</a>` : '');

    if (el('sbizModalFields')) {
        el('sbizModalFields').innerHTML = canWrite() ? sinitEditFields(d)
            : '<span class="hint">הקישור שלך הוא לצפייה בלבד</span>';
    }

    // פרטים חופשיים שנוספו ידנית מוצגים גם בשורת הכותרת
    const extraPairs = Object.entries(b.extra || {});
    if (el('sbizModalExtra')) {
        el('sbizModalExtra').innerHTML = extraPairs.length
            ? extraPairs.map(([k, v]) => `<span class="chip-tag">${esc(k)}: ${esc(v)}</span>`).join(' ')
            : '';
    }

    if (el('sbizModalStatus')) {
        el('sbizModalStatus').value = b.status;
        el('sbizModalStatus').disabled = !canWrite();
    }

    el('sbizModalColors').innerHTML = canWrite() ? `
        <button class="dot-btn${b.highlight ? ' on' : ''}" onclick="sinitModalHighlight()">⭐ ${b.highlight ? 'מודגש' : 'הדגשה'}</button>
        ${(d.colors || []).map((c) => `<button class="swatch${b.color === c ? ' on' : ''}" style="background:${c}"
            onclick="sinitModalColor('${c}')"></button>`).join('')}
        <button class="swatch clear" onclick="sinitModalColor('')">בלי צבע</button>`
        : '<span class="hint">הקישור שלך הוא לצפייה בלבד</span>';

    el('sbizModalStages').innerHTML = d.stages.map((s) => `
        <label class="stage-item${s.done ? ' done' : ''}">
            <input type="checkbox" ${s.done ? 'checked' : ''} ${canWrite() ? '' : 'disabled'}
                   onchange="sinitToggleStage(${s.id}, this.checked)">
            <span class="stage-name">${esc(s.name)}</span>
            ${s.done ? `<span class="hint">${esc(s.done_by || '')} · ${fmtDate(s.done_at)}</span>` : ''}
            ${s.note ? `<span class="stage-note">${esc(s.note)}</span>` : ''}
            ${canWrite() ? `<button class="link-btn" onclick="event.preventDefault();sinitStageNote(${s.id})">הערה</button>` : ''}
        </label>`).join('') || '<div class="hint">לא הוגדרו שלבי סגירה</div>';

    const notes = d.notes;
    el('sbizModalNotes').innerHTML = notes.length ? notes.map((n, i) => `
        <div class="modal-note${i === 0 ? ' latest' : ''}">
            <div class="modal-note-num">${notes.length - i}</div>
            <div class="modal-note-body">
                <div class="modal-note-text">${esc(n.text)}</div>
                <div class="modal-note-meta">
                    ${i === 0 ? '<span class="badge ok">עדכון אחרון</span> · ' : ''}${esc(n.created_by || '')} · ${fmtDate(n.created_at)}
                    ${n.contact_number ? ` · מס' פנייה: ${esc(n.contact_number)}` : ''}${n.message_number ? ` · מס' הודעה: ${esc(n.message_number)}` : ''}
                    ${canWrite() ? `<button class="modal-note-del" onclick="sinitDeleteNote(${n.id})" title="מחיקת רשומה">✕</button>` : ''}
                </div>
            </div>
        </div>`).join('') : '<div class="empty">אין עדיין תגובות</div>';

    applyWriteMode();

    if (el('sbizModalQuestions')) {
        el('sbizModalQuestions').innerHTML = d.questions.length
            ? d.questions.map((q) => `<div class="q-mini"><span class="badge ${Q_STATUS_CLASS[q.status] || ''}">${esc(q.status)}</span>
                ${esc(q.text)}${q.answer ? `<div class="q-mini-answer">${esc(q.answer)}</div>` : ''}</div>`).join('')
            : '<div class="hint">לא נשאלו שאלות על העסק הזה</div>';
    }
    if (el('sbizModalMentions')) {
        el('sbizModalMentions').innerHTML = d.mentions.length
            ? d.mentions.map((m) => `<div class="mention">${esc(m.at)} · ${esc(m.who)} · ${esc(m.action)}
                ${m.points ? `<span class="hint">(${esc(m.points)} נק')</span>` : ''}</div>`).join('')
            : '<div class="hint">אין אזכורים בגיליון התנועות</div>';
    }
    if (el('sbizDeleteWrap')) {
        el('sbizDeleteWrap').innerHTML = [
            canWrite() ? `<button class="btn secondary" onclick="sinitMoveToQuestions(${b.id})">➜ העברה לשאלות ומענה</button>` : '',
            S.overview?.isManager ? `<button class="btn danger" onclick="sinitDeleteBiz(${b.id})">מחיקת העסק</button>` : '',
        ].filter(Boolean).join(' ');
    }
}

// רענון החלון תוך שמירה על מה שהוקלד ועדיין לא נשמר
const DRAFT_FIELDS = ['sbizNewNote', 'sbizNoteContactNum', 'sbizNoteMessageNum', 'sbizQuestionText'];
const refreshModal = async () => {
    if (!S.modalId) return;
    const draft = DRAFT_FIELDS.map((id) => [id, el(id)?.value]);
    await sinitOpenBiz(S.modalId);
    draft.forEach(([id, v]) => { if (v && el(id)) el(id).value = v; });
};

async function sinitModalColor(color) {
    try { await api(`/api/sinit/businesses/${S.modalId}`, { method: 'PUT', body: { color } }); }
    catch (e) { return alert(e.message); }
    await sinitLoadOverview(); await refreshModal();
}

async function sinitModalHighlight() {
    const b = S.businesses.find((x) => x.id === S.modalId);
    try { await api(`/api/sinit/businesses/${S.modalId}`, { method: 'PUT', body: { highlight: b?.highlight ? 0 : 1 } }); }
    catch (e) { return alert(e.message); }
    await sinitLoadOverview(); await refreshModal();
}

async function sinitToggleStage(stageId, done) {
    try {
        await api(`/api/sinit/businesses/${S.modalId}/stages/${stageId}`, { method: 'POST', body: { done } });
        await sinitLoadOverview(); await refreshModal();
    } catch (e) { alert(e.message); }
}

async function sinitStageNote(stageId) {
    const note = await sinitPrompt({ title: 'הערה לשלב הסגירה', placeholder: 'מה קרה בשלב הזה...', rows: 4 });
    if (note === null) return;
    try {
        const stage = (await api(`/api/sinit/businesses/${S.modalId}/detail`)).stages.find((s) => s.id === stageId);
        await api(`/api/sinit/businesses/${S.modalId}/stages/${stageId}`, { method: 'POST', body: { done: stage?.done ? 1 : 0, note } });
        await refreshModal();
    } catch (e) { alert(e.message); }
}

async function sinitDeleteNote(noteId) {
    if (!confirm('למחוק את הרשומה?')) return;
    try {
        await api(`/api/sinit/businesses/${S.modalId}/notes/${noteId}`, { method: 'DELETE' });
        await sinitLoadOverview(); await refreshModal();
    } catch (e) { alert(e.message); }
}

/* ---------- שאלות ושלבי מענה ---------- */
function renderQuestions() {
    if (!el('squestionsList')) return;
    const q = S.f.question.toLowerCase();
    const rows = S.questions.filter((x) => !q
        || (x.text || '').toLowerCase().includes(q)
        || (x.answer || '').toLowerCase().includes(q)
        || (x.asked_by || '').toLowerCase().includes(q));
    if (el('squestionsEmpty')) el('squestionsEmpty').style.display = rows.length ? 'none' : 'block';
    el('squestionsList').innerHTML = rows.map((x) => `
        <div class="q-card">
            <div class="q-head">
                <span class="badge ${Q_STATUS_CLASS[x.status] || ''}">${esc(x.status)}</span>
                ${x.origin === 'AI' ? '<span class="badge">הגיעה מה-AI</span>' : ''}
                <span class="q-text">${esc(x.text)}</span>
            </div>
            <div class="q-meta">שאלה: ${esc(x.asked_by || '')} · ${fmtDate(x.created_at)}
                ${x.business_name ? ` · עסק: ${esc(x.business_name)}` : ''}
                ${x.email_sent_at ? ` · נשלח מייל ל${esc(x.email_to || '')} ב${fmtDate(x.email_sent_at)}` : ''}</div>
            <div class="q-steps">
                ${x.steps.map((s, i) => `<div class="q-step"><span class="q-step-num">${i + 1}</span>
                    <span>${esc(s.text)}</span><span class="hint">${esc(s.created_by || '')} · ${fmtDate(s.created_at)}</span></div>`).join('')}
            </div>
            ${x.answer ? `<div class="q-answer"><b>התשובה:</b> ${esc(x.answer)}
                <span class="hint">${esc(x.answered_by || '')} · ${fmtDate(x.answered_at)}</span></div>` : ''}
            ${x.business_id ? `<div class="q-actions">
                <button class="btn secondary" onclick="sinitOpenBiz(${x.business_id})">📋 פרטי הדיווח של ${esc(x.business_name || 'העסק')}</button>
            </div>` : ''}
            ${canWrite() ? `<div class="q-actions">
                <button class="btn secondary" onclick="sinitAddStep(${x.id})">➕ שלב מענה</button>
                <button class="btn" onclick="sinitAnswer(${x.id})">✍ ${x.answer ? 'עדכון התשובה' : 'כתיבת תשובה'}</button>
                ${x.status !== 'נסגרה' ? `<button class="btn secondary" onclick="sinitCloseQuestion(${x.id})">סגירה</button>` : ''}
                ${S.overview?.isManager ? `<button class="btn danger" onclick="sinitDeleteQuestion(${x.id})">מחיקה</button>` : ''}
            </div>` : ''}
        </div>`).join('');
}

async function sinitAddQuestion() {
    const text = el('squestionText').value.trim();
    if (!text) return;
    try {
        const r = await api('/api/sinit/questions', { method: 'POST', body: {
            text, business_id: el('squestionBiz')?.value || null, send_email: el('squestionMail')?.checked ?? true,
        } });
        el('squestionText').value = '';
        if (el('squestionMail')?.checked ?? true) {
            sinitToast(r.mail?.sent ? `השאלה נרשמה ונשלח מייל ל${r.mail.to}` : `השאלה נרשמה, אבל המייל לא נשלח: ${r.mail?.error || 'שגיאה'}`, r.mail?.sent ? 'ok' : 'err');
        }
        await Promise.all([sinitLoadQuestions(), sinitLoadOverview()]);
    } catch (e) { alert(e.message); }
}

async function sinitAddStep(id) {
    const text = await sinitPrompt({
        title: 'הוספת שלב מענה',
        hint: 'מה נעשה עכשיו בשאלה הזו — למי פנו, מה נבדק, מה הוחלט.',
        placeholder: 'למשל: העברתי לנחמי לבדיקה מול ההנהלה', rows: 5, okLabel: 'הוספת שלב',
    });
    if (!text || !text.trim()) return;
    try { await api(`/api/sinit/questions/${id}/steps`, { method: 'POST', body: { text: text.trim() } }); await sinitLoadQuestions(); }
    catch (e) { alert(e.message); }
}

async function sinitAnswer(id) {
    const current = S.questions.find((q) => q.id === id)?.answer || '';
    const q = S.questions.find((x) => x.id === id);
    const answer = await sinitPrompt({
        title: 'כתיבת התשובה',
        hint: q ? q.text : '',
        value: current, placeholder: 'התשובה שתיראה לכל מי שתשאל את זה...', rows: 8, okLabel: 'שמירת התשובה',
    });
    if (answer === null) return;
    try {
        await api(`/api/sinit/questions/${id}`, { method: 'PUT', body: { answer, status: 'נענתה' } });
        await Promise.all([sinitLoadQuestions(), sinitLoadOverview()]);
    } catch (e) { alert(e.message); }
}

async function sinitCloseQuestion(id) {
    try {
        await api(`/api/sinit/questions/${id}`, { method: 'PUT', body: { status: 'נסגרה' } });
        await Promise.all([sinitLoadQuestions(), sinitLoadOverview()]);
    } catch (e) { alert(e.message); }
}

async function sinitDeleteQuestion(id) {
    if (!confirm('למחוק את השאלה וכל שלבי המענה שלה?')) return;
    try { await api(`/api/sinit/questions/${id}`, { method: 'DELETE' }); await Promise.all([sinitLoadQuestions(), sinitLoadOverview()]); }
    catch (e) { alert(e.message); }
}

/* ---------- צ'אט AI ---------- */
function bubbleHtml(a) {
    const noAnswer = !a.answer;
    return `
        <div class="msg me"><div class="bubble">${esc(a.question)}</div>
            <div class="msg-meta">${esc(a.asked_by || '')} · ${fmtDate(a.created_at)}</div></div>
        <div class="msg bot">
            <div class="bubble${noAnswer ? ' empty' : ''}">
                ${noAnswer ? 'לא מצאתי תשובה לשאלה הזו בחומר שהועלה למערכת.' : esc(a.answer)}
                <div class="bubble-foot">
                    <span class="badge ${AI_OUTCOME_CLASS[a.outcome] || ''}">${esc(a.outcome)}</span>
                    ${a.source_doc ? `<span class="hint">מתוך "${esc(a.source_doc)}"</span>` : ''}
                    ${a.question_id ? `<span class="hint">✓ נשלחה למנהלת${a.question_status ? ` · ${esc(a.question_status)}` : ''}</span>` : ''}
                </div>
                ${(noAnswer && !a.question_id && canWrite())
                    ? `<button class="btn chat-escalate" onclick="sinitEscalate(${a.id})">✉ שליחת השאלה למנהלת המערכת</button>` : ''}
            </div>
        </div>`;
}

function renderAiChat(extra = '') {
    const log = el('saiChat');
    if (!log) return;
    const items = [...S.aiLog].reverse(); // הישן למעלה, החדש למטה — כמו בצ'אט
    log.innerHTML = (items.length
        ? items.map(bubbleHtml).join('')
        : '<div class="chat-hello">אפשר לשאול אותי כל שאלה על הקמפיין. אני עונה מתוך קבצי הוורד שהמנהלת העלתה, ואם אין לי תשובה — אציע לשלוח את השאלה אליה.</div>')
        + extra;
    log.scrollTop = log.scrollHeight;
}

async function sinitAsk() {
    const input = el('saiQuestion');
    const question = input.value.trim();
    if (!question || S.asking) return;
    S.asking = true;
    input.value = '';
    renderAiChat(`
        <div class="msg me"><div class="bubble">${esc(question)}</div></div>
        <div class="msg bot"><div class="bubble typing"><span></span><span></span><span></span></div></div>`);
    try {
        await api('/api/sinit/ai/ask', { method: 'POST', body: { question } });
        await sinitLoadAi();
    } catch (e) {
        renderAiChat(`<div class="msg bot"><div class="bubble empty">${esc(e.message)}</div></div>`);
    } finally { S.asking = false; }
}

async function sinitEscalate(logId) {
    try {
        const r = await api(`/api/sinit/ai/escalate/${logId}`, { method: 'POST' });
        sinitToast(r.mail?.sent
            ? `השאלה נרשמה ונשלח מייל ל${r.mail.to}`
            : `השאלה נרשמה אצל המנהלת, אבל המייל לא נשלח: ${r.mail?.error || 'שגיאה'}`, r.mail?.sent ? 'ok' : 'err');
        await Promise.all([sinitLoadAi(), sinitLoadQuestions(), sinitLoadOverview()]);
    } catch (e) { alert(e.message); }
}

/* ---------- חיווט ---------- */
function wireSinit() {
    if (S.wired) return;
    S.wired = true;

    document.querySelectorAll('.view-switch button').forEach((btn) => {
        btn.addEventListener('click', () => setView(btn.dataset.view));
    });

    on('sbizSearch', 'input', (e) => { S.f.q = e.target.value.trim(); renderBusinesses(); });
    const filterMap = { sbizStatusFilter: 'status', sbizStageFilter: 'stage', sbizSourceFilter: 'source', sbizColorFilter: 'color' };
    Object.keys(filterMap).forEach((id) => on(id, 'change', (e) => { S.f[filterMap[id]] = e.target.value; renderBusinesses(); }));
    on('squestionSearch', 'input', (e) => { S.f.question = e.target.value.trim(); renderQuestions(); });

    on('sbizAddToggle', 'click', () => el('sbizAddBox').classList.toggle('hidden'));
    on('sbizAddBtn', 'click', async () => {
        const name = el('sbizName').value.trim();
        if (!name) return alert('יש להזין שם עסק');
        try {
            await api('/api/sinit/businesses', { method: 'POST', body: {
                name, contacted_by: el('sbizContactedBy').value, phone: el('sbizPhone').value,
                email: el('sbizEmail').value, product: el('sbizProduct').value, value_nis: el('sbizValue').value,
                contact_number: el('sbizContactNumber').value, message_number: el('sbizMessageNumber').value,
                status: el('sbizStatus').value, response: el('sbizResponse').value,
            } });
            ['sbizName', 'sbizContactedBy', 'sbizPhone', 'sbizEmail', 'sbizProduct', 'sbizValue',
                'sbizContactNumber', 'sbizMessageNumber', 'sbizResponse'].forEach((id) => { el(id).value = ''; });
            await sinitLoadOverview();
        } catch (e) { alert(e.message); }
    });

    on('sbizAddStatusBtn', 'click', async () => {
        const name = await sinitPrompt({ title: 'סטטוס חדש לעסקים', placeholder: 'למשל: ממתין לחשבונית', rows: 2, okLabel: 'הוספה' });
        if (!name || !name.trim()) return;
        try { await api('/api/sinit/statuses', { method: 'POST', body: { name: name.trim() } }); await sinitLoadOverview(); }
        catch (e) { alert(e.message); }
    });

    on('sbizSyncBtn', 'click', async () => {
        const btn = el('sbizSyncBtn');
        btn.disabled = true; btn.textContent = '⟳ מסנכרנת...';
        try {
            const r = await api('/api/sinit/sync', { method: 'POST' });
            await sinitLoadOverview();
            sinitToast('הסנכרון הסתיים — ' + r.sources.map((s) => (s.error
                ? `${s.name}: שגיאה`
                : `${s.name}: +${s.added}`)).join(' · '), (r.errors || []).length ? 'err' : 'ok');
        } catch (e) { alert(e.message); }
        finally { btn.disabled = false; btn.textContent = '⟳ סנכרון עכשיו'; }
    });

    on('sbizExportBtn', 'click', () => downloadFile('/api/sinit/businesses/export.xlsx', 'עסקים — מכירה סינית.xlsx'));

    const closeModal = () => { S.modalId = null; el('sbizModalOverlay').classList.add('hidden'); };
    on('sbizModalClose', 'click', closeModal);
    on('sbizModalOverlay', 'click', (e) => { if (e.target.id === 'sbizModalOverlay') closeModal(); });
    on('sbizModalStatus', 'change', async (e) => {
        try {
            await api(`/api/sinit/businesses/${S.modalId}`, { method: 'PUT', body: { status: e.target.value } });
            await sinitLoadOverview(); await refreshModal();
        } catch (err) { alert(err.message); }
    });
    on('sbizAddNoteBtn', 'click', async () => {
        const text = el('sbizNewNote').value.trim();
        if (!text || !S.modalId) return;
        try {
            await api(`/api/sinit/businesses/${S.modalId}/notes`, { method: 'POST', body: {
                text, contact_number: el('sbizNoteContactNum').value, message_number: el('sbizNoteMessageNum').value,
            } });
            el('sbizNewNote').value = ''; el('sbizNoteContactNum').value = ''; el('sbizNoteMessageNum').value = '';
            await sinitLoadOverview(); await refreshModal();
        } catch (e) { alert(e.message); }
    });
    on('sbizAskBtn', 'click', async () => {
        const text = el('sbizQuestionText').value.trim();
        if (!text || !S.modalId) return;
        try {
            const r = await api('/api/sinit/questions', { method: 'POST', body: { text, business_id: S.modalId, send_email: true } });
            el('sbizQuestionText').value = '';
            sinitToast(r.mail?.sent ? `השאלה נרשמה ונשלח מייל ל${r.mail.to}` : `השאלה נרשמה, המייל לא נשלח: ${r.mail?.error || 'שגיאה'}`, r.mail?.sent ? 'ok' : 'err');
            await Promise.all([sinitLoadQuestions(), sinitLoadOverview()]);
            await refreshModal();
        } catch (e) { alert(e.message); }
    });

    on('squestionAddBtn', 'click', sinitAddQuestion);
    on('squestionText', 'keydown', (e) => { if (e.key === 'Enter') sinitAddQuestion(); });

    on('saiAskBtn', 'click', sinitAsk);
    on('saiQuestion', 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sinitAsk(); } });

    applyWriteMode();
}

window.sinitInit = function sinitInit() {
    if (!shareMode() && (!USER || !(USER.features || []).includes('campaign'))) return;
    wireSinit();
    sinitLoadAll();
};
window.sinitActivate = window.sinitInit;

// campaign.js מריץ את startApp לפני שהקובץ הזה נטען, ולכן מאתחלים גם כאן אם המסך כבר פתוח
if (!el('share-gate') && typeof USER !== 'undefined' && USER && !el('app')?.classList.contains('hidden')) window.sinitInit();
