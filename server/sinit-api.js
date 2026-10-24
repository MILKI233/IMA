// לשונית "מכירה סינית" — עסקים מסונכרנים מכל הטפסים והטבלאות, שלבי סגירה,
// שאלות למנהלת עם שלבי מענה, ומענה AI שנשען על קבצי וורד שהועלו למערכת.
import express from 'express';
import { randomBytes } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { utils, write } from 'xlsx';
import { db, audit, getSetting, getAllCampaignSettings, setCampaignSettings, isManagerOrAbove, hasFeature } from './db.js';
import { getCampaignSheetsCache, fetchSheetRows } from './sheets-sync.js';
import { parseDocx } from './docx.js';
import { sendMailTo } from './integrations.js';

const BUILTIN_STATUSES = ['ממתין', 'נוצר קשר', 'תרם', 'סירב'];
// הפלטה להדגשת עסק — צבעים רכים שנקראים טוב מתחת לטקסט שחור
export const HIGHLIGHT_COLORS = ['#fde8e6', '#fdf3d7', '#e4f6e9', '#e2eefc', '#efe6fa', '#fae6f1', '#e6f6f8', '#f0f0f0'];

const normName = (s) => String(s || '').replace(/["'`״׳]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const clean = (s) => String(s ?? '').trim();

// ---------- עסקים ----------
function allStatuses() {
    const custom = db.prepare('SELECT name FROM campaign_business_statuses ORDER BY id ASC').all().map((r) => r.name);
    return [...BUILTIN_STATUSES, ...custom];
}

function stageList() {
    return db.prepare('SELECT * FROM campaign_close_stages ORDER BY position ASC, id ASC').all();
}

// רשימת העסקים כולל התקדמות שלבי הסגירה שלהם (כמה שלבים הושלמו ומה השלב הנוכחי)
function businessesWithStages() {
    const stages = stageList();
    const rows = db.prepare('SELECT * FROM campaign_businesses ORDER BY highlight DESC, id DESC').all();
    const progress = db.prepare('SELECT business_id, stage_id, done FROM campaign_business_stages WHERE done = 1').all();
    const noteCounts = db.prepare('SELECT business_id, COUNT(*) AS c FROM campaign_business_notes GROUP BY business_id').all();
    const noteMap = new Map(noteCounts.map((r) => [r.business_id, r.c]));
    const doneMap = new Map();
    for (const p of progress) {
        if (!doneMap.has(p.business_id)) doneMap.set(p.business_id, new Set());
        doneMap.get(p.business_id).add(p.stage_id);
    }
    return rows.map((b) => {
        const done = doneMap.get(b.id) || new Set();
        const lastDone = [...stages].reverse().find((s) => done.has(s.id));
        return {
            ...b,
            notes_count: noteMap.get(b.id) || 0,
            stages_done: done.size,
            stages_total: stages.length,
            current_stage: lastDone ? lastDone.name : null,
            done_stage_ids: [...done],
        };
    });
}

// עדכון עסק ממקור חיצוני: לא דורס שום דבר שמישהי כתבה ידנית (סטטוס, תגובה, צבע),
// רק משלים שדות ריקים ומרענן את פרטי המוצר מהטופס.
function upsertFromSource(rec, sourceName) {
    const name = clean(rec.name);
    if (!name) return 'skipped';
    const key = `${sourceName}|${normName(name)}`;
    let existing = db.prepare('SELECT * FROM campaign_businesses WHERE external_key = ?').get(key);
    if (!existing) {
        // אותו עסק אולי הוקלד ידנית לפני שהטופס סונכרן — מזהים לפי שם מנורמל ולא יוצרים כפילות
        existing = db.prepare('SELECT * FROM campaign_businesses').all()
            .find((b) => normName(b.name) === normName(name));
    }

    if (!existing) {
        const r = db.prepare(`INSERT INTO campaign_businesses
            (name, contacted_by, phone, email, response, status, source, external_key, product, value_nis, pickup, validity, logo_url, created_at, synced_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))`)
            .run(name, clean(rec.contacted_by) || null, clean(rec.phone) || null, clean(rec.email) || null,
                clean(rec.response) || null, allStatuses().includes(rec.status) ? rec.status : 'תרם',
                sourceName, key, clean(rec.product) || null, clean(rec.value_nis) || null,
                clean(rec.pickup) || null, clean(rec.validity) || null, clean(rec.logo_url) || null);
        return { outcome: 'added', id: r.lastInsertRowid };
    }

    db.prepare(`UPDATE campaign_businesses SET
            external_key = COALESCE(external_key, ?),
            contacted_by = COALESCE(NULLIF(contacted_by,''), ?),
            phone        = COALESCE(NULLIF(phone,''), ?),
            email        = COALESCE(NULLIF(email,''), ?),
            product      = COALESCE(NULLIF(?,''), product),
            value_nis    = COALESCE(NULLIF(?,''), value_nis),
            pickup       = COALESCE(NULLIF(?,''), pickup),
            validity     = COALESCE(NULLIF(?,''), validity),
            logo_url     = COALESCE(NULLIF(?,''), logo_url),
            synced_at    = datetime('now','localtime')
        WHERE id = ?`)
        .run(key, clean(rec.contacted_by) || null, clean(rec.phone) || null, clean(rec.email) || null,
            clean(rec.product), clean(rec.value_nis), clean(rec.pickup), clean(rec.validity), clean(rec.logo_url),
            existing.id);
    return { outcome: 'updated', id: existing.id };
}

// מאתרת עמודה לפי מילות מפתח חלקיות בכותרת — כך הסנכרון לא נשבר אם ניסוח הכותרת בטופס שונה
function col(row, words) {
    const key = Object.keys(row).find((k) => words.some((w) => k.replace(/\s+/g, ' ').includes(w)));
    return key ? row[key] : '';
}

export async function syncSinitBusinesses() {
    const result = { sources: [], added: 0, updated: 0, errors: [] };

    // (1) טופס "תודה על תרומתך" — כבר נשלף כל 3 דקות ללוח הבקרה
    const cache = getCampaignSheetsCache();
    const recruited = cache.recruitedProducts || [];
    let added = 0, updated = 0;
    for (const r of recruited) {
        if (!clean(r.businessName)) continue;
        const res = upsertFromSource({
            name: r.businessName, phone: r.businessPhone, email: r.businessEmail,
            contacted_by: r.recruiterName, product: r.productDescription, value_nis: r.productValue,
            pickup: r.pickup, validity: r.validity, logo_url: r.logoUrl, status: 'תרם',
            response: r.notes,
        }, 'טופס תרומות');
        if (res.outcome === 'added') added++; else if (res.outcome === 'updated') updated++;
    }
    result.sources.push({ name: 'טופס תרומות', rows: recruited.length, added, updated });
    result.added += added; result.updated += updated;
    if (cache.error) result.errors.push(`גליונות הקמפיין: ${cache.error}`);

    // (2) מקורות נוספים שהמנהלת הגדירה בעצמה
    const sources = db.prepare('SELECT * FROM campaign_sync_sources WHERE active = 1 ORDER BY id ASC').all();
    for (const src of sources) {
        try {
            const rows = await fetchSheetRows(src.sheet_id, src.sheet_name);
            let a = 0, u = 0;
            for (const row of rows) {
                const name = clean(col(row, ['שם העסק', 'שם עסק', 'עסק', 'חנות', 'ספק']));
                if (!name) continue;
                const res = upsertFromSource({
                    name,
                    phone: col(row, ['טלפון', 'נייד', 'פלאפון']),
                    email: col(row, ['מייל', 'אימייל', 'דוא']),
                    contacted_by: col(row, ['מי פנתה', 'מגייסת', 'שם המגייסת', 'אחראית', 'מתנדבת']),
                    product: col(row, ['מוצר', 'תרומה', 'פרס']),
                    value_nis: col(row, ['שווי', 'סכום', 'ערך']),
                    response: col(row, ['תגובה', 'הערה', 'הערות']),
                    status: clean(col(row, ['סטטוס', 'מצב'])),
                }, src.name);
                if (res.outcome === 'added') a++; else if (res.outcome === 'updated') u++;
            }
            db.prepare("UPDATE campaign_sync_sources SET last_synced_at = datetime('now','localtime'), last_rows = ?, last_error = NULL WHERE id = ?")
                .run(rows.length, src.id);
            result.sources.push({ name: src.name, rows: rows.length, added: a, updated: u });
            result.added += a; result.updated += u;
        } catch (e) {
            db.prepare("UPDATE campaign_sync_sources SET last_synced_at = datetime('now','localtime'), last_error = ? WHERE id = ?")
                .run(e.message, src.id);
            result.errors.push(`${src.name}: ${e.message}`);
            result.sources.push({ name: src.name, error: e.message });
        }
    }
    return result;
}

// אזכורים של העסק בגיליון התנועות (מי דיווחה עליו בטלפון) — תצוגה בלבד, לא נשמר במסד
function sheetMentions(businessName) {
    const txns = getCampaignSheetsCache().transactions || [];
    const n = normName(businessName);
    if (!n) return [];
    return txns.filter((t) => normName(t['פעולה / מוצר'] || '').includes(n)).slice(0, 20).map((t) => ({
        at: t['תאריך ושעה'] || '',
        who: t['שם'] || t['טלפון'] || '',
        action: t['פעולה / מוצר'] || '',
        points: t['סה"כ נקודות'] || '',
    }));
}

// ---------- בסיס הידע וה-AI ----------
const STOPWORDS = new Set(['של', 'את', 'עם', 'על', 'אני', 'מה', 'איך', 'האם', 'יש', 'לא', 'כן', 'זה', 'זו', 'הוא',
    'היא', 'כל', 'גם', 'אם', 'או', 'כי', 'מי', 'איפה', 'מתי', 'למה', 'צריך', 'צריכה', 'אפשר', 'רוצה', 'איזה',
    'כמה', 'בבקשה', 'תודה', 'שלי', 'שלנו', 'שלך', 'הם', 'הן', 'אבל', 'כדי', 'עוד', 'רק', 'לי', 'לנו']);
const PREFIXES = ['ו', 'ה', 'ב', 'ל', 'מ', 'ש', 'כ'];

const normHeb = (s) => String(s || '')
    .replace(/[֑-ׇ]/g, '')          // ניקוד
    .replace(/[^א-ת\w\s]/g, ' ')    // פיסוק
    .replace(/\s+/g, ' ').trim().toLowerCase();

function tokenize(s) {
    return normHeb(s).split(' ').filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

// התאמה סובלנית לתחיליות עבריות: "לעסק" ייחשב כהתאמה ל"עסק"
function tokenHits(token, text) {
    if (text.includes(token)) return true;
    for (const p of PREFIXES) {
        if (token.startsWith(p) && token.length > 3 && text.includes(token.slice(1))) return true;
        if (text.includes(p + token)) return true;
    }
    return false;
}

function scorePair(tokens, pair) {
    const q = normHeb(pair.question);
    const a = normHeb(pair.answer);
    let qHits = 0, aHits = 0;
    for (const t of tokens) {
        if (tokenHits(t, q)) qHits++;
        else if (tokenHits(t, a)) aHits++;
    }
    return { score: qHits * 3 + aHits, ratio: tokens.length ? qHits / tokens.length : 0 };
}

function splitChunks(text, size = 700) {
    const parts = [];
    const paras = String(text || '').split('\n');
    let buf = '';
    for (const p of paras) {
        if ((buf + '\n' + p).length > size && buf) { parts.push(buf); buf = p; }
        else buf = buf ? `${buf}\n${p}` : p;
    }
    if (buf) parts.push(buf);
    return parts;
}

function retrieve(question) {
    const tokens = tokenize(question);
    const pairs = db.prepare(`SELECT p.*, d.filename FROM campaign_kb_pairs p
                              JOIN campaign_kb_docs d ON d.id = p.doc_id`).all();
    const scored = pairs.map((p) => ({ ...p, ...scorePair(tokens, p) }))
        .filter((p) => p.score > 0)
        .sort((a, b) => b.score - a.score);

    const docs = db.prepare('SELECT id, filename, raw_text FROM campaign_kb_docs').all();
    const chunks = [];
    for (const d of docs) {
        for (const c of splitChunks(d.raw_text)) {
            const t = normHeb(c);
            const hits = tokens.filter((tk) => tokenHits(tk, t)).length;
            if (hits) chunks.push({ filename: d.filename, text: c, score: hits });
        }
    }
    chunks.sort((a, b) => b.score - a.score);
    return { tokens, pairs: scored.slice(0, 6), chunks: chunks.slice(0, 4), hasDocs: docs.length > 0 };
}

const AI_SYSTEM = `את עונה לצוות של ארגון "אמא במשמרת" על שאלות בנוגע לקמפיין המכירה הסינית.
מותר לך לענות רק ממה שכתוב בחומר שמצורף לשאלה. החומר נלקח מקבצי הוורד שהמנהלת העלתה למערכת.
אם התשובה לשאלה לא נמצאת בחומר — החזירי בדיוק את המשפט: אין לי מענה
אל תנחשי, אל תוסיפי מידע מהידע הכללי שלך, ואל תמציאי מספרים או תאריכים.
עני בעברית, קצר וברור, בגובה העיניים, ובלי לפתוח במשפטי נימוס.`;

const NO_ANSWER = 'אין לי מענה';
const MODELS = ['claude-opus-5', 'claude-opus-4-8'];

async function askClaude(apiKey, question, context, history) {
    const client = new Anthropic({ apiKey });
    const messages = [
        ...history.flatMap((h) => ([
            { role: 'user', content: h.question },
            { role: 'assistant', content: h.answer },
        ])),
        { role: 'user', content: `<חומר>\n${context}\n</חומר>\n\nהשאלה: ${question}` },
    ];
    let lastErr = null;
    for (const model of MODELS) {
        try {
            const r = await client.messages.create({ model, max_tokens: 1024, system: AI_SYSTEM, messages });
            if (r.stop_reason === 'refusal') throw new Error('הבקשה נדחתה על ידי מערכת הבטיחות של המודל');
            return r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        } catch (e) {
            lastErr = e;
            const msg = String(e?.message || '');
            // מודל לא זמין בחשבון — מנסים את הדגם הבא ברשימה ולא מפילים את הבקשה
            if (!/model|not_found|404/i.test(msg)) throw e;
        }
    }
    throw lastErr || new Error('הפנייה ל-AI נכשלה');
}

// ---------- הראוטר ----------
// המקטעים שאפשר לשתף עם מתנדבת בקישור — כל קישור פותח מקטע אחד בלבד
export const SHARE_SECTIONS = {
    businesses: 'עסקים',
    questions: 'שאלות ושלבי מענה',
    ai: 'מענה AI',
};

export function sinitApiRouter({ mustLogin, mustManager, requireFeature, events }) {
    const router = express.Router();
    const touch = () => events?.emit('campaign.update');

    // ---- גישה: משתמשת מחוברת, או מתנדבת שנכנסה בקישור שיתוף למקטע הזה בלבד ----
    function shareLink(req) {
        const token = clean(req.header('x-share-token'));
        if (!token) return null;
        return db.prepare('SELECT * FROM campaign_share_links WHERE token = ? AND active = 1').get(token) || null;
    }

    // שם המתנדבת מגיע מהכותרת מקודד ב-URI — עברית גולמית בכותרת HTTP מתפרקת
    function shareName(req) {
        try { return clean(decodeURIComponent(req.header('x-share-name') || '')); }
        catch { return ''; }
    }

    function gate(section, mode = 'read') {
        return (req, res, next) => {
            if (req.user) return next();
            const link = shareLink(req);
            if (!link) return res.status(401).json({ error: 'נדרשת כניסה' });
            if (section !== 'any' && link.section !== section) {
                return res.status(403).json({ error: `הקישור שלך פותח רק את "${SHARE_SECTIONS[link.section] || link.section}"` });
            }
            if (mode === 'write' && !link.can_write) {
                return res.status(403).json({ error: 'הקישור שלך הוא לצפייה בלבד' });
            }
            req.share = link;
            db.prepare("UPDATE campaign_share_links SET uses = uses + 1, last_used_at = datetime('now','localtime') WHERE id = ?")
                .run(link.id);
            next();
        };
    }

    // מי ביצע את הפעולה — שם המשתמשת, או שם המתנדבת שהקלידה בקישור
    const actor = (req) => req.user?.name
        || (shareName(req) ? `${shareName(req)} (קישור ${req.share?.label || ''})`.trim() : `קישור ${req.share?.label || 'שיתוף'}`);

    const adminEmail = () => getAllCampaignSettings().campaign_admin_email || getSetting('report_email') || '';

    router.get('/overview', gate('any'), (req, res) => {
        const businesses = businessesWithStages();
        const stages = stageList();
        const questions = db.prepare('SELECT * FROM campaign_questions ORDER BY id DESC').all();
        const cache = getCampaignSheetsCache();
        res.json({
            businesses,
            stages,
            statuses: allStatuses(),
            colors: HIGHLIGHT_COLORS,
            sources: db.prepare('SELECT * FROM campaign_sync_sources ORDER BY id ASC').all(),
            questionsOpen: questions.filter((q) => q.status !== 'נענתה' && q.status !== 'נסגרה').length,
            kbDocs: db.prepare('SELECT COUNT(*) AS c FROM campaign_kb_docs').get().c,
            kbPairs: db.prepare('SELECT COUNT(*) AS c FROM campaign_kb_pairs').get().c,
            adminEmail: adminEmail(),
            adminName: getAllCampaignSettings().campaign_admin_name,
            aiReady: !!getSetting('anthropic_api_key'),
            mailReady: !!(getSetting('gmail_user') && getSetting('gmail_app_password')),
            sheetsSyncedAt: cache.syncedAt,
            sheetsError: cache.error,
            recruitedRows: (cache.recruitedProducts || []).length,
            isManager: !!req.user && isManagerOrAbove(req.user.role),
            canManageSettings: !!req.user && hasFeature(req.user.role, 'campaign_settings'),
        });
    });

    // ----- סנכרון -----
    router.post('/sync', gate('businesses', 'write'), async (req, res) => {
        try {
            const result = await syncSinitBusinesses();
            audit(actor(req), 'campaign.sinit.sync', 'campaign_businesses', null, null,
                { added: result.added, updated: result.updated, sources: result.sources.length });
            touch();
            res.json(result);
        } catch (e) { res.status(500).json({ error: e.message || 'הסנכרון נכשל' }); }
    });

    router.get('/sources', mustLogin, (req, res) => {
        res.json(db.prepare('SELECT * FROM campaign_sync_sources ORDER BY id ASC').all());
    });

    router.post('/sources', mustLogin, requireFeature('campaign_settings'), (req, res) => {
        const name = clean(req.body?.name);
        const raw = clean(req.body?.sheet_url);
        const sheetName = clean(req.body?.sheet_name) || 'תגובות לטופס 1';
        if (!name) return res.status(400).json({ error: 'יש להזין שם למקור (למשל: טופס פניות לעסקים)' });
        const m = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/) || raw.match(/^([a-zA-Z0-9-_]{20,})$/);
        if (!m) return res.status(400).json({ error: 'יש להדביק קישור לגיליון גוגל (או את מזהה הגיליון עצמו)' });
        try {
            const r = db.prepare('INSERT INTO campaign_sync_sources (name, sheet_id, sheet_name, created_by) VALUES (?, ?, ?, ?)')
                .run(name, m[1], sheetName, actor(req));
            audit(actor(req), 'campaign.sinit.source_add', 'campaign_sync_sources', r.lastInsertRowid, null, { name, sheet_name: sheetName });
            touch();
            res.json({ ok: true, id: r.lastInsertRowid });
        } catch { res.status(400).json({ error: 'המקור הזה (אותו גיליון ואותה לשונית) כבר מוגדר' }); }
    });

    router.delete('/sources/:id', mustLogin, requireFeature('campaign_settings'), (req, res) => {
        const before = db.prepare('SELECT * FROM campaign_sync_sources WHERE id = ?').get(req.params.id);
        if (!before) return res.status(404).json({ error: 'המקור לא נמצא' });
        db.prepare('DELETE FROM campaign_sync_sources WHERE id = ?').run(before.id);
        audit(actor(req), 'campaign.sinit.source_delete', 'campaign_sync_sources', before.id, before, null);
        touch();
        res.json({ ok: true });
    });

    // ----- עסקים -----
    router.get('/businesses', gate('businesses'), (req, res) => res.json(businessesWithStages()));

    router.post('/businesses', gate('businesses', 'write'), (req, res) => {
        const name = clean(req.body?.name);
        if (!name) return res.status(400).json({ error: 'יש להזין שם עסק' });
        const status = allStatuses().includes(req.body?.status) ? req.body.status : 'ממתין';
        const r = db.prepare(`INSERT INTO campaign_businesses
            (name, contacted_by, phone, email, response, status, contact_number, message_number, product, value_nis, source, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ידני', datetime('now','localtime'))`)
            .run(name, clean(req.body?.contacted_by) || actor(req), clean(req.body?.phone) || null,
                clean(req.body?.email) || null, clean(req.body?.response) || null, status,
                clean(req.body?.contact_number) || null, clean(req.body?.message_number) || null,
                clean(req.body?.product) || null, clean(req.body?.value_nis) || null);
        if (clean(req.body?.response)) {
            db.prepare('INSERT INTO campaign_business_notes (business_id, text, created_by) VALUES (?, ?, ?)')
                .run(r.lastInsertRowid, clean(req.body.response), actor(req));
        }
        audit(actor(req), 'campaign.business.create', 'campaign_businesses', r.lastInsertRowid, null, { name, status });
        touch();
        res.json({ ok: true, id: r.lastInsertRowid });
    });

    router.put('/businesses/:id', gate('businesses', 'write'), (req, res) => {
        const before = db.prepare('SELECT * FROM campaign_businesses WHERE id = ?').get(req.params.id);
        if (!before) return res.status(404).json({ error: 'העסק לא נמצא' });
        const b = req.body || {};
        const pick = (field, fallback) => (b[field] === undefined ? fallback : (clean(b[field]) || null));
        const status = allStatuses().includes(b.status) ? b.status : before.status;
        const color = b.color === undefined ? before.color : (clean(b.color) || null);
        const highlight = b.highlight === undefined ? before.highlight : (b.highlight ? 1 : 0);
        db.prepare(`UPDATE campaign_businesses SET name=?, contacted_by=?, phone=?, email=?, response=?, status=?,
                    contact_number=?, message_number=?, product=?, value_nis=?, color=?, highlight=?,
                    updated_at=datetime('now','localtime') WHERE id=?`)
            .run(clean(b.name) || before.name, pick('contacted_by', before.contacted_by), pick('phone', before.phone),
                pick('email', before.email), pick('response', before.response), status,
                pick('contact_number', before.contact_number), pick('message_number', before.message_number),
                pick('product', before.product), pick('value_nis', before.value_nis), color, highlight, before.id);
        audit(actor(req), 'campaign.business.update', 'campaign_businesses', before.id,
            { status: before.status, color: before.color, highlight: before.highlight },
            { status, color, highlight, response: pick('response', before.response) });
        touch();
        res.json({ ok: true });
    });

    router.delete('/businesses/:id', mustLogin, mustManager, (req, res) => {
        const before = db.prepare('SELECT * FROM campaign_businesses WHERE id = ?').get(req.params.id);
        if (!before) return res.status(404).json({ error: 'העסק לא נמצא' });
        db.prepare('DELETE FROM campaign_business_stages WHERE business_id = ?').run(before.id);
        db.prepare('DELETE FROM campaign_business_notes WHERE business_id = ?').run(before.id);
        db.prepare('DELETE FROM campaign_businesses WHERE id = ?').run(before.id);
        audit(actor(req), 'campaign.business.delete', 'campaign_businesses', before.id, before, null);
        touch();
        res.json({ ok: true });
    });

    // כל מה שידוע על עסק אחד: פרטים, תגובות, שלבי סגירה, שאלות עליו ואזכורים בגיליון התנועות
    router.get('/businesses/:id/detail', gate('businesses'), (req, res) => {
        const biz = businessesWithStages().find((b) => b.id === Number(req.params.id));
        if (!biz) return res.status(404).json({ error: 'העסק לא נמצא' });
        const stages = stageList();
        const progress = db.prepare('SELECT * FROM campaign_business_stages WHERE business_id = ?').all(biz.id);
        const pMap = new Map(progress.map((p) => [p.stage_id, p]));
        res.json({
            biz,
            notes: db.prepare('SELECT * FROM campaign_business_notes WHERE business_id = ? ORDER BY id DESC').all(biz.id),
            stages: stages.map((s) => ({ ...s, ...(pMap.get(s.id) || { done: 0, note: null, done_by: null, done_at: null }) })),
            questions: db.prepare('SELECT * FROM campaign_questions WHERE business_id = ? ORDER BY id DESC').all(biz.id),
            mentions: sheetMentions(biz.name),
            statuses: allStatuses(),
            colors: HIGHLIGHT_COLORS,
        });
    });

    router.post('/businesses/:id/notes', gate('businesses', 'write'), (req, res) => {
        const biz = db.prepare('SELECT * FROM campaign_businesses WHERE id = ?').get(req.params.id);
        if (!biz) return res.status(404).json({ error: 'העסק לא נמצא' });
        const text = clean(req.body?.text);
        if (!text) return res.status(400).json({ error: 'יש להזין תגובה' });
        const contactNumber = clean(req.body?.contact_number) || null;
        const messageNumber = clean(req.body?.message_number) || null;
        const r = db.prepare(`INSERT INTO campaign_business_notes (business_id, text, contact_number, message_number, created_by)
                              VALUES (?, ?, ?, ?, ?)`).run(biz.id, text, contactNumber, messageNumber, actor(req));
        db.prepare(`UPDATE campaign_businesses SET response=?, contact_number=COALESCE(?, contact_number),
                    message_number=COALESCE(?, message_number), updated_at=datetime('now','localtime') WHERE id=?`)
            .run(text, contactNumber, messageNumber, biz.id);
        audit(actor(req), 'campaign.business.note_add', 'campaign_businesses', biz.id, null, { text });
        touch();
        res.json({ ok: true, id: r.lastInsertRowid });
    });

    router.delete('/businesses/:id/notes/:noteId', gate('businesses', 'write'), (req, res) => {
        const note = db.prepare('SELECT * FROM campaign_business_notes WHERE id = ? AND business_id = ?')
            .get(req.params.noteId, req.params.id);
        if (!note) return res.status(404).json({ error: 'הרשומה לא נמצאה' });
        db.prepare('DELETE FROM campaign_business_notes WHERE id = ?').run(note.id);
        audit(actor(req), 'campaign.business.note_delete', 'campaign_businesses', note.business_id, note, null);
        touch();
        res.json({ ok: true });
    });

    // ----- שלבי סגירה -----
    router.get('/stages', gate('any'), (req, res) => res.json(stageList()));

    router.post('/stages', mustLogin, requireFeature('campaign_settings'), (req, res) => {
        const name = clean(req.body?.name);
        if (!name) return res.status(400).json({ error: 'יש להזין שם לשלב' });
        const max = db.prepare('SELECT COALESCE(MAX(position),0) AS m FROM campaign_close_stages').get().m;
        try {
            const r = db.prepare('INSERT INTO campaign_close_stages (name, position) VALUES (?, ?)').run(name, max + 1);
            audit(actor(req), 'campaign.sinit.stage_add', 'campaign_close_stages', r.lastInsertRowid, null, { name });
            touch();
            res.json({ ok: true, stages: stageList() });
        } catch { res.status(400).json({ error: 'שלב בשם הזה כבר קיים' }); }
    });

    router.delete('/stages/:id', mustLogin, requireFeature('campaign_settings'), (req, res) => {
        const before = db.prepare('SELECT * FROM campaign_close_stages WHERE id = ?').get(req.params.id);
        if (!before) return res.status(404).json({ error: 'השלב לא נמצא' });
        db.prepare('DELETE FROM campaign_business_stages WHERE stage_id = ?').run(before.id);
        db.prepare('DELETE FROM campaign_close_stages WHERE id = ?').run(before.id);
        audit(actor(req), 'campaign.sinit.stage_delete', 'campaign_close_stages', before.id, before, null);
        touch();
        res.json({ ok: true, stages: stageList() });
    });

    router.post('/businesses/:id/stages/:stageId', gate('businesses', 'write'), (req, res) => {
        const biz = db.prepare('SELECT * FROM campaign_businesses WHERE id = ?').get(req.params.id);
        const stage = db.prepare('SELECT * FROM campaign_close_stages WHERE id = ?').get(req.params.stageId);
        if (!biz || !stage) return res.status(404).json({ error: 'העסק או השלב לא נמצאו' });
        const done = req.body?.done ? 1 : 0;
        const note = clean(req.body?.note) || null;
        db.prepare(`INSERT INTO campaign_business_stages (business_id, stage_id, done, note, done_by, done_at)
                    VALUES (?, ?, ?, ?, ?, CASE WHEN ? = 1 THEN datetime('now','localtime') ELSE NULL END)
                    ON CONFLICT(business_id, stage_id) DO UPDATE SET
                      done = excluded.done, note = COALESCE(excluded.note, campaign_business_stages.note),
                      done_by = excluded.done_by, done_at = excluded.done_at`)
            .run(biz.id, stage.id, done, note, actor(req), done);
        audit(actor(req), 'campaign.sinit.stage_mark', 'campaign_businesses', biz.id, null,
            { business: biz.name, stage: stage.name, done: !!done });
        touch();
        res.json({ ok: true });
    });

    // ----- סטטוסים -----
    router.get('/statuses', gate('any'), (req, res) => res.json(allStatuses()));
    router.post('/statuses', gate('businesses', 'write'), (req, res) => {
        const name = clean(req.body?.name);
        if (!name) return res.status(400).json({ error: 'יש להזין שם לסטטוס' });
        if (allStatuses().includes(name)) return res.status(400).json({ error: 'הסטטוס הזה כבר קיים' });
        db.prepare('INSERT INTO campaign_business_statuses (name) VALUES (?)').run(name);
        audit(actor(req), 'campaign.business_status.create', 'campaign_business_statuses', null, null, { name });
        touch();
        res.json({ ok: true, statuses: allStatuses() });
    });

    // ----- שאלות למנהלת המערכת + שלבי המענה -----
    function questionsWithSteps() {
        const rows = db.prepare(`SELECT q.*, b.name AS business_name FROM campaign_questions q
                                 LEFT JOIN campaign_businesses b ON b.id = q.business_id
                                 ORDER BY q.id DESC`).all();
        const steps = db.prepare('SELECT * FROM campaign_question_steps ORDER BY id ASC').all();
        return rows.map((q) => ({ ...q, steps: steps.filter((s) => s.question_id === q.id) }));
    }

    router.get('/questions', gate('questions'), (req, res) => res.json(questionsWithSteps()));

    router.post('/questions', gate('questions', 'write'), async (req, res) => {
        const text = clean(req.body?.text);
        if (!text) return res.status(400).json({ error: 'יש להזין את השאלה' });
        const businessId = Number(req.body?.business_id) || null;
        const origin = req.body?.origin === 'AI' ? 'AI' : 'ידני';
        const r = db.prepare('INSERT INTO campaign_questions (text, asked_by, business_id, origin) VALUES (?, ?, ?, ?)')
            .run(text, actor(req), businessId, origin);
        const id = r.lastInsertRowid;
        db.prepare('INSERT INTO campaign_question_steps (question_id, text, created_by) VALUES (?, ?, ?)')
            .run(id, 'השאלה נרשמה במערכת', actor(req));

        let mail = { sent: false, to: adminEmail(), error: null };
        if (req.body?.send_email) {
            const biz = businessId ? db.prepare('SELECT name FROM campaign_businesses WHERE id = ?').get(businessId) : null;
            try {
                if (!mail.to) throw new Error('לא הוגדרה כתובת מייל למנהלת המערכת (בהגדרות הלשונית)');
                await sendMailTo({
                    to: mail.to,
                    subject: `שאלה חדשה מ${actor(req)} — קמפיין המכירה הסינית`,
                    html: `<p>${actor(req)} שאלה:</p><blockquote>${text}</blockquote>
                           ${biz ? `<p>בהקשר של העסק: <b>${biz.name}</b></p>` : ''}
                           ${origin === 'AI' ? '<p>השאלה נשאלה קודם את המענה האוטומטי ולא נמצאה לה תשובה בחומר שהועלה למערכת.</p>' : ''}
                           <p>אפשר לענות ישירות במערכת, בלשונית "מכירה סינית" ← שאלות ושלבי מענה.</p>`,
                });
                mail.sent = true;
                db.prepare("UPDATE campaign_questions SET email_sent_at = datetime('now','localtime'), email_to = ?, status = 'נשלחה למנהלת' WHERE id = ?")
                    .run(mail.to, id);
                db.prepare('INSERT INTO campaign_question_steps (question_id, text, created_by) VALUES (?, ?, ?)')
                    .run(id, `נשלח מייל למנהלת המערכת (${mail.to})`, actor(req));
            } catch (e) {
                mail.error = e.message;
                db.prepare('INSERT INTO campaign_question_steps (question_id, text, created_by) VALUES (?, ?, ?)')
                    .run(id, `שליחת המייל נכשלה: ${e.message}`, actor(req));
            }
        }
        audit(actor(req), 'campaign.sinit.question_add', 'campaign_questions', id, null, { text, origin, mail: mail.sent });
        touch();
        res.json({ ok: true, id, mail });
    });

    router.post('/questions/:id/steps', gate('questions', 'write'), (req, res) => {
        const q = db.prepare('SELECT * FROM campaign_questions WHERE id = ?').get(req.params.id);
        if (!q) return res.status(404).json({ error: 'השאלה לא נמצאה' });
        const text = clean(req.body?.text);
        if (!text) return res.status(400).json({ error: 'יש להזין את שלב המענה' });
        db.prepare('INSERT INTO campaign_question_steps (question_id, text, created_by) VALUES (?, ?, ?)')
            .run(q.id, text, actor(req));
        if (q.status === 'נשאלה') db.prepare("UPDATE campaign_questions SET status = 'בטיפול' WHERE id = ?").run(q.id);
        audit(actor(req), 'campaign.sinit.question_step', 'campaign_questions', q.id, null, { text });
        touch();
        res.json({ ok: true });
    });

    router.put('/questions/:id', gate('questions', 'write'), (req, res) => {
        const q = db.prepare('SELECT * FROM campaign_questions WHERE id = ?').get(req.params.id);
        if (!q) return res.status(404).json({ error: 'השאלה לא נמצאה' });
        const answer = req.body?.answer === undefined ? q.answer : (clean(req.body.answer) || null);
        const STATUSES = ['נשאלה', 'נשלחה למנהלת', 'בטיפול', 'נענתה', 'נסגרה'];
        const status = STATUSES.includes(req.body?.status) ? req.body.status : (answer && !q.answer ? 'נענתה' : q.status);
        db.prepare(`UPDATE campaign_questions SET answer = ?, status = ?,
                    answered_by = CASE WHEN ? IS NOT NULL THEN ? ELSE answered_by END,
                    answered_at = CASE WHEN ? IS NOT NULL THEN datetime('now','localtime') ELSE answered_at END
                    WHERE id = ?`)
            .run(answer, status, answer, actor(req), answer, q.id);
        if (answer && answer !== q.answer) {
            db.prepare('INSERT INTO campaign_question_steps (question_id, text, created_by) VALUES (?, ?, ?)')
                .run(q.id, `נכתבה תשובה: ${answer}`, actor(req));
        }
        audit(actor(req), 'campaign.sinit.question_update', 'campaign_questions', q.id, { status: q.status }, { status, answer });
        touch();
        res.json({ ok: true });
    });

    router.delete('/questions/:id', mustLogin, mustManager, (req, res) => {
        const before = db.prepare('SELECT * FROM campaign_questions WHERE id = ?').get(req.params.id);
        if (!before) return res.status(404).json({ error: 'השאלה לא נמצאה' });
        db.prepare('DELETE FROM campaign_question_steps WHERE question_id = ?').run(before.id);
        db.prepare('UPDATE campaign_ai_log SET question_id = NULL WHERE question_id = ?').run(before.id);
        db.prepare('DELETE FROM campaign_questions WHERE id = ?').run(before.id);
        audit(actor(req), 'campaign.sinit.question_delete', 'campaign_questions', before.id, before, null);
        touch();
        res.json({ ok: true });
    });

    // ----- בסיס הידע: קבצי וורד -----
    router.get('/kb', mustLogin, (req, res) => {
        const docs = db.prepare(`SELECT d.id, d.filename, d.char_count, d.uploaded_by, d.uploaded_at,
                                 (SELECT COUNT(*) FROM campaign_kb_pairs p WHERE p.doc_id = d.id) AS pairs
                                 FROM campaign_kb_docs d ORDER BY d.id DESC`).all();
        res.json(docs);
    });

    router.get('/kb/:id/pairs', mustLogin, (req, res) => {
        res.json(db.prepare('SELECT * FROM campaign_kb_pairs WHERE doc_id = ? ORDER BY id ASC').all(req.params.id));
    });

    router.post('/kb', mustLogin, requireFeature('campaign_settings'), (req, res) => {
        const filename = clean(req.body?.filename) || 'מסמך.docx';
        if (!/\.docx$/i.test(filename)) {
            return res.status(400).json({ error: 'יש להעלות קובץ Word מסוג .docx (בוורד: שמירה בשם ← Word Document)' });
        }
        let parsed;
        try { parsed = parseDocx(req.body?.data || ''); }
        catch (e) { return res.status(400).json({ error: e.message || 'קריאת קובץ הוורד נכשלה' }); }
        if (!parsed.text.trim()) return res.status(400).json({ error: 'לא נמצא טקסט בקובץ' });

        const r = db.prepare('INSERT INTO campaign_kb_docs (filename, raw_text, char_count, uploaded_by) VALUES (?, ?, ?, ?)')
            .run(filename, parsed.text, parsed.text.length, actor(req));
        const ins = db.prepare('INSERT INTO campaign_kb_pairs (doc_id, question, answer) VALUES (?, ?, ?)');
        for (const p of parsed.pairs) ins.run(r.lastInsertRowid, p.question, p.answer);
        audit(actor(req), 'campaign.sinit.kb_upload', 'campaign_kb_docs', r.lastInsertRowid, null,
            { filename, pairs: parsed.pairs.length, chars: parsed.text.length });
        touch();
        res.json({ ok: true, id: r.lastInsertRowid, pairs: parsed.pairs.length, chars: parsed.text.length });
    });

    router.delete('/kb/:id', mustLogin, requireFeature('campaign_settings'), (req, res) => {
        const before = db.prepare('SELECT id, filename FROM campaign_kb_docs WHERE id = ?').get(req.params.id);
        if (!before) return res.status(404).json({ error: 'המסמך לא נמצא' });
        db.prepare('DELETE FROM campaign_kb_pairs WHERE doc_id = ?').run(before.id);
        db.prepare('DELETE FROM campaign_kb_docs WHERE id = ?').run(before.id);
        audit(actor(req), 'campaign.sinit.kb_delete', 'campaign_kb_docs', before.id, before, null);
        touch();
        res.json({ ok: true });
    });

    // ----- מענה AI -----
    router.get('/ai/log', gate('ai'), (req, res) => {
        res.json(db.prepare(`SELECT a.*, q.status AS question_status FROM campaign_ai_log a
                             LEFT JOIN campaign_questions q ON q.id = a.question_id
                             ORDER BY a.id DESC LIMIT 60`).all());
    });

    router.post('/ai/ask', gate('ai', 'write'), async (req, res) => {
        const question = clean(req.body?.question);
        if (!question) return res.status(400).json({ error: 'יש להזין שאלה' });

        const { pairs, chunks, hasDocs } = retrieve(question);
        const log = (outcome, answer, sourceDoc) => db.prepare(
            'INSERT INTO campaign_ai_log (question, answer, outcome, source_doc, asked_by) VALUES (?, ?, ?, ?, ?)')
            .run(question, answer || null, outcome, sourceDoc || null, actor(req)).lastInsertRowid;

        if (!hasDocs) {
            const id = log('אין מענה', null, null);
            touch();
            return res.json({
                id, outcome: 'אין מענה', needsAdmin: true,
                answer: 'עדיין לא הועלו קבצי וורד לבסיס הידע, ולכן אין לי מאיפה לשאוב תשובה. אפשר לשלוח את השאלה למנהלת המערכת.',
            });
        }

        // התאמה ישירה בחומר — אם השאלה כמעט זהה לשאלה שכבר כתובה בקובץ, עונים ממנה בלי לפנות ל-AI
        const best = pairs[0];
        if (best && best.ratio >= 0.7) {
            const id = log('מהחומר', best.answer, best.filename);
            touch();
            return res.json({
                id, outcome: 'מהחומר', answer: best.answer, source_doc: best.filename,
                matched_question: best.question, needsAdmin: false,
            });
        }

        const apiKey = getSetting('anthropic_api_key');
        if (!apiKey) {
            const id = log('אין מענה', null, null);
            touch();
            return res.json({
                id, outcome: 'אין מענה', needsAdmin: true,
                answer: 'לא נמצאה תשובה מדויקת בחומר, ומפתח ה-AI לא מוגדר במערכת (מסך "חיבורים" אצל המנהלת). אפשר לשלוח את השאלה למנהלת המערכת.',
            });
        }

        const context = [
            ...pairs.map((p) => `מתוך "${p.filename}":\nשאלה: ${p.question}\nתשובה: ${p.answer}`),
            ...chunks.map((c) => `מתוך "${c.filename}":\n${c.text}`),
        ].join('\n\n---\n\n');

        const history = db.prepare(`SELECT question, answer FROM campaign_ai_log
                                    WHERE answer IS NOT NULL AND outcome != 'אין מענה' ORDER BY id DESC LIMIT 4`)
            .all().reverse();

        try {
            const answer = await askClaude(apiKey, question, context || 'אין חומר רלוונטי', history);
            const noAnswer = !answer || answer.replace(/[.!\s]/g, '') === NO_ANSWER.replace(/\s/g, '') || answer.includes(NO_ANSWER);
            const outcome = noAnswer ? 'אין מענה' : 'AI מהחומר';
            const id = log(outcome, noAnswer ? null : answer, pairs[0]?.filename || chunks[0]?.filename || null);
            touch();
            res.json({
                id, outcome, needsAdmin: noAnswer,
                answer: noAnswer
                    ? 'לא מצאתי תשובה לשאלה הזו בחומר שהועלה למערכת. אפשר לשלוח את השאלה למנהלת המערכת.'
                    : answer,
                source_doc: noAnswer ? null : (pairs[0]?.filename || chunks[0]?.filename || null),
            });
        } catch (e) {
            const id = log('אין מענה', null, null);
            touch();
            res.json({
                id, outcome: 'אין מענה', needsAdmin: true,
                answer: `הפנייה ל-AI נכשלה (${e.message}). אפשר לשלוח את השאלה למנהלת המערכת.`,
            });
        }
    });

    // שליחת שאלה שה-AI לא ידע לענות עליה — נרשמת כשאלה רגילה עם שלבי מענה
    router.post('/ai/escalate/:id', gate('ai', 'write'), async (req, res) => {
        const entry = db.prepare('SELECT * FROM campaign_ai_log WHERE id = ?').get(req.params.id);
        if (!entry) return res.status(404).json({ error: 'השאלה לא נמצאה ביומן' });
        if (entry.question_id) return res.status(400).json({ error: 'השאלה הזו כבר נשלחה למנהלת' });

        const r = db.prepare("INSERT INTO campaign_questions (text, asked_by, origin) VALUES (?, ?, 'AI')")
            .run(entry.question, actor(req));
        const qid = r.lastInsertRowid;
        db.prepare('INSERT INTO campaign_question_steps (question_id, text, created_by) VALUES (?, ?, ?)')
            .run(qid, 'השאלה נשאלה את המענה האוטומטי ולא נמצאה לה תשובה בחומר', actor(req));
        db.prepare('UPDATE campaign_ai_log SET question_id = ? WHERE id = ?').run(qid, entry.id);

        const to = adminEmail();
        let mail = { sent: false, to, error: null };
        try {
            if (!to) throw new Error('לא הוגדרה כתובת מייל למנהלת המערכת (בהגדרות הלשונית)');
            await sendMailTo({
                to,
                subject: `שאלה שה-AI לא ידע לענות — ${actor(req)}`,
                html: `<p>${actor(req)} שאלה את המענה האוטומטי של לשונית "מכירה סינית":</p>
                       <blockquote>${entry.question}</blockquote>
                       <p>לא נמצאה תשובה בחומר שהועלה למערכת, ולכן השאלה מועברת אליך.</p>
                       <p>לתשובה: מערכת אמא במשמרת ← קמפיין ← מכירה סינית ← שאלות ושלבי מענה.</p>`,
            });
            mail.sent = true;
            db.prepare("UPDATE campaign_questions SET email_sent_at = datetime('now','localtime'), email_to = ?, status = 'נשלחה למנהלת' WHERE id = ?")
                .run(to, qid);
            db.prepare('INSERT INTO campaign_question_steps (question_id, text, created_by) VALUES (?, ?, ?)')
                .run(qid, `נשלח מייל למנהלת המערכת (${to})`, actor(req));
        } catch (e) {
            mail.error = e.message;
            db.prepare('INSERT INTO campaign_question_steps (question_id, text, created_by) VALUES (?, ?, ?)')
                .run(qid, `שליחת המייל נכשלה: ${e.message}`, actor(req));
        }
        audit(actor(req), 'campaign.sinit.ai_escalate', 'campaign_questions', qid, null, { question: entry.question, mail: mail.sent });
        touch();
        res.json({ ok: true, question_id: qid, mail });
    });

    // ----- הגדרות הלשונית -----
    router.put('/settings', mustLogin, requireFeature('campaign_settings'), (req, res) => {
        const email = clean(req.body?.campaign_admin_email);
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
            return res.status(400).json({ error: 'כתובת המייל אינה תקינה' });
        }
        setCampaignSettings({
            campaign_admin_email: email,
            campaign_admin_name: clean(req.body?.campaign_admin_name) || 'מנהלת המערכת',
        });
        audit(actor(req), 'campaign.sinit.settings', 'campaign_settings', null, null, { campaign_admin_email: email });
        touch();
        res.json({ ok: true, adminEmail: adminEmail() });
    });

    // ----- קישורי שיתוף למתנדבות -----
    // כל קישור פותח מקטע אחד בלבד, בלי קוד עובדת ובלי גישה לשאר המערכת.
    router.get('/share-links', mustLogin, requireFeature('campaign_settings'), (req, res) => {
        res.json({
            sections: SHARE_SECTIONS,
            links: db.prepare('SELECT * FROM campaign_share_links ORDER BY id DESC').all(),
        });
    });

    router.post('/share-links', mustLogin, requireFeature('campaign_settings'), (req, res) => {
        const section = clean(req.body?.section);
        const label = clean(req.body?.label);
        if (!SHARE_SECTIONS[section]) return res.status(400).json({ error: 'יש לבחור מקטע לשיתוף' });
        if (!label) return res.status(400).json({ error: 'יש לתת שם לקישור (למשל: מתנדבות אזור צפון)' });
        const token = randomBytes(12).toString('base64url');
        const r = db.prepare('INSERT INTO campaign_share_links (token, section, label, can_write, created_by) VALUES (?, ?, ?, ?, ?)')
            .run(token, section, label, req.body?.can_write === false ? 0 : 1, actor(req));
        audit(actor(req), 'campaign.sinit.share_create', 'campaign_share_links', r.lastInsertRowid, null, { section, label });
        touch();
        res.json({ ok: true, id: r.lastInsertRowid, token, url: `/share.html?t=${token}` });
    });

    router.put('/share-links/:id', mustLogin, requireFeature('campaign_settings'), (req, res) => {
        const link = db.prepare('SELECT * FROM campaign_share_links WHERE id = ?').get(req.params.id);
        if (!link) return res.status(404).json({ error: 'הקישור לא נמצא' });
        const active = req.body?.active === undefined ? link.active : (req.body.active ? 1 : 0);
        const canWrite = req.body?.can_write === undefined ? link.can_write : (req.body.can_write ? 1 : 0);
        db.prepare('UPDATE campaign_share_links SET active = ?, can_write = ? WHERE id = ?').run(active, canWrite, link.id);
        audit(actor(req), 'campaign.sinit.share_update', 'campaign_share_links', link.id,
            { active: link.active, can_write: link.can_write }, { active, can_write: canWrite });
        touch();
        res.json({ ok: true });
    });

    router.delete('/share-links/:id', mustLogin, requireFeature('campaign_settings'), (req, res) => {
        const link = db.prepare('SELECT * FROM campaign_share_links WHERE id = ?').get(req.params.id);
        if (!link) return res.status(404).json({ error: 'הקישור לא נמצא' });
        db.prepare('DELETE FROM campaign_share_links WHERE id = ?').run(link.id);
        audit(actor(req), 'campaign.sinit.share_delete', 'campaign_share_links', link.id, link, null);
        touch();
        res.json({ ok: true });
    });

    // מה הקישור הזה פותח — נקרא מדף השיתוף עצמו לפני שמציגים משהו
    router.get('/share/info', (req, res) => {
        const link = shareLink(req);
        if (!link) return res.status(404).json({ error: 'הקישור אינו פעיל יותר. אפשר לבקש קישור חדש ממנהלת המערכת.' });
        res.json({
            section: link.section,
            sectionLabel: SHARE_SECTIONS[link.section] || link.section,
            label: link.label,
            canWrite: !!link.can_write,
        });
    });

    // ----- ייצוא לאקסל -----
    router.get('/businesses/export.xlsx', mustLogin, (req, res) => {
        const stages = stageList();
        const rows = businessesWithStages();
        const data = rows.map((b) => {
            const base = {
                'שם העסק': b.name, 'מי פנתה': b.contacted_by || '', 'טלפון': b.phone || '', 'מייל': b.email || '',
                'סטטוס': b.status, 'שלב נוכחי': b.current_stage || '', 'שלבים שהושלמו': `${b.stages_done}/${b.stages_total}`,
                'מוצר': b.product || '', 'שווי': b.value_nis || '', 'תגובה אחרונה': b.response || '',
                'מס\' פנייה': b.contact_number || '', 'מס\' הודעה': b.message_number || '',
                'מקור': b.source || '', 'מודגש': b.highlight ? 'כן' : '', 'נוצר': b.created_at,
            };
            for (const s of stages) base[s.name] = b.done_stage_ids.includes(s.id) ? '✔' : '';
            return base;
        });
        const wb = utils.book_new();
        utils.book_append_sheet(wb, utils.json_to_sheet(data), 'עסקים');
        const buf = write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=businesses.xlsx; filename*=UTF-8''${encodeURIComponent('עסקים — מכירה סינית.xlsx')}`);
        res.send(buf);
    });

    return router;
}
