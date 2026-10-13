import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import nodemailer from 'nodemailer';
import { db, audit, getSetting, setSetting, DB_PATH } from './db.js';
import { vEmail, vAmount, firstError } from './validate.js';
import { isoDate } from './hebrew.js';

// מפתחות ההגדרות; secret=true מוסתר בתשובת ה-GET
const SETTING_KEYS = [
  { key: 'gmail_user', secret: false },
  { key: 'gmail_app_password', secret: true },
  { key: 'report_email', secret: false },       // למי נשלח הדוח (למשל יוטי)
  { key: 'daily_report_auto', secret: false },  // '1' = שליחת דוח יומי אוטומטית
  { key: 'daily_report_hour', secret: false },  // שעה לשליחה (0-23), ברירת מחדל 20
  { key: 'anthropic_api_key', secret: true },
  { key: 'backup_dir', secret: false },
  { key: 'backup_auto', secret: false },        // '1' = גיבוי יומי אוטומטי
  { key: 'update_source', secret: false },      // תיקייה או URL לעדכוני גרסה
  { key: 'delivery_price', secret: false },     // מחיר משלוח לכיוון אחד
  { key: 'delivery_price_back', secret: false },// מחיר משלוח חזור (ריק = כמו הלוך)
  { key: 'manual_model_order', secret: false }, // '1' = מותר להזמין לפי דגם בלי ברקוד, '' = חסום
  { key: 'inventory_module', secret: false },   // '1' = מודול מלאי והשכרה פעיל, '0' = כבוי לגמרי
];
const MASK = '••••••••';

// ---------- מייל ----------
function mailer() {
  const user = getSetting('gmail_user');
  const pass = getSetting('gmail_app_password');
  if (!user || !pass) throw new Error('חסרים פרטי Gmail: כתובת + סיסמת אפליקציה (בלשונית חיבורים)');
  return nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
}

// תקציר יומי: ביצוע משימות + פעילות קמפיין המכירה הסינית (מתנדבות חדשות, נקודות, אישורים ממתינים, מלאי מוקדים)
export function buildDailySummary() {
  const today = isoDate(new Date());
  const tasks = db.prepare(`
    SELECT COUNT(*) AS total, SUM(status='done') AS done FROM task_instances WHERE due_date = ?`).get(today);
  const openProblems = db.prepare(`SELECT COUNT(*) c FROM problems WHERE status != 'נבדק'`).get().c;

  let campaign = null;
  try {
    const newVolunteers = db.prepare(`SELECT phone, name FROM campaign_volunteers WHERE date(created_at) = ?`).all(today);
    const pointsToday = db.prepare(`
      SELECT COALESCE(SUM(points), 0) c FROM campaign_point_transactions
      WHERE status = 'approved' AND points > 0 AND date(created_at) = ?`).get(today).c;
    const pendingApprovals = db.prepare(`SELECT COUNT(*) c FROM campaign_point_transactions WHERE status = 'pending'`).get().c;
    const lowHubs = db.prepare(`
      SELECT name, kits_available, kits_total FROM campaign_hubs
      WHERE kits_total > 0 AND (kits_available * 1.0 / kits_total) <= 0.2`).all();
    const redemptionsToday = db.prepare(`
      SELECT COUNT(*) c FROM campaign_point_transactions WHERE type = 'redeem' AND date(created_at) = ?`).get(today).c;
    campaign = { newVolunteers, pointsToday, pendingApprovals, lowHubs, redemptionsToday };
  } catch { /* טבלאות הקמפיין עוד לא קיימות — דוח ישן בלי הקטע הזה */ }

  return { today, tasks, openProblems, campaign };
}

export async function sendDailyReport(toOverride) {
  const to = toOverride || getSetting('report_email');
  if (!to) throw new Error('לא הוגדרה כתובת מייל לדוחות');
  const s = buildDailySummary();
  const c = s.campaign;
  const campaignHtml = c ? `
    <h3>קמפיין המכירה הסינית</h3>
    <ul>
      <li><b>מתנדבות חדשות שנרשמו היום:</b> ${c.newVolunteers.length}${c.newVolunteers.length ? ' — ' + c.newVolunteers.map((v) => v.name || v.phone).join(', ') : ''}</li>
      <li><b>נקודות שחולקו היום:</b> ${c.pointsToday}</li>
      <li><b>דיווחי גיוס מוצר הממתינים לאישור:</b> ${c.pendingApprovals}</li>
      <li><b>מתנות שמומשו היום:</b> ${c.redemptionsToday}</li>
      ${c.lowHubs.length ? `<li style="color:#a73950"><b>⚠️ מוקדים כמעט ריקים:</b> ${c.lowHubs.map((h) => `${h.name} (${h.kits_available}/${h.kits_total})`).join(', ')}</li>` : ''}
    </ul>` : '';
  const html = `
    <div dir="rtl" style="font-family:Arial,sans-serif">
      <h2>דוח יומי – אמא במשמרת (${s.today})</h2>
      <ul>
        <li><b>משימות היום:</b> ${s.tasks.done || 0} מתוך ${s.tasks.total || 0} בוצעו</li>
        <li><b>בעיות פתוחות בלוח:</b> ${s.openProblems}</li>
      </ul>
      ${campaignHtml}
      <p style="color:#888">נשלח אוטומטית ממערכת אמא במשמרת</p>
    </div>`;
  await mailer().sendMail({
    from: getSetting('gmail_user'), to,
    subject: `דוח יומי אמא במשמרת – ${s.today}`, html,
  });
  return { to };
}

// התרעה דחופה — לדוגמה תגובה על משימה שסומנה "דחוף" — נשלחת ישירות לכתובת המייל שהוגדרה לדוחות
export async function sendUrgentAlert(subject, text) {
  const to = getSetting('report_email');
  if (!to) return; // אין כתובת מוגדרת — לא קריטי, הפנייה עדיין מופיעה באתר
  await mailer().sendMail({
    from: getSetting('gmail_user'), to,
    subject: `דחוף — ${subject}`,
    html: `<div dir="rtl" style="font-family:Arial,sans-serif">${text}</div>`,
  });
}

// שליחה אוטומטית פעם ביום בשעה שהוגדרה (ברירת מחדל 20:00) — רץ כל עוד השרת פעיל (מתאים לפריסה בענן 24/7)
let dailyReportTimer = null;
let lastSentDate = null;
export function scheduleDailyReport() {
  if (dailyReportTimer) clearInterval(dailyReportTimer);
  dailyReportTimer = setInterval(() => {
    if (getSetting('daily_report_auto') !== '1' || !getSetting('report_email')) return;
    const hour = parseInt(getSetting('daily_report_hour') || '20', 10);
    const now = new Date();
    const today = isoDate(now);
    if (now.getHours() === hour && lastSentDate !== today) {
      lastSentDate = today;
      sendDailyReport().catch((e) => console.error('דוח יומי אוטומטי נכשל:', e.message));
    }
  }, 10 * 60 * 1000); // בדיקה כל 10 דקות
}

// ---------- עוזרת AI ----------
const AI_SYSTEM = `את עוזרת חכמה של מערכת ניהול גמ"ח שמלות (השכרת שמלות לאירועים, ארגון חסד).
המשתמשות הן צוות הגמ"ח. עני בעברית, קצר וברור, בגובה העיניים.
תקבלי בכל שיחה תמונת מצב עדכנית של המערכת (משימות, הזמנות, קופה, חריגים) — הסתמכי עליה בלבד כשעונים על שאלות נתונים.
אם שואלים משהו שאין לו תשובה בנתונים, אמרי זאת בפשטות. אל תמציאי מספרים.`;

function aiSnapshot() {
  const today = isoDate(new Date());
  const s = buildDailySummary();
  const openTasks = db.prepare(`
    SELECT COALESCE(i.title, t.title) AS title, COALESCE(i.category, t.category) AS category, i.priority, i.due_date
    FROM task_instances i LEFT JOIN task_templates t ON t.id = i.template_id
    WHERE i.status = 'open' AND i.due_date <= ? ORDER BY i.due_date LIMIT 40`).all(today);
  const problems = db.prepare(`SELECT title, status, due_date FROM problems WHERE status != 'נבדק' LIMIT 20`).all();
  const lateOrders = db.prepare(`
    SELECT o.id, c.name, c.phone, o.return_date FROM orders o JOIN customers c ON c.id = o.customer_id
    WHERE o.status = 'נמסרה' AND o.return_date < ? AND o.delivery_back = 0 LIMIT 20`).all(today);
  const todayOrders = db.prepare(`
    SELECT o.id, c.name, o.pickup_date, o.return_date, o.status FROM orders o JOIN customers c ON c.id = o.customer_id
    WHERE (o.pickup_date = ? OR o.return_date = ?) AND o.status IN ('שריון','נמסרה')`).all(today, today);
  return JSON.stringify({ תאריך: today, סיכום: s, משימות_פתוחות_להיום: openTasks, בעיות_פתוחות: problems, מאחרות_להחזרה: lateOrders, הזמנות_להיום: todayOrders });
}

export async function aiChat(question, history = []) {
  const apiKey = getSetting('anthropic_api_key');
  if (!apiKey) throw new Error('לא הוגדר מפתח API של Anthropic (בלשונית חיבורים)');
  const client = new Anthropic({ apiKey });
  const messages = [
    ...history.slice(-10).filter((m) => ['user', 'assistant'].includes(m.role) && m.content),
    { role: 'user', content: `<תמונת_מצב>\n${aiSnapshot()}\n</תמונת_מצב>\n\n${question}` },
  ];
  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 2048,
    system: AI_SYSTEM,
    messages,
  });
  if (response.stop_reason === 'refusal') throw new Error('הבקשה נדחתה על ידי מערכת הבטיחות של המודל');
  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

// ---------- גיבוי לענן/דרייב ----------
// הגיבוי נכתב לתיקייה שמסונכרנת לענן (Google Drive / OneDrive שולחניים) — כך הקובץ עולה אוטומטית.
export async function backupNow() {
  const dir = getSetting('backup_dir');
  if (!dir) throw new Error('לא הוגדרה תיקיית גיבוי (בלשונית חיבורים)');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const dest = path.join(dir, `gemach-backup-${stamp}.db`);
  await db.backup(dest);
  // שומרים עד 30 גיבויים אחרונים
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('gemach-backup-')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - 30))) fs.unlinkSync(path.join(dir, f));
  audit('system', 'backup.create', 'backup', dest);
  return { file: dest };
}

export function backupStatus() {
  const dir = getSetting('backup_dir');
  if (!dir || !fs.existsSync(dir)) return { dir: dir || null, files: [] };
  const files = fs.readdirSync(dir)
    .filter((f) => f.startsWith('gemach-backup-'))
    .sort().reverse().slice(0, 5)
    .map((f) => ({ name: f, size: fs.statSync(path.join(dir, f)).size }));
  return { dir, files };
}

let backupTimer = null;
export function scheduleAutoBackup() {
  if (backupTimer) clearInterval(backupTimer);
  if (getSetting('backup_auto') !== '1' || !getSetting('backup_dir')) return;
  backupTimer = setInterval(() => backupNow().catch((e) => console.error('גיבוי אוטומטי נכשל:', e.message)), 24 * 60 * 60 * 1000);
}

// ---------- Router ----------
export function integrationsRouter({ mustLogin, mustManager, requireFeature }) {
  const r = Router();

  r.get('/settings', mustLogin, requireFeature('integrations'), (req, res) => {
    const out = {};
    for (const { key, secret } of SETTING_KEYS) {
      const v = getSetting(key);
      out[key] = secret && v ? MASK : v;
    }
    res.json(out);
  });

  r.put('/settings', mustLogin, requireFeature('integrations'), (req, res) => {
    // ולידציה על שדות ההגדרות
    const b = req.body || {};
    const sErr = firstError(
      b.gmail_user !== undefined && b.gmail_user !== '' ? vEmail(b.gmail_user) : null,
      b.report_email !== undefined && b.report_email !== '' ? vEmail(b.report_email) : null,
      b.delivery_price !== undefined && b.delivery_price !== ''
        ? vAmount(b.delivery_price, 'מחיר משלוח הלוך', { min: 0, max: 5000, allowZero: true }) : null,
      b.delivery_price_back !== undefined && b.delivery_price_back !== ''
        ? vAmount(b.delivery_price_back, 'מחיר משלוח חזור', { min: 0, max: 5000, allowZero: true }) : null,
    );
    if (sErr) return res.status(400).json({ error: sErr });
    for (const { key } of SETTING_KEYS) {
      const v = req.body?.[key];
      if (v === undefined || v === MASK) continue; // ערך מוסתר שלא שונה — לא דורסים
      setSetting(key, String(v));
    }
    scheduleAutoBackup();
    scheduleDailyReport();
    // מקור העדכונים נכתב גם לקובץ — האפליקציה (Electron) קוראת אותו בהפעלה, לפני שהשרת עולה
    try {
      fs.writeFileSync(path.join(path.dirname(DB_PATH), 'update-source.txt'), getSetting('update_source').trim());
    } catch (e) { console.error('כתיבת update-source נכשלה:', e.message); }
    audit(req.user.name, 'settings.update', 'settings', 'integrations');
    res.json({ ok: true });
  });

  r.post('/email/test', mustLogin, requireFeature('integrations'), async (req, res) => {
    try {
      await mailer().sendMail({
        from: getSetting('gmail_user'),
        to: req.body?.to || getSetting('gmail_user'),
        subject: 'בדיקת חיבור – מערכת הגמ"ח',
        html: '<div dir="rtl">✅ החיבור למייל עובד! נשלח ממערכת ניהול הגמ"ח.</div>',
      });
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  r.post('/email/daily-report', mustLogin, async (req, res) => {
    try { res.json({ ok: true, ...(await sendDailyReport(req.body?.to)) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  r.post('/ai/chat', mustLogin, requireFeature('ai'), async (req, res) => {
    const { question, history } = req.body || {};
    if (!question?.trim()) return res.status(400).json({ error: 'אין שאלה' });
    try { res.json({ answer: await aiChat(question.trim(), history || []) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  r.post('/backup/now', mustLogin, requireFeature('integrations'), async (req, res) => {
    try { res.json({ ok: true, ...(await backupNow()) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  r.get('/backup/status', mustLogin, requireFeature('integrations'), (req, res) => res.json(backupStatus()));

  return r;
}
