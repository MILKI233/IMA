// קריאת קובץ וורד (.docx) בלי ספרייה חיצונית.
// קובץ docx הוא בפועל קובץ ZIP שבתוכו word/document.xml, ו-Node יודע לפרוס Deflate לבד (zlib),
// לכן אין צורך בתלות נוספת ב-npm — חשוב כי הפריסה לענן בונה מחדש את התלויות.
import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;   // סוף הספרייה המרכזית של ה-ZIP
const CEN_SIG = 0x02014b50;    // רשומה בספרייה המרכזית
const LOC_SIG = 0x04034b50;    // כותרת מקומית של קובץ

// שליפת קובץ בודד מתוך ה-ZIP לפי שמו
function readZipEntry(buf, wantedName) {
    // ה-EOCD נמצא בסוף הקובץ (ייתכן אחריו "הערה" באורך משתנה) — סורקים אחורה
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
        if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd === -1) throw new Error('הקובץ אינו קובץ וורד תקין (לא נמצא מבנה ZIP)');

    const entries = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16); // תחילת הספרייה המרכזית

    for (let i = 0; i < entries; i++) {
        if (buf.readUInt32LE(p) !== CEN_SIG) break;
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const localOffset = buf.readUInt32LE(p + 42);
        const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

        if (name === wantedName) {
            if (buf.readUInt32LE(localOffset) !== LOC_SIG) throw new Error('מבנה ה-ZIP פגום');
            // את אורכי השדות קוראים מהכותרת המקומית עצמה — היא עשויה להיות שונה מזו שבספרייה המרכזית
            const method = buf.readUInt16LE(localOffset + 8);
            const locNameLen = buf.readUInt16LE(localOffset + 26);
            const locExtraLen = buf.readUInt16LE(localOffset + 28);
            const dataStart = localOffset + 30 + locNameLen + locExtraLen;
            // הגדלים בכותרת המקומית לפעמים אפס (נתונים נשלחים בזרם) — אז לוקחים מהספרייה המרכזית
            const compSize = buf.readUInt32LE(localOffset + 18) || buf.readUInt32LE(p + 20);
            const raw = buf.subarray(dataStart, dataStart + compSize);
            if (method === 0) return raw;                       // ללא דחיסה
            if (method === 8) return zlib.inflateRawSync(raw);   // Deflate
            throw new Error(`שיטת דחיסה לא נתמכת בקובץ (${method})`);
        }
        p += 46 + nameLen + extraLen + commentLen;
    }
    throw new Error('לא נמצא תוכן מסמך בקובץ — ודאי שזה קובץ Word מסוג .docx (לא .doc ולא PDF)');
}

function decodeEntities(s) {
    return s
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/&amp;/g, '&');
}

const CELL = ''; // מפריד תא בטבלה
const ROW = '';  // סוף שורה בטבלה

// הפיכת ה-XML של וורד לשורות טקסט. שומרים סימון תאים/שורות כדי שנדע לזהות טבלאות שאלה|תשובה.
function xmlToLines(xml) {
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<\/w:p>|<\/w:tc>|<\/w:tr>/g;
    let out = '';
    let m;
    while ((m = re.exec(xml)) !== null) {
        const tag = m[0];
        if (m[1] !== undefined) out += decodeEntities(m[1]);
        else if (tag.startsWith('<w:tab')) out += ' ';
        else if (tag.startsWith('<w:br')) out += '\n';
        else if (tag === '</w:p>') out += '\n';
        else if (tag === '</w:tc>') out += CELL;
        else if (tag === '</w:tr>') out += ROW + '\n';
    }
    return out.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

const Q_PREFIX = /^(?:שאלה|ש)\s*[:.–—\-)]\s*/;
const A_PREFIX = /^(?:תשובה|ת)\s*[:.–—\-)]\s*/;
const NUMBERING = /^(?:\d+|[א-ת])\s*[.)]\s*/;

const looksLikeQuestion = (line) => {
    const t = line.replace(NUMBERING, '').trim();
    if (Q_PREFIX.test(t)) return true;
    if (t.length > 300) return false;
    return t.endsWith('?') || t.endsWith('؟');
};

// חילוץ זוגות שאלה-תשובה. שלוש תבניות נתמכות, כי קבצים אמיתיים נראים אחרת בכל פעם:
// (1) טבלה של שתי עמודות, (2) "שאלה:" / "תשובה:" מפורש, (3) שורה שמסתיימת בסימן שאלה
// והשורות שאחריה הן התשובה, עד השאלה הבאה.
function extractPairs(lines) {
    const pairs = [];
    const plain = [];

    for (const line of lines) {
        if (line.includes(CELL)) {
            const cells = line.replace(new RegExp(ROW, 'g'), '').split(CELL).map((c) => c.trim()).filter(Boolean);
            if (cells.length >= 2 && cells[0].length <= 300) {
                const q = cells[0].replace(Q_PREFIX, '').replace(NUMBERING, '').trim();
                const a = cells.slice(1).join(' ').replace(A_PREFIX, '').trim();
                if (q && a) { pairs.push({ question: q, answer: a }); continue; }
            }
            plain.push(cells.join(' '));
            continue;
        }
        plain.push(line);
    }

    // תקרה לאורך התשובה בתבנית "שורה שמסתיימת בסימן שאלה": בלי זה, שאלה אחת בראש מסמך
    // בולעת את כל הפסקאות שאחריה, והמערכת מחזירה אותן כ"תשובה" — מלל ארוך במקום מענה.
    const ANSWER_MAX_LINES = 8;
    const ANSWER_MAX_CHARS = 1200;
    let current = null;
    for (const line of plain) {
        const stripped = line.replace(NUMBERING, '').trim();
        if (looksLikeQuestion(line)) {
            if (current && current.answer.length) pairs.push({ question: current.question, answer: current.answer.join(' ') });
            current = { question: stripped.replace(Q_PREFIX, '').trim(), answer: [] };
        } else if (current && current.answer.length < ANSWER_MAX_LINES
            && current.answer.join(' ').length < ANSWER_MAX_CHARS) {
            current.answer.push(stripped.replace(A_PREFIX, '').trim());
        }
    }
    if (current && current.answer.length) pairs.push({ question: current.question, answer: current.answer.join(' ') });

    // מסננים זוגות ריקים/כפולים
    const seen = new Set();
    return pairs.filter((p) => {
        const key = p.question.trim();
        if (!key || !p.answer.trim() || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// הקלט: base64 של קובץ .docx. הפלט: הטקסט המלא + זוגות שאלה-תשובה שזוהו בו.
export function parseDocx(base64) {
    const buf = Buffer.from(String(base64 || ''), 'base64');
    if (!buf.length) throw new Error('הקובץ ריק');
    const xml = readZipEntry(buf, 'word/document.xml').toString('utf8');
    const lines = xmlToLines(xml);
    const text = lines.map((l) => l.split(CELL).join(' | ').replace(new RegExp(ROW, 'g'), '')).join('\n');
    return { text, pairs: extractPairs(lines) };
}
