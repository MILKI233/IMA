/* לשונית "מכירה סינית" — עסקים מכל הטפסים, שלבי סגירה, צביעה, שאלות למנהלת ומענה AI.
   נשענת על api()/fmtDate()/downloadFile()/USER מתוך campaign.js שנטען לפניה. */

const S = {
    businesses: [], stages: [], statuses: [], sources: [], questions: [], kb: [], aiLog: [],
    overview: null, modalId: null, wired: false,
    f: { q: '', status: '', stage: '', source: '', color: '', question: '' },
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const el = (id) => document.getElementById(id);
const canSettings = () => (USER?.features || []).includes('campaign_settings');

const STATUS_CLASS = { 'ממתין': 'warn', 'תרם': 'ok', 'סירב': 'bad', 'נוצר קשר': '' };
const Q_STATUS_CLASS = { 'נשאלה': 'warn', 'נשלחה למנהלת': 'warn', 'בטיפול': '', 'נענתה': 'ok', 'נסגרה': 'ok' };
const AI_OUTCOME_CLASS = { 'מהחומר': 'ok', 'AI מהחומר': 'ok', 'אין מענה': 'bad' };

/* ---------- טעינה ---------- */
async function sinitLoadOverview() {
    const o = await api('/api/sinit/overview');
    S.overview = o;
    S.businesses = o.businesses;
    S.stages = o.stages;
    S.statuses = o.statuses;
    S.sources = o.sources;
    renderStats();
    renderSyncInfo();
    fillSelects();
    renderBusinesses();
    renderStageEditor();
    renderSources();
    el('sAdminEmail').value = o.adminEmail || '';
    el('sAdminName').value = o.adminName || '';
    el('squestionMailHint').textContent = o.adminEmail
        ? `המייל יישלח ל${o.adminEmail}${o.mailReady ? '' : ' — אך חיבור ה-Gmail לא מוגדר עדיין'}`
        : 'לא הוגדרה כתובת מייל למנהלת — אפשר להגדיר בהגדרות הלשונית למטה';
    el('saiReadyHint').textContent = o.kbDocs
        ? `${o.kbDocs} קבצים · ${o.kbPairs} שאלות בחומר${o.aiReady ? '' : ' · מפתח AI לא מוגדר, עונה רק מהתאמה ישירה'}`
        : 'עדיין לא הועלו קבצי וורד — ה-AI יציע לשלוח מייל למנהלת';
}

async function sinitLoadQuestions() {
    S.questions = await api('/api/sinit/questions');
    renderQuestions();
}

async function sinitLoadAi() {
    S.aiLog = await api('/api/sinit/ai/log');
    renderAiFeed();
}

async function sinitLoadKb() {
    S.kb = await api('/api/sinit/kb');
    renderKb();
}

async function sinitLoadAll() {
    try {
        await Promise.all([sinitLoadOverview(), sinitLoadQuestions(), sinitLoadAi(), sinitLoadKb()]);
    } catch (e) {
        if (e.status === 403) el('sinitSyncInfo').innerHTML = '<span class="hint">אין לך הרשאת גישה ללשונית הזו</span>';
        else console.error('טעינת לשונית מכירה סינית נכשלה:', e.message);
    }
}

/* ---------- סטטיסטיקה וסנכרון ---------- */
function renderStats() {
    const o = S.overview || {};
    const biz = S.businesses;
    const donated = biz.filter((b) => b.status === 'תרם').length;
    const closed = biz.filter((b) => b.stages_total && b.stages_done === b.stages_total).length;
    el('sinitStats').innerHTML = `
        <div class="stat-card"><div class="stat-num">${biz.length}</div><div class="stat-label">עסקים</div></div>
        <div class="stat-card"><div class="stat-num">${donated}</div><div class="stat-label">תרמו</div></div>
        <div class="stat-card"><div class="stat-num">${closed}</div><div class="stat-label">סגורים לגמרי</div></div>
        <div class="stat-card${o.questionsOpen ? ' alert' : ''}"><div class="stat-num">${o.questionsOpen || 0}</div><div class="stat-label">שאלות פתוחות</div></div>
        <div class="stat-card"><div class="stat-num">${o.kbPairs || 0}</div><div class="stat-label">שאלות בבסיס הידע</div></div>`;
    setNavTooltip('hd-sbiz', `${biz.length} עסקים · ${donated} תרמו · ${closed} סגורים`);
    setNavTooltip('hd-squestions', `${o.questionsOpen || 0} שאלות פתוחות`);
    setNavTooltip('hd-skb', `${o.kbDocs || 0} קבצי וורד · ${o.kbPairs || 0} שאלות`);
}

function renderSyncInfo() {
    const o = S.overview || {};
    const parts = [];
    if (o.sheetsSyncedAt) parts.push(`הטפסים סונכרנו: ${fmtDate(o.sheetsSyncedAt)}`);
    parts.push(`${o.recruitedRows || 0} שורות בטופס התרומות`);
    if (S.sources.length) parts.push(`${S.sources.length} מקורות נוספים`);
    const synced = S.businesses.filter((b) => b.source && b.source !== 'ידני').length;
    parts.push(`${synced} עסקים נכנסו מהטפסים`);
    el('sinitSyncInfo').innerHTML = `<span class="hint">⟳ ${parts.join(' · ')}</span>` +
        (o.sheetsError ? `<div class="err-line">שגיאת סנכרון: ${esc(o.sheetsError)}</div>` : '');
}

function fillSelects() {
    const statusOpts = S.statuses.map((s) => `<option>${esc(s)}</option>`).join('');
    el('sbizStatus').innerHTML = statusOpts;
    el('sbizModalStatus').innerHTML = statusOpts;
    el('sbizStatusFilter').innerHTML = '<option value="">כל הסטטוסים</option>' + statusOpts;
    el('sbizStageFilter').innerHTML = '<option value="">כל שלבי הסגירה</option>'
        + S.stages.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')
        + '<option value="none">לא התחילו שלבים</option><option value="all">סיימו את כל השלבים</option>';
    const sources = [...new Set(S.businesses.map((b) => b.source || 'ידני'))];
    el('sbizSourceFilter').innerHTML = '<option value="">כל המקורות</option>'
        + sources.map((s) => `<option>${esc(s)}</option>`).join('');
    el('squestionBiz').innerHTML = '<option value="">ללא קשר לעסק מסוים</option>'
        + S.businesses.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
    // שומרים את הבחירות הקיימות אחרי רענון
    el('sbizStatusFilter').value = S.f.status;
    el('sbizStageFilter').value = S.f.stage;
    el('sbizSourceFilter').value = S.f.source;
    el('sbizColorFilter').value = S.f.color;
}

/* ---------- עסקים ---------- */
function filteredBusinesses() {
    const q = S.f.q.toLowerCase();
    return S.businesses.filter((b) => {
        if (q && ![b.name, b.contacted_by, b.phone, b.email, b.product, b.response]
            .some((v) => String(v || '').toLowerCase().includes(q))) return false;
        if (S.f.status && b.status !== S.f.status) return false;
        if (S.f.source && (b.source || 'ידני') !== S.f.source) return false;
        if (S.f.stage === 'none' && b.stages_done > 0) return false;
        if (S.f.stage === 'all' && !(b.stages_total && b.stages_done === b.stages_total)) return false;
        if (S.f.stage && !['none', 'all'].includes(S.f.stage) && !b.done_stage_ids.includes(Number(S.f.stage))) return false;
        if (S.f.color === 'marked' && !b.highlight) return false;
        if (S.f.color === 'colored' && !b.color) return false;
        if (S.f.color === 'plain' && b.color) return false;
        return true;
    });
}

function stageBar(b) {
    if (!b.stages_total) return '<span class="hint">אין שלבים</span>';
    const pct = Math.round((b.stages_done / b.stages_total) * 100);
    return `<div class="stage-mini" title="${esc(b.current_stage || 'טרם התחיל')}">
        <div class="stage-mini-bar"><div class="stage-mini-fill" style="width:${pct}%"></div></div>
        <span class="stage-mini-txt">${b.stages_done}/${b.stages_total}${b.current_stage ? ` · ${esc(b.current_stage)}` : ''}</span>
    </div>`;
}

function renderBusinesses() {
    const rows = filteredBusinesses();
    el('sbizCount').textContent = `מוצגים ${rows.length} מתוך ${S.businesses.length}`;
    el('sbizEmpty').style.display = rows.length ? 'none' : 'block';
    el('sbizTable').querySelector('tbody').innerHTML = rows.map((b) => `
        <tr class="biz-row${b.highlight ? ' marked' : ''}" style="${b.color ? `background:${esc(b.color)}` : ''}"
            onclick="sinitOpenBiz(${b.id})">
            <td>${b.highlight ? '⭐ ' : ''}${esc(b.name)}</td>
            <td>${esc(b.contacted_by || '—')}</td>
            <td>${esc(b.phone || '')}</td>
            <td>${esc(b.email || '')}</td>
            <td>${esc(b.product || '')}${b.value_nis ? ` <span class="hint">(${esc(b.value_nis)} ₪)</span>` : ''}</td>
            <td><span class="badge ${STATUS_CLASS[b.status] || ''}">${esc(b.status)}</span></td>
            <td>${stageBar(b)}</td>
            <td class="cell-wrap">${b.response ? esc(b.response) : '<span class="hint">אין תגובה</span>'}
                ${b.notes_count > 1 ? `<span class="hint"> · ${b.notes_count} רשומות</span>` : ''}</td>
            <td><span class="src-tag">${esc(b.source || 'ידני')}</span></td>
            <td class="color-cell" onclick="event.stopPropagation()">
                <button class="dot-btn${b.highlight ? ' on' : ''}" title="הדגשה" onclick="sinitToggleHighlight(${b.id})">⭐</button>
                ${(S.overview?.colors || []).map((c) => `<button class="dot-swatch${b.color === c ? ' on' : ''}"
                    style="background:${c}" title="צביעה" onclick="sinitSetColor(${b.id},'${c}')"></button>`).join('')}
                <button class="dot-swatch clear" title="ביטול צבע" onclick="sinitSetColor(${b.id},'')">✕</button>
            </td>
            <td onclick="event.stopPropagation()">
                ${S.overview?.isManager ? `<button class="btn danger" onclick="sinitDeleteBiz(${b.id})">מחיקה</button>` : ''}
            </td>
        </tr>`).join('');
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
    if (!confirm('למחוק את העסק, התגובות ושלבי הסגירה שלו?')) return;
    try { await api(`/api/sinit/businesses/${id}`, { method: 'DELETE' }); await sinitLoadOverview(); }
    catch (e) { alert(e.message); }
}

/* ---------- חלון עסק ---------- */
async function sinitOpenBiz(id) {
    S.modalId = id;
    el('sbizModalOverlay').classList.remove('hidden');
    el('sbizModalTitle').textContent = 'טוענת...';
    try {
        const d = await api(`/api/sinit/businesses/${id}/detail`);
        renderBizModal(d);
    } catch (e) { el('sbizModalTitle').textContent = e.message || 'שגיאה'; }
}

function renderBizModal(d) {
    const b = d.biz;
    el('sbizModalTitle').textContent = b.name;
    el('sbizModalMeta').innerHTML = [
        b.contacted_by ? `פנתה: ${esc(b.contacted_by)}` : '',
        b.phone ? `טלפון: ${esc(b.phone)}` : '',
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

    el('sbizModalStatus').value = b.status;

    el('sbizModalColors').innerHTML = `
        <button class="dot-btn${b.highlight ? ' on' : ''}" onclick="sinitModalHighlight()">⭐ ${b.highlight ? 'מודגש' : 'הדגשה'}</button>
        ${(d.colors || []).map((c) => `<button class="swatch${b.color === c ? ' on' : ''}" style="background:${c}"
            onclick="sinitModalColor('${c}')"></button>`).join('')}
        <button class="swatch clear" onclick="sinitModalColor('')">בלי צבע</button>`;

    el('sbizModalStages').innerHTML = d.stages.map((s) => `
        <label class="stage-item${s.done ? ' done' : ''}">
            <input type="checkbox" ${s.done ? 'checked' : ''} onchange="sinitToggleStage(${s.id}, this.checked)">
            <span class="stage-name">${esc(s.name)}</span>
            ${s.done ? `<span class="hint">${esc(s.done_by || '')} · ${fmtDate(s.done_at)}</span>` : ''}
            ${s.note ? `<span class="stage-note">${esc(s.note)}</span>` : ''}
            <button class="link-btn" onclick="event.preventDefault();sinitStageNote(${s.id})">הערה</button>
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
                    <button class="modal-note-del" onclick="sinitDeleteNote(${n.id})" title="מחיקת רשומה">✕</button>
                </div>
            </div>
        </div>`).join('') : '<div class="empty">אין עדיין תגובות</div>';

    el('sbizModalQuestions').innerHTML = d.questions.length
        ? d.questions.map((q) => `<div class="q-mini"><span class="badge ${Q_STATUS_CLASS[q.status] || ''}">${esc(q.status)}</span>
            ${esc(q.text)}${q.answer ? `<div class="q-mini-answer">${esc(q.answer)}</div>` : ''}</div>`).join('')
        : '<div class="hint">לא נשאלו שאלות על העסק הזה</div>';

    el('sbizModalMentions').innerHTML = d.mentions.length
        ? d.mentions.map((m) => `<div class="mention">${esc(m.at)} · ${esc(m.who)} · ${esc(m.action)}
            ${m.points ? `<span class="hint">(${esc(m.points)} נק')</span>` : ''}</div>`).join('')
        : '<div class="hint">אין אזכורים בגיליון התנועות</div>';
}

// רענון החלון תוך שמירה על מה שהוקלד ועדיין לא נשמר (תגובה/שאלה באמצע כתיבה)
const DRAFT_FIELDS = ['sbizNewNote', 'sbizNoteContactNum', 'sbizNoteMessageNum', 'sbizQuestionText'];
const refreshModal = async () => {
    if (!S.modalId) return;
    const draft = DRAFT_FIELDS.map((id) => [id, el(id).value]);
    await sinitOpenBiz(S.modalId);
    draft.forEach(([id, v]) => { if (v && el(id)) el(id).value = v; });
};

async function sinitModalColor(color) {
    await api(`/api/sinit/businesses/${S.modalId}`, { method: 'PUT', body: { color } }).catch((e) => alert(e.message));
    await sinitLoadOverview(); await refreshModal();
}

async function sinitModalHighlight() {
    const b = S.businesses.find((x) => x.id === S.modalId);
    await api(`/api/sinit/businesses/${S.modalId}`, { method: 'PUT', body: { highlight: b?.highlight ? 0 : 1 } })
        .catch((e) => alert(e.message));
    await sinitLoadOverview(); await refreshModal();
}

async function sinitToggleStage(stageId, done) {
    try {
        await api(`/api/sinit/businesses/${S.modalId}/stages/${stageId}`, { method: 'POST', body: { done } });
        await sinitLoadOverview(); await refreshModal();
    } catch (e) { alert(e.message); }
}

async function sinitStageNote(stageId) {
    const note = prompt('הערה לשלב הזה:');
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
    const q = S.f.question.toLowerCase();
    const rows = S.questions.filter((x) => !q
        || (x.text || '').toLowerCase().includes(q)
        || (x.answer || '').toLowerCase().includes(q)
        || (x.asked_by || '').toLowerCase().includes(q));
    el('squestionsEmpty').style.display = rows.length ? 'none' : 'block';
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
            <div class="q-actions">
                <button class="btn secondary" onclick="sinitAddStep(${x.id})">➕ שלב מענה</button>
                <button class="btn" onclick="sinitAnswer(${x.id})">✍ ${x.answer ? 'עדכון התשובה' : 'כתיבת תשובה'}</button>
                ${x.status !== 'נסגרה' ? `<button class="btn secondary" onclick="sinitCloseQuestion(${x.id})">סגירה</button>` : ''}
                ${S.overview?.isManager ? `<button class="btn danger" onclick="sinitDeleteQuestion(${x.id})">מחיקה</button>` : ''}
            </div>
        </div>`).join('');
}

async function sinitAddQuestion() {
    const text = el('squestionText').value.trim();
    if (!text) return;
    try {
        const r = await api('/api/sinit/questions', { method: 'POST', body: {
            text, business_id: el('squestionBiz').value || null, send_email: el('squestionMail').checked,
        } });
        el('squestionText').value = '';
        if (el('squestionMail').checked) {
            alert(r.mail?.sent ? `השאלה נרשמה ונשלח מייל ל${r.mail.to}` : `השאלה נרשמה, אבל המייל לא נשלח: ${r.mail?.error || 'שגיאה'}`);
        }
        await Promise.all([sinitLoadQuestions(), sinitLoadOverview()]);
    } catch (e) { alert(e.message); }
}

async function sinitAddStep(id) {
    const text = prompt('מה נעשה עכשיו בשאלה הזו? (שלב מענה)');
    if (!text || !text.trim()) return;
    try { await api(`/api/sinit/questions/${id}/steps`, { method: 'POST', body: { text: text.trim() } }); await sinitLoadQuestions(); }
    catch (e) { alert(e.message); }
}

async function sinitAnswer(id) {
    const current = S.questions.find((q) => q.id === id)?.answer || '';
    const answer = prompt('התשובה לשאלה:', current);
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

/* ---------- מענה AI ---------- */
function renderAiFeed() {
    el('saiEmpty').style.display = S.aiLog.length ? 'none' : 'block';
    el('saiFeed').innerHTML = S.aiLog.map((a) => `
        <div class="ai-item">
            <div class="ai-item-head">
                <span class="badge ${AI_OUTCOME_CLASS[a.outcome] || ''}">${esc(a.outcome)}</span>
                <span class="ai-q">${esc(a.question)}</span>
            </div>
            ${a.answer ? `<div class="ai-a">${esc(a.answer)}</div>` : '<div class="ai-a hint">לא נמצאה תשובה בחומר</div>'}
            <div class="ai-meta">${esc(a.asked_by || '')} · ${fmtDate(a.created_at)}
                ${a.source_doc ? ` · מתוך "${esc(a.source_doc)}"` : ''}
                ${a.question_id ? ` · נשלחה למנהלת (${esc(a.question_status || '')})` : ''}</div>
            ${(!a.answer && !a.question_id) ? `<button class="btn secondary" onclick="sinitEscalate(${a.id})">✉ שליחת השאלה למנהלת המערכת</button>` : ''}
        </div>`).join('');
}

async function sinitAsk() {
    const question = el('saiQuestion').value.trim();
    if (!question) return;
    const box = el('saiAnswer');
    box.classList.remove('hidden');
    box.innerHTML = '<div class="hint">בודקת בחומר שהועלה...</div>';
    try {
        const r = await api('/api/sinit/ai/ask', { method: 'POST', body: { question } });
        box.innerHTML = `
            <div class="ai-item-head"><span class="badge ${AI_OUTCOME_CLASS[r.outcome] || ''}">${esc(r.outcome)}</span>
                <span class="ai-q">${esc(question)}</span></div>
            <div class="ai-a">${esc(r.answer)}</div>
            ${r.matched_question ? `<div class="ai-meta">נמצאה שאלה זהה בחומר: "${esc(r.matched_question)}"</div>` : ''}
            ${r.source_doc ? `<div class="ai-meta">מתוך הקובץ "${esc(r.source_doc)}"</div>` : ''}
            ${r.needsAdmin ? `<button class="btn" onclick="sinitEscalate(${r.id})">✉ שליחת השאלה למנהלת המערכת</button>` : ''}`;
        el('saiQuestion').value = '';
        await sinitLoadAi();
    } catch (e) { box.innerHTML = `<div class="err-line">${esc(e.message)}</div>`; }
}

async function sinitEscalate(logId) {
    try {
        const r = await api(`/api/sinit/ai/escalate/${logId}`, { method: 'POST' });
        alert(r.mail?.sent
            ? `השאלה נרשמה ונשלח מייל ל${r.mail.to}`
            : `השאלה נרשמה בלשונית השאלות, אבל המייל לא נשלח: ${r.mail?.error || 'שגיאה'}`);
        await Promise.all([sinitLoadAi(), sinitLoadQuestions(), sinitLoadOverview()]);
    } catch (e) { alert(e.message); }
}

/* ---------- בסיס הידע ---------- */
function renderKb() {
    el('skbEmpty').style.display = S.kb.length ? 'none' : 'block';
    el('skbTable').querySelector('tbody').innerHTML = S.kb.map((d) => `
        <tr>
            <td>${esc(d.filename)}</td>
            <td>${d.pairs}</td>
            <td>${d.char_count}</td>
            <td>${esc(d.uploaded_by || '')}</td>
            <td>${fmtDate(d.uploaded_at)}</td>
            <td>
                <button class="btn secondary" onclick="sinitShowPairs(${d.id})">הצגת השאלות</button>
                ${canSettings() ? `<button class="btn danger" onclick="sinitDeleteDoc(${d.id})">מחיקה</button>` : ''}
            </td>
        </tr>`).join('');
}

async function sinitShowPairs(id) {
    try {
        const pairs = await api(`/api/sinit/kb/${id}/pairs`);
        const doc = S.kb.find((d) => d.id === id);
        el('skbStatus').innerHTML = pairs.length
            ? `<b>${esc(doc?.filename || '')}</b> — ${pairs.length} שאלות שזוהו:<ol class="kb-pairs">`
                + pairs.map((p) => `<li><b>${esc(p.question)}</b><br>${esc(p.answer)}</li>`).join('') + '</ol>'
            : `<b>${esc(doc?.filename || '')}</b> — לא זוהו זוגות שאלה-תשובה, אבל הטקסט המלא נשמר וה-AI יחפש בו.`;
    } catch (e) { alert(e.message); }
}

async function sinitUploadDoc(file) {
    if (!file) return;
    el('skbStatus').textContent = `מעלה את ${file.name}...`;
    const reader = new FileReader();
    reader.onload = async () => {
        const base64 = String(reader.result).split(',')[1] || '';
        try {
            const r = await api('/api/sinit/kb', { method: 'POST', body: { filename: file.name, data: base64 } });
            el('skbStatus').textContent = `${file.name} נטען: ${r.pairs} שאלות זוהו, ${r.chars} תווים נשמרו.`;
            await Promise.all([sinitLoadKb(), sinitLoadOverview()]);
        } catch (e) { el('skbStatus').innerHTML = `<span class="err-line">${esc(e.message)}</span>`; }
    };
    reader.readAsDataURL(file);
}

async function sinitDeleteDoc(id) {
    if (!confirm('למחוק את הקובץ מבסיס הידע? ה-AI יפסיק לשאוב ממנו תשובות.')) return;
    try { await api(`/api/sinit/kb/${id}`, { method: 'DELETE' }); await Promise.all([sinitLoadKb(), sinitLoadOverview()]); }
    catch (e) { alert(e.message); }
}

/* ---------- הגדרות: שלבים ומקורות ---------- */
function renderStageEditor() {
    el('sStagesList').innerHTML = S.stages.map((s) => `
        <span class="chip">${esc(s.name)}
            ${canSettings() ? `<button class="chip-x" title="מחיקת השלב" onclick="sinitDeleteStage(${s.id})">✕</button>` : ''}
        </span>`).join('') || '<span class="hint">אין שלבים</span>';
}

async function sinitDeleteStage(id) {
    if (!confirm('למחוק את השלב? הסימונים של השלב הזה בכל העסקים יימחקו.')) return;
    try { await api(`/api/sinit/stages/${id}`, { method: 'DELETE' }); await sinitLoadOverview(); }
    catch (e) { alert(e.message); }
}

function renderSources() {
    el('sSourcesTable').querySelector('tbody').innerHTML = S.sources.map((s) => `
        <tr>
            <td>${esc(s.name)}</td>
            <td>${esc(s.sheet_name)}</td>
            <td>${s.last_synced_at ? fmtDate(s.last_synced_at) : '<span class="hint">טרם</span>'}</td>
            <td>${s.last_rows ?? ''}</td>
            <td>${s.last_error ? `<span class="err-line">${esc(s.last_error)}</span>` : ''}</td>
            <td>${canSettings() ? `<button class="btn danger" onclick="sinitDeleteSource(${s.id})">מחיקה</button>` : ''}</td>
        </tr>`).join('');
}

async function sinitDeleteSource(id) {
    if (!confirm('למחוק את מקור הסנכרון? העסקים שכבר נכנסו יישארו.')) return;
    try { await api(`/api/sinit/sources/${id}`, { method: 'DELETE' }); await sinitLoadOverview(); }
    catch (e) { alert(e.message); }
}

/* ---------- חיווט ---------- */
function wireSinit() {
    if (S.wired) return;
    S.wired = true;

    el('sbizSearch').addEventListener('input', (e) => { S.f.q = e.target.value.trim(); renderBusinesses(); });
    ['sbizStatusFilter', 'sbizStageFilter', 'sbizSourceFilter', 'sbizColorFilter'].forEach((id) => {
        el(id).addEventListener('change', (e) => {
            S.f[{ sbizStatusFilter: 'status', sbizStageFilter: 'stage', sbizSourceFilter: 'source', sbizColorFilter: 'color' }[id]]
                = e.target.value;
            renderBusinesses();
        });
    });
    el('squestionSearch').addEventListener('input', (e) => { S.f.question = e.target.value.trim(); renderQuestions(); });

    el('sbizAddToggle').addEventListener('click', () => el('sbizAddBox').classList.toggle('hidden'));
    el('sbizAddBtn').addEventListener('click', async () => {
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

    el('sbizAddStatusBtn').addEventListener('click', async () => {
        const name = prompt('שם הסטטוס החדש:');
        if (!name || !name.trim()) return;
        try { await api('/api/sinit/statuses', { method: 'POST', body: { name: name.trim() } }); await sinitLoadOverview(); }
        catch (e) { alert(e.message); }
    });

    el('sbizSyncBtn').addEventListener('click', async () => {
        const btn = el('sbizSyncBtn');
        btn.disabled = true; btn.textContent = '⟳ מסנכרנת...';
        try {
            const r = await api('/api/sinit/sync', { method: 'POST' });
            await sinitLoadOverview();
            const lines = r.sources.map((s) => s.error
                ? `${s.name}: שגיאה — ${s.error}`
                : `${s.name}: ${s.rows} שורות, ${s.added} חדשים, ${s.updated} עודכנו`);
            alert(`הסנכרון הסתיים:\n${lines.join('\n')}`);
        } catch (e) { alert(e.message); }
        finally { btn.disabled = false; btn.textContent = '⟳ סנכרון עכשיו'; }
    });

    el('sbizExportBtn').addEventListener('click',
        () => downloadFile('/api/sinit/businesses/export.xlsx', 'עסקים — מכירה סינית.xlsx'));

    el('sbizModalClose').addEventListener('click', () => {
        S.modalId = null;
        el('sbizModalOverlay').classList.add('hidden');
    });
    el('sbizModalOverlay').addEventListener('click', (e) => {
        if (e.target.id === 'sbizModalOverlay') { S.modalId = null; el('sbizModalOverlay').classList.add('hidden'); }
    });
    el('sbizModalStatus').addEventListener('change', async (e) => {
        try {
            await api(`/api/sinit/businesses/${S.modalId}`, { method: 'PUT', body: { status: e.target.value } });
            await sinitLoadOverview(); await refreshModal();
        } catch (err) { alert(err.message); }
    });
    el('sbizAddNoteBtn').addEventListener('click', async () => {
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
    el('sbizAskBtn').addEventListener('click', async () => {
        const text = el('sbizQuestionText').value.trim();
        if (!text || !S.modalId) return;
        try {
            const r = await api('/api/sinit/questions', { method: 'POST', body: {
                text, business_id: S.modalId, send_email: true,
            } });
            el('sbizQuestionText').value = '';
            alert(r.mail?.sent ? `השאלה נרשמה ונשלח מייל ל${r.mail.to}` : `השאלה נרשמה, המייל לא נשלח: ${r.mail?.error || 'שגיאה'}`);
            await Promise.all([sinitLoadQuestions(), sinitLoadOverview()]);
            await refreshModal();
        } catch (e) { alert(e.message); }
    });

    el('squestionAddBtn').addEventListener('click', sinitAddQuestion);
    el('squestionText').addEventListener('keydown', (e) => { if (e.key === 'Enter') sinitAddQuestion(); });

    el('saiAskBtn').addEventListener('click', sinitAsk);
    el('saiQuestion').addEventListener('keydown', (e) => { if (e.key === 'Enter') sinitAsk(); });

    el('skbUploadBtn').addEventListener('click', () => el('skbFile').click());
    el('skbFile').addEventListener('change', (e) => {
        sinitUploadDoc(e.target.files[0]);
        e.target.value = '';
    });

    el('sSettingsSaveBtn').addEventListener('click', async () => {
        try {
            await api('/api/sinit/settings', { method: 'PUT', body: {
                campaign_admin_email: el('sAdminEmail').value, campaign_admin_name: el('sAdminName').value,
            } });
            await sinitLoadOverview();
            alert('ההגדרות נשמרו');
        } catch (e) { alert(e.message); }
    });
    el('sAddStageBtn').addEventListener('click', async () => {
        const name = el('sNewStage').value.trim();
        if (!name) return;
        try { await api('/api/sinit/stages', { method: 'POST', body: { name } }); el('sNewStage').value = ''; await sinitLoadOverview(); }
        catch (e) { alert(e.message); }
    });
    el('sAddSourceBtn').addEventListener('click', async () => {
        try {
            await api('/api/sinit/sources', { method: 'POST', body: {
                name: el('sSourceName').value, sheet_url: el('sSourceUrl').value, sheet_name: el('sSourceSheet').value,
            } });
            el('sSourceName').value = ''; el('sSourceUrl').value = ''; el('sSourceSheet').value = '';
            await sinitLoadOverview();
            alert('המקור נוסף. לחצי "סנכרון עכשיו" כדי לשלוף ממנו עסקים.');
        } catch (e) { alert(e.message); }
    });
}

window.sinitInit = function sinitInit() {
    if (!USER || !(USER.features || []).includes('campaign')) return;
    wireSinit();
    sinitLoadAll();
};
window.sinitActivate = function sinitActivate() {
    wireSinit();
    sinitLoadAll();
};

// campaign.js מריץ את startApp לפני שהקובץ הזה נטען, ולכן מאתחלים גם כאן אם המערכת כבר פתוחה
if (USER && !el('app').classList.contains('hidden')) window.sinitInit();
