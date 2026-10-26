// לשונית "מכירה סינית" — עסקים מסונכרנים מכל הטפסים והטבלאות, שלבי סגירה,
// שאלות למנהלת עם שלבי מענה, ומענה AI שנשען על קבצי וורד שהועלו למערכת.
import express from 'express';
import { randomBytes } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { utils, write } from 'xlsx';
import { db, audit, getSetting, getAllCampaignSettings, setCampaignSettings, isManagerOrAbove, hasFeature } from './db.js';
import { getCampaignSheetsCache, fetchSheetRows, POINTS_SHEET_ID } from './sheets-sync.js';
import { parseDocx, extractPairsFromText } from './docx.js';
import { sendMailTo, mailProvider, mailReady, mailFrom } from './integrations.js';

const BUILTIN_STATUSES = ['ממתין', 'נוצר קשר', 'תרם', 'סירב'];
// לשונית הדיווחים בגיליון הנקודות — כל גיוס שדווח דרך הטלפון נרשם שם
export const REPORTS_SHEET_TAB = 'פרטי דיווחים';
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
// השדות שאפשר לערוך ידנית בכרטיס העסק. השדות החופשיים (extra) נשמרים בנפרד.
const EDITABLE_FIELDS = ['name', 'contacted_by', 'phone', 'email', 'product', 'value_nis',
    'pickup', 'validity', 'logo_url', 'contact_number', 'message_number', 'response'];

function manualSet(biz) {
    try { return new Set(JSON.parse(biz.manual_fields || '[]')); } catch { return new Set(); }
}

function parseExtra(biz) {
    try {
        const o = JSON.parse(biz.extra || '{}');
        return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
    } catch { return {}; }
}

function upsertFromSource(rec, sourceName) {
    const name = clean(rec.name);
    if (!name) return 'skipped';
    // הזיהוי מול המקור מבוסס על הטלפון כשהוא קיים, ולא על השם: שם יכול להשתנות
    // (למשל כשמחליפים "ללא שם · 05..." בשם האמיתי) ואז סנכרון חוזר היה יוצר כפילות.
    const phoneKey = clean(rec.phone).replace(/\D/g, '');
    const key = phoneKey ? `${sourceName}|tel:${phoneKey}` : `${sourceName}|${normName(name)}`;
    let existing = db.prepare('SELECT * FROM campaign_businesses WHERE external_key = ?').get(key);
    if (!existing) {
        // אותו עסק אולי הוקלד ידנית לפני שהטופס סונכרן, או נקלט קודם לפי שם —
        // מזהים לפי טלפון או לפי שם מנורמל, כדי לא ליצור כפילות
        const all = db.prepare('SELECT * FROM campaign_businesses').all();
        existing = (phoneKey && all.find((b) => String(b.phone || '').replace(/\D/g, '') === phoneKey))
            || all.find((b) => normName(b.name) === normName(name));
    }

    // נתיב ההקלטה של שם העסק נשמר כשדה חופשי, כדי שאפשר יהיה לאתר אותו בימות
    const withRecording = (bizId) => {
        if (!clean(rec.recording)) return;
        const row = db.prepare('SELECT extra FROM campaign_businesses WHERE id = ?').get(bizId);
        const extra = parseExtra(row);
        if (extra['הקלטת שם העסק'] === clean(rec.recording)) return;
        extra['הקלטת שם העסק'] = clean(rec.recording);
        db.prepare('UPDATE campaign_businesses SET extra = ? WHERE id = ?').run(JSON.stringify(extra), bizId);
    };

    if (!existing) {
        const r = db.prepare(`INSERT INTO campaign_businesses
            (name, contacted_by, phone, email, response, status, source, external_key, product, value_nis, pickup, validity, logo_url, created_at, synced_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))`)
            .run(name, clean(rec.contacted_by) || null, clean(rec.phone) || null, clean(rec.email) || null,
                clean(rec.response) || null, allStatuses().includes(rec.status) ? rec.status : 'תרם',
                sourceName, key, clean(rec.product) || null, clean(rec.value_nis) || null,
                clean(rec.pickup) || null, clean(rec.validity) || null, clean(rec.logo_url) || null);
        withRecording(r.lastInsertRowid);
        return { outcome: 'added', id: r.lastInsertRowid };
    }

    // שדות שנערכו ידנית כאן מנצחים את המקור: בלי זה כל סנכרון היה מחזיר
    // את הערך הישן מהגיליון ומוחק את מה שהמנהלת השלימה בעצמה
    const locked = manualSet(existing);
    const srcWins = (field, value) => (locked.has(field) ? null : (clean(value) || null));
    const fillOnly = (field, value) => (locked.has(field) ? null : (clean(value) || null));

    db.prepare(`UPDATE campaign_businesses SET
            external_key = COALESCE(external_key, ?),
            contacted_by = COALESCE(NULLIF(contacted_by,''), ?),
            phone        = COALESCE(NULLIF(phone,''), ?),
            email        = COALESCE(NULLIF(email,''), ?),
            product      = COALESCE(?, product),
            value_nis    = COALESCE(?, value_nis),
            pickup       = COALESCE(?, pickup),
            validity     = COALESCE(?, validity),
            logo_url     = COALESCE(?, logo_url),
            synced_at    = datetime('now','localtime')
        WHERE id = ?`)
        .run(key, fillOnly('contacted_by', rec.contacted_by), fillOnly('phone', rec.phone), fillOnly('email', rec.email),
            srcWins('product', rec.product), srcWins('value_nis', rec.value_nis), srcWins('pickup', rec.pickup),
            srcWins('validity', rec.validity), srcWins('logo_url', rec.logo_url),
            existing.id);
    withRecording(existing.id);
    return { outcome: 'updated', id: existing.id };
}

// מאתרת עמודה לפי מילות מפתח חלקיות בכותרת, **לפי סדר העדיפות של מילות המפתח**.
// הסדר קריטי: בגיליון הדיווחים יש גם "טלפון" (של המדווחת) וגם "טלפון העסק" — חיפוש
// לפי סדר העמודות היה מחזיר את הראשון שנתקל בו ומשבץ את הטלפון הלא נכון.
function col(row, words, exclude = []) {
    const keys = Object.keys(row).filter((k) => !exclude.some((x) => k.includes(x)));
    for (const w of words) {
        const key = keys.find((k) => k.replace(/\s+/g, ' ').includes(w));
        if (key && String(row[key] ?? '').trim() !== '') return row[key];
    }
    return '';
}

// עמודות שלעולם אינן שם של עסק — בלי החרגה כזו, מילת מפתח כללית כמו "עסק"
// נתפסת על "טלפון העסק" ושם העסק מתמלא במספר טלפון.
const NOT_A_NAME = ['טלפון', 'נייד', 'פלאפון', 'מייל', 'אימייל', 'דוא', 'תאריך', 'שעה', 'סכום', 'עלות', 'שווי'];

// מאחדת שני תיאורי מוצר לשדה אחד, בלי לכפול כשאחד מוכל בשני
function joinProduct(main, extra) {
    const a = clean(main);
    const b = clean(extra);
    if (!a) return b;
    if (!b || a.includes(b) || b.includes(a)) return a;
    return `${a} (${b})`;
}

// מיפוי שורה של גיליון לשדות עסק — משותף לכל מקורות הסנכרון.
// כששם העסק חסר (קורה כמעט תמיד בדיווחי הטלפון) עדיין יוצרים רשומה, עם שם זמני
// לפי הטלפון: אחרת דיווח אמיתי — עם מוצר, שווי ומגייסת — פשוט נעלם ולא ניתן לחיפוש.
function rowToBusiness(row) {
    const rec = rawRowToBusiness(row);
    if (!clean(rec.name)) {
        const idPart = clean(rec.phone) || clean(rec.email);
        if (idPart) { rec.name = `ללא שם · ${idPart}`; rec.unnamed = true; }
    }
    return rec;
}

// במערכת הטלפונית שם העסק מוקלט ולא מוקלד, ואז העמודה "שם העסק" מכילה נתיב
// להקלטה (/campaign1/Messages/05....wav) במקום טקסט. זה לא שם — אבל כן רמז
// שימושי, ולכן הוא נשמר בנפרד כדי שאפשר יהיה לאתר את ההקלטה בימות.
const RECORDING_RE = /(^\/|\bMessages\/)|\.wav\s*$/i;
function isRecordingPath(v) {
    const s = clean(v);
    return !!s && RECORDING_RE.test(s);
}

function rawRowToBusiness(row) {
    const rawName = col(row, ['שם העסק', 'שם עסק', 'שם התורם', 'תורם', 'חנות', 'ספק', 'עסק'], NOT_A_NAME);
    // עמודות "אישור..." מכילות 1/0 ולא ערך אמיתי, ומילת מפתח כללית כמו "מייל"
    // נתפסת עליהן ("אישור שליחת אימייל"). מסננים אותן, ובנוסף מאמתים את הערך עצמו.
    const NOT_A_VALUE = ['אישור', 'סטטוס', 'תאריך'];
    const rawEmail = col(row, ['מייל העסק', 'אימייל העסק', 'מייל', 'אימייל', 'דוא'], NOT_A_VALUE);
    const rawPhone = col(row, ['טלפון העסק', 'נייד העסק', 'טלפון', 'נייד', 'פלאפון'], NOT_A_VALUE);
    return {
        name: isRecordingPath(rawName) ? '' : rawName,
        recording: isRecordingPath(rawName) ? clean(rawName) : '',
        phone: clean(rawPhone).replace(/\D/g, '').length >= 7 ? rawPhone : '',
        email: /\S+@\S+\.\S+/.test(clean(rawEmail)) ? rawEmail : '',
        contacted_by: col(row, ['שם המגייס', 'מי פנתה', 'מגייסת', 'אחראית', 'שם המדווח', 'מתנדבת']),
        // שתי עמודות שונות מתארות את אותו מוצר: "המוצר שגויס" הוא בדרך כלל התיאור
        // המלא (ושם העסק מסתתר בתוכו), ו"תיאור המוצר" הוא הסוג. מאחדים כדי ששניהם
        // יופיעו בכרטיס ויימצאו בחיפוש.
        product: joinProduct(
            col(row, ['המוצר שגויס', 'מוצר שגויס']),
            col(row, ['תיאור המוצר', 'מוצר', 'תרומה', 'פרס']),
        ),
        value_nis: col(row, ['סכום עלות המוצר', 'שווי', 'סכום', 'עלות', 'ערך']),
        pickup: col(row, ['איסוף המוצר', 'איסוף']),
        response: col(row, ['תגובה', 'הערה', 'הערות']),
        status: clean(col(row, ['סטטוס', 'מצב'])),
    };
}

// תיקון חד-פעמי: עסקים שנקלטו לפני שזוהו נתיבי ההקלטה נשמרו עם הנתיב כשם.
// מחליפים לשם הזמני לפי הטלפון ושומרים את ההקלטה כשדה חופשי.
function repairRecordingNames() {
    // ערכי "1" שנקלטו בטעות כמייל (מעמודת "אישור שליחת אימייל") — מנקים
    const badMail = db.prepare(`UPDATE campaign_businesses SET email = NULL
        WHERE email IS NOT NULL AND email != '' AND email NOT LIKE '%@%'`).run().changes;
    if (badMail) console.log(`נוקו ${badMail} ערכי מייל שגויים`);

    const rows = db.prepare('SELECT id, name, phone, email, extra FROM campaign_businesses').all();
    let fixed = 0;
    for (const b of rows) {
        if (!isRecordingPath(b.name)) continue;
        const idPart = clean(b.phone) || clean(b.email);
        const extra = parseExtra(b);
        extra['הקלטת שם העסק'] = clean(b.name);
        db.prepare('UPDATE campaign_businesses SET name = ?, extra = ? WHERE id = ?')
            .run(idPart ? `ללא שם · ${idPart}` : 'ללא שם', JSON.stringify(extra), b.id);
        fixed++;
    }
    if (fixed) console.log(`תוקנו ${fixed} עסקים ששמם היה נתיב הקלטה`);
    return fixed;
}

export async function syncSinitBusinesses() {
    const result = { sources: [], added: 0, updated: 0, errors: [] };
    result.repairedNames = repairRecordingNames();

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

    // (2) לשונית "פרטי דיווחים" בגיליון הנקודות — כל דיווח גיוס שנכנס דרך הטלפון
    try {
        const rows = await fetchSheetRows(POINTS_SHEET_ID, REPORTS_SHEET_TAB);
        let a = 0, u = 0;
        for (const row of rows) {
            const rec = rowToBusiness(row);
            if (!clean(rec.name)) continue;   // דיווח בלי שם תורם — אין ממה ליצור עסק
            const res = upsertFromSource(rec, 'פרטי דיווחים');
            if (res.outcome === 'added') a++; else if (res.outcome === 'updated') u++;
        }
        result.sources.push({ name: 'פרטי דיווחים', rows: rows.length, added: a, updated: u });
        result.added += a; result.updated += u;
    } catch (e) {
        result.errors.push(`פרטי דיווחים: ${e.message}`);
        result.sources.push({ name: 'פרטי דיווחים', error: e.message });
    }

    // (3) מקורות נוספים שהמנהלת הגדירה בעצמה
    const sources = db.prepare('SELECT * FROM campaign_sync_sources WHERE active = 1 ORDER BY id ASC').all();
    for (const src of sources) {
        try {
            const rows = await fetchSheetRows(src.sheet_id, src.sheet_name);
            let a = 0, u = 0;
            for (const row of rows) {
                const rec = rowToBusiness(row);
                if (!clean(rec.name)) continue;
                const res = upsertFromSource(rec, src.name);
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

// ---------- מסמך התשובות של המנהלת (Google Docs) ----------
// הלולאה: ה-AI לא ידע לענות → נשלח מייל עם קישור למסמך → המנהלת כותבת שם את התשובה
// → המערכת שואבת את המסמך ומכניסה את התשובות לבסיס הידע → בפעם הבאה יש מענה.
export const ANSWERS_DOC_NAME = 'מסמך התשובות של המנהלת (Google Docs)';

export function answersDocId() {
    const url = getAllCampaignSettings().campaign_answers_doc_url || '';
    const m = url.match(/\/document\/d\/([a-zA-Z0-9-_]+)/) || url.match(/^([a-zA-Z0-9-_]{20,})$/);
    return m ? m[1] : null;
}

export async function syncAnswersDoc() {
    const id = answersDocId();
    if (!id) return { configured: false };
    const res = await fetch(`https://docs.google.com/document/d/${id}/export?format=txt`);
    if (res.status === 401 || res.status === 403) {
        throw new Error('המסמך סגור לקריאה. יש לפתוח אותו ב-Google Docs ← שיתוף ← "כל מי שיש לו הקישור" בהרשאת צפייה, ואז לסנכרן שוב.');
    }
    if (res.status === 404) throw new Error('המסמך לא נמצא — ייתכן שהקישור שגוי או שהמסמך נמחק.');
    if (!res.ok) throw new Error(`שליפת המסמך נכשלה (${res.status})`);

    let text = await res.text();
    // גוגל מחזיר BOM בתחילת הייצוא, שמבלבל את זיהוי השורה הראשונה
    text = text.replace(/^﻿/, '');
    const { text: clean_, pairs } = extractPairsFromText(text);

    // מסמך אחד קבוע במסד — כל סנכרון מחליף את תוכנו, כדי שעריכה בגוגל תשתקף ולא תצטבר
    const existing = db.prepare('SELECT id FROM campaign_kb_docs WHERE filename = ?').get(ANSWERS_DOC_NAME);
    let docId = existing?.id;
    if (docId) {
        db.prepare('DELETE FROM campaign_kb_pairs WHERE doc_id = ?').run(docId);
        db.prepare('UPDATE campaign_kb_docs SET raw_text = ?, char_count = ?, uploaded_at = datetime(\'now\',\'localtime\') WHERE id = ?')
            .run(clean_, clean_.length, docId);
    } else {
        docId = db.prepare('INSERT INTO campaign_kb_docs (filename, raw_text, char_count, uploaded_by) VALUES (?, ?, ?, ?)')
            .run(ANSWERS_DOC_NAME, clean_, clean_.length, 'סנכרון אוטומטי').lastInsertRowid;
    }
    const ins = db.prepare('INSERT INTO campaign_kb_pairs (doc_id, question, answer) VALUES (?, ?, ?)');
    for (const p of pairs) ins.run(docId, p.question, p.answer);
    return { configured: true, pairs: pairs.length, chars: clean_.length, docId };
}

// הטקסט שנשלח במייל כשאין מענה — כולל קישור למסמך ושורות מוכנות להדבקה
function answersDocMailBlock(question) {
    const url = getAllCampaignSettings().campaign_answers_doc_url;
    if (!url) return '';
    return `
        <div style="background:#f6f8fb;border-right:3px solid #14497c;padding:12px 14px;margin:14px 0">
          <p style="margin:0 0 8px"><b>כדי שהמערכת תדע לענות על זה בפעם הבאה:</b></p>
          <p style="margin:0 0 8px">פתחי את <a href="${url}">מסמך התשובות</a> והוסיפי בסופו את שתי השורות האלה
             (אפשר פשוט להעתיק אותן מכאן ולהשלים את התשובה):</p>
          <pre style="background:#fff;border:1px solid #e3e8f0;padding:10px;white-space:pre-wrap;font-family:Arial,sans-serif;margin:0">שאלה: ${question}
תשובה: </pre>
          <p style="margin:8px 0 0;color:#5a6b85;font-size:13px">המערכת קוראת את המסמך כל כמה דקות, ומהרגע שהתשובה כתובה שם — היא תינתן אוטומטית לשאלות הבאות.</p>
        </div>`;
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

// התאמה נמדדת לשני הכיוונים: כמה ממילות השאלה נמצאות בשאלה שבקובץ (ratio),
// וכמה מהשאלה שבקובץ מכוסה על ידי השאלה שנשאלה (coverage). בלי הכיוון השני,
// שאלה ארוכה בקובץ שבמקרה מכילה שתיים-שלוש מהמילים נחשבת "התאמה מלאה"
// והמערכת מחזירה את התשובה הלא נכונה.
function scorePair(tokens, pair) {
    const q = normHeb(pair.question);
    const a = normHeb(pair.answer);
    let qHits = 0, aHits = 0;
    for (const t of tokens) {
        if (tokenHits(t, q)) qHits++;
        else if (tokenHits(t, a)) aHits++;
    }
    const pairTokens = tokenize(pair.question);
    const covered = pairTokens.filter((t) => tokens.some((qt) => qt === t || tokenHits(t, tokens.join(' ')))).length;
    return {
        score: qHits * 3 + aHits,
        ratio: tokens.length ? qHits / tokens.length : 0,
        coverage: pairTokens.length ? covered / pairTokens.length : 0,
    };
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

מקור המידע: רק מה שכתוב בחומר שמצורף לשאלה (נלקח מקבצי הוורד שהמנהלת העלתה).
אסור להוסיף מידע מהידע הכללי שלך, לנחש, או להמציא מספרים ותאריכים.
אם התשובה לשאלה לא נמצאת בחומר — החזירי בדיוק את המשפט: אין לי מענה

איך לענות:
- עני על מה שנשאל בפועל, ולא על נושא קרוב. אם השאלה היא "מתי", עני תאריך; "כמה" — עני מספר; "מי" — עני שם.
- החומר שמצורף הוא חומר גלם לחיפוש, לא התשובה. אל תעתיקי ממנו פסקאות ואל תצטטי אותו באריכות —
  שלפי ממנו רק את הפרט שעונה על השאלה ונסחי אותו במשפט משלך.
- שתיים-שלוש שורות הן התשובה הנכונה כמעט תמיד. אם צריך יותר מזה (למשל רשימת שלבים שכתובה בחומר) —
  נקודות קצרות, בלי הקדמה ובלי סיכום.
- בלי פתיחות ("שאלה טובה", "על פי החומר"), בלי הצעות המשך, ובלי לחזור על השאלה.
- אם החומר עונה רק על חלק מהשאלה — עני על החלק הזה ואמרי במשפט אחד מה חסר.`;

const NO_ANSWER = 'אין לי מענה';

// תרגום שגיאות שליחת מייל — רובן מצביעות על סיסמת אפליקציה שגויה, לא על באג
function mailErrorText(e) {
    const raw = String(e?.message || '');
    if (/חסרים פרטי Gmail/.test(raw)) return raw;
    // שגיאות Resend — המפתח או כתובת השולח, כמעט תמיד
    if (/^resend:401/.test(raw)) {
        return 'מפתח ה-Resend אינו תקף. יש להעתיק אותו מחדש מ-resend.com ← API Keys ולהדביק בלשונית "חיבורים".';
    }
    if (/^resend:403/.test(raw) || /domain is not verified|not verified/i.test(raw)) {
        return 'כתובת השולח אינה מאושרת ב-Resend. אפשר להשאיר את שדה "כתובת השולח" ריק (אז נשלח מ-onboarding@resend.dev, שמגיע רק לכתובת שאיתה נרשמת ל-Resend), או לאמת דומיין משלך ב-Resend ← Domains.';
    }
    if (/^resend:422/.test(raw)) {
        return 'Resend דחה את הבקשה — בדרך כלל כתובת שולח בפורמט לא תקין, או שליחה לכתובת אחרת בזמן שימוש ב-onboarding@resend.dev. פרטים: ' + raw.replace(/^resend:\d+:\s*/, '');
    }
    if (/^resend:429/.test(raw)) return 'נשלחו יותר מדי מיילים דרך Resend בזמן קצר — כדאי לנסות שוב בעוד דקה.';
    if (/^resend:/.test(raw)) return 'שליחה דרך Resend נכשלה: ' + raw.replace(/^resend:\d+:\s*/, '');
    if (/Invalid login|535|BadCredentials|Username and Password not accepted/i.test(raw)) {
        return 'ג\'ימייל דחה את ההתחברות. כמעט תמיד הסיבה היא סיסמת אפליקציה שגויה או סיסמה רגילה במקום סיסמת אפליקציה (16 תווים, בלי רווחים) — יש להנפיק מחדש בחשבון גוגל ← אבטחה ← סיסמאות אפליקציה.';
    }
    if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|network|getaddrinfo/i.test(raw)) {
        return 'השרת לא הצליח להתחבר לשרת המייל של גוגל. אם זה חוזר — ייתכן שהחיבור היוצא חסום.';
    }
    if (/Invalid recipient|no recipients|553|550/i.test(raw)) return 'כתובת היעד נדחתה — כדאי לבדוק שאין בה שגיאת כתיב.';
    return `שליחת המייל נכשלה: ${raw}`;
}

// תרגום שגיאות ה-API להסבר שאומר למנהלת מה לעשות, במקום להדפיס JSON גולמי בצ'אט
function aiErrorText(e) {
    const raw = String(e?.message || '');
    if (/authentication_error|401|invalid x-api-key/i.test(raw)) {
        return 'מפתח ה-AI שמוגדר במערכת אינו תקף (אולי פג תוקף או הוחלף). יש להנפיק מפתח חדש ולהדביק אותו במסך "חיבורים".';
    }
    if (/credit balance|billing|payment/i.test(raw)) {
        return 'נגמר הקרדיט בחשבון ה-AI. יש להטעין ב-platform.claude.com ← Billing.';
    }
    if (/rate_limit|429/i.test(raw)) return 'יותר מדי שאלות בבת אחת — כדאי לנסות שוב בעוד דקה.';
    if (/overloaded|529|5\d\d/.test(raw)) return 'שירות ה-AI עמוס כרגע. כדאי לנסות שוב בעוד כמה דקות.';
    if (/fetch failed|ENOTFOUND|ETIMEDOUT|network/i.test(raw)) return 'אין כרגע חיבור לשירות ה-AI מהשרת.';
    return 'הפנייה ל-AI נכשלה.';
}
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
            const r = await client.messages.create({
                model, max_tokens: 700, system: AI_SYSTEM, messages,
                // שליפת פרט מתוך חומר נתון לא דורשת חשיבה עמוקה — effort נמוך מקצר תגובה ועלות
                output_config: { effort: 'low' },
            });
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
            mailReady: mailReady(),
            mailProvider: mailProvider(),
            mailFrom: mailFrom() || null,
            answersDocUrl: getAllCampaignSettings().campaign_answers_doc_url || '',
            answersDocPairs: (() => {
                try {
                    const d = db.prepare('SELECT id, uploaded_at FROM campaign_kb_docs WHERE filename = ?').get(ANSWERS_DOC_NAME);
                    if (!d) return null;
                    const c = db.prepare('SELECT COUNT(*) c FROM campaign_kb_pairs WHERE doc_id = ?').get(d.id).c;
                    return { pairs: c, syncedAt: d.uploaded_at };
                } catch { return null; }
            })(),
            resendKeySet: !!getSetting('resend_api_key'),
            resendFrom: getSetting('resend_from') || '',
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

        // כל שדה שנשלח במפורש נרשם כ"ידני" ומוגן מפני דריסה בסנכרון הבא.
        // שינוי צבע או סטטוס לבדו לא נוגע ברשימה הזו.
        const locked = manualSet(before);
        for (const f of EDITABLE_FIELDS) {
            if (b[f] === undefined) continue;
            if (clean(b[f]) === clean(before[f] ?? '')) continue;   // לא השתנה — לא ננעל
            locked.add(f);
        }

        // שדות חופשיים: אובייקט של שם:ערך. ערך ריק מוחק את השדה.
        let extra = parseExtra(before);
        if (b.extra && typeof b.extra === 'object' && !Array.isArray(b.extra)) {
            extra = {};
            for (const [k, v] of Object.entries(b.extra)) {
                const key = clean(k).slice(0, 60);
                const val = clean(v).slice(0, 500);
                if (key && val) extra[key] = val;
            }
        }

        db.prepare(`UPDATE campaign_businesses SET name=?, contacted_by=?, phone=?, email=?, response=?, status=?,
                    contact_number=?, message_number=?, product=?, value_nis=?, pickup=?, validity=?, logo_url=?,
                    color=?, highlight=?, manual_fields=?, extra=?,
                    updated_at=datetime('now','localtime') WHERE id=?`)
            .run(clean(b.name) || before.name, pick('contacted_by', before.contacted_by), pick('phone', before.phone),
                pick('email', before.email), pick('response', before.response), status,
                pick('contact_number', before.contact_number), pick('message_number', before.message_number),
                pick('product', before.product), pick('value_nis', before.value_nis),
                pick('pickup', before.pickup), pick('validity', before.validity), pick('logo_url', before.logo_url),
                color, highlight, JSON.stringify([...locked]), JSON.stringify(extra), before.id);
        audit(actor(req), 'campaign.business.update', 'campaign_businesses', before.id,
            { status: before.status, color: before.color, highlight: before.highlight },
            { status, color, highlight, response: pick('response', before.response) });
        touch();
        res.json({ ok: true });
    });

    router.delete('/businesses/:id', mustLogin, mustManager, (req, res) => {
        const before = db.prepare('SELECT * FROM campaign_businesses WHERE id = ?').get(req.params.id);
        if (!before) return res.status(404).json({ error: 'העסק לא נמצא' });
        const who = actor(req);
        // שאלות שנפתחו על העסק נשארות — הן עשויות להיות באמצע טיפול. מנתקים את הקישור
        // ומוסיפים שלב שמתעד שהעסק נמחק, כדי שלא יישאר הקשר חסר. בלי זה המחיקה נכשלת
        // על אילוץ המפתח הזר שבין השאלות לעסקים.
        const purge = db.transaction(() => {
            const linked = db.prepare('SELECT id FROM campaign_questions WHERE business_id = ?').all(before.id);
            const addStep = db.prepare('INSERT INTO campaign_question_steps (question_id, text, created_by) VALUES (?, ?, ?)');
            for (const q of linked) addStep.run(q.id, `העסק "${before.name}" נמחק מרשימת העסקים`, who);
            db.prepare('UPDATE campaign_questions SET business_id = NULL WHERE business_id = ?').run(before.id);
            db.prepare('DELETE FROM campaign_business_stages WHERE business_id = ?').run(before.id);
            db.prepare('DELETE FROM campaign_business_notes WHERE business_id = ?').run(before.id);
            db.prepare('DELETE FROM campaign_businesses WHERE id = ?').run(before.id);
            return linked.length;
        });
        const detached = purge();
        audit(who, 'campaign.business.delete', 'campaign_businesses', before.id, before, { detachedQuestions: detached });
        touch();
        res.json({ ok: true, detachedQuestions: detached });
    });

    // כל מה שידוע על עסק אחד: פרטים, תגובות, שלבי סגירה, שאלות עליו ואזכורים בגיליון התנועות
    router.get('/businesses/:id/detail', gate('businesses'), (req, res) => {
        const biz = businessesWithStages().find((b) => b.id === Number(req.params.id));
        if (!biz) return res.status(404).json({ error: 'העסק לא נמצא' });
        const stages = stageList();
        const progress = db.prepare('SELECT * FROM campaign_business_stages WHERE business_id = ?').all(biz.id);
        const pMap = new Map(progress.map((p) => [p.stage_id, p]));
        const raw = db.prepare('SELECT * FROM campaign_businesses WHERE id = ?').get(biz.id);
        res.json({
            biz: { ...biz, manualFields: [...manualSet(raw)], extra: parseExtra(raw) },
            editableFields: EDITABLE_FIELDS,
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
                           ${answersDocMailBlock(text)}
                           <p>אפשר גם לענות ישירות במערכת, בלשונית "מכירה סינית" ← שאלות ושלבי מענה.</p>`,
                });
                mail.sent = true;
                db.prepare("UPDATE campaign_questions SET email_sent_at = datetime('now','localtime'), email_to = ?, status = 'נשלחה למנהלת' WHERE id = ?")
                    .run(mail.to, id);
                db.prepare('INSERT INTO campaign_question_steps (question_id, text, created_by) VALUES (?, ?, ?)')
                    .run(id, `נשלח מייל למנהלת המערכת (${mail.to})`, actor(req));
            } catch (e) {
                mail.error = mailErrorText(e);
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

    // שליפה ידנית של מסמך התשובות (רץ גם אוטומטית כל 5 דקות)
    router.post('/answers-doc/sync', mustLogin, requireFeature('campaign_settings'), async (req, res) => {
        try {
            const r = await syncAnswersDoc();
            if (!r.configured) return res.status(400).json({ error: 'לא הוגדר קישור למסמך התשובות' });
            audit(actor(req), 'campaign.sinit.answers_doc_sync', 'campaign_kb_docs', r.docId, null, { pairs: r.pairs });
            touch();
            res.json(r);
        } catch (e) { res.status(400).json({ error: e.message }); }
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

        // התאמה ישירה בחומר — רק כששלושת התנאים מתקיימים: השאלה כמעט זהה לשאלה שבקובץ (ratio),
        // השאלה שבקובץ לא רחבה בהרבה מהנשאל (coverage), והתשובה עצמה קצרה. אחרת מעבירים ל-AI
        // שישלוף את הפרט הרלוונטי במקום להחזיר פסקה שלמה מהמסמך.
        const DIRECT_ANSWER_MAX = 350;
        const apiKeyForDirect = getSetting('anthropic_api_key');
        const best = pairs[0];
        const tightMatch = !!best && best.ratio >= 0.8 && best.coverage >= 0.6
            && best.answer.length <= DIRECT_ANSWER_MAX;
        // בלי מפתח AI אין אלטרנטיבה, אז מחזירים גם התאמה בינונית — עדיף מכלום
        if (best && (tightMatch || (!apiKeyForDirect && best.ratio >= 0.7))) {
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
                answer: `${aiErrorText(e)} אפשר לשלוח את השאלה למנהלת המערכת.`,
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
                       ${answersDocMailBlock(entry.question)}
                       <p>אפשר גם לענות ישירות במערכת: קמפיין ← מכירה סינית ← שאלות ושלבי מענה.</p>`,
            });
            mail.sent = true;
            db.prepare("UPDATE campaign_questions SET email_sent_at = datetime('now','localtime'), email_to = ?, status = 'נשלחה למנהלת' WHERE id = ?")
                .run(to, qid);
            db.prepare('INSERT INTO campaign_question_steps (question_id, text, created_by) VALUES (?, ?, ?)')
                .run(qid, `נשלח מייל למנהלת המערכת (${to})`, actor(req));
        } catch (e) {
            mail.error = mailErrorText(e);
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
        const docUrl = clean(req.body?.campaign_answers_doc_url);
        if (docUrl && !/\/document\/d\/[a-zA-Z0-9-_]+/.test(docUrl)) {
            return res.status(400).json({ error: 'הקישור צריך להיות למסמך Google Docs (כתובת שמכילה /document/d/...)' });
        }
        setCampaignSettings({
            campaign_admin_email: email,
            campaign_admin_name: clean(req.body?.campaign_admin_name) || 'מנהלת המערכת',
            ...(req.body?.campaign_answers_doc_url !== undefined ? { campaign_answers_doc_url: docUrl } : {}),
        });
        audit(actor(req), 'campaign.sinit.settings', 'campaign_settings', null, null, { campaign_admin_email: email });
        touch();
        res.json({ ok: true, adminEmail: adminEmail() });
    });

    // בדיקת מייל: שולחת מייל אמיתי לכתובת המנהלת ומחזירה בדיוק מה נכשל, כדי שלא
    // צריך לגלות שהמייל לא מוגדר רק אחרי ששאלה אמיתית נשלחה ולא הגיעה.
    router.post('/settings/test-mail', mustLogin, requireFeature('campaign_settings'), async (req, res) => {
        const to = adminEmail();
        if (!to) {
            return res.json({ ok: false, error: 'לא הוגדרה כתובת מייל למנהלת המערכת, וגם לא כתובת לדוח היומי. יש למלא את השדה כאן ולשמור.' });
        }
        if (!mailReady()) {
            return res.json({ ok: false, to, error: 'כתובת המייל מוגדרת, אבל אין ערוץ שליחה. יש להגדיר מפתח Resend (הדרך הפשוטה — מפתח אחד, בלי חשבון Gmail) או כתובת Gmail עם סיסמת אפליקציה, בלשונית "חיבורים".' });
        }
        try {
            await sendMailTo({
                to,
                subject: 'בדיקת מייל — לשונית מכירה סינית',
                html: `<p>זו הודעת בדיקה ממערכת אמא במשמרת.</p>
                       <p>אם הגיעה אליך — שאלות שנשלחות מלשונית "מכירה סינית" יגיעו לכאן.</p>`,
            });
            audit(actor(req), 'campaign.sinit.test_mail', 'campaign_settings', null, null, { to, via: mailProvider() });
            res.json({ ok: true, to, via: mailProvider(), from: mailFrom() });
        } catch (e) {
            res.json({ ok: false, to, error: mailErrorText(e) });
        }
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
