import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import nodemailer from 'nodemailer';
import { db, audit, getSetting, setSetting, DB_PATH, TASK_IRRELEVANT } from './db.js';
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
  // שליחת מייל דרך Resend — חלופה ל-Gmail כשאין גישה להגדרות החשבון או לסיסמאות אפליקציה
  { key: 'resend_api_key', secret: true },
  { key: 'resend_from', secret: false },     // כתובת השולח (דומיין מאומת ב-Resend, או onboarding@resend.dev לבדיקה)
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
// שני ערוצי שליחה. Resend עובד עם מפתח API בלבד (בלי חשבון Gmail ובלי סיסמת אפליקציה),
// ולכן הוא מקבל עדיפות כשהוא מוגדר. Gmail נשאר כפי שהיה עבור מי שכבר מחוברת דרכו.
function mailer() {
  const user = getSetting('gmail_user');
  const pass = getSetting('gmail_app_password');
  if (!user || !pass) throw new Error('חסרים פרטי Gmail: כתובת + סיסמת אפליקציה (בלשונית חיבורים)');
  return nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
}

export function mailProvider() {
  if (getSetting('resend_api_key')) return 'resend';
  if (getSetting('gmail_user') && getSetting('gmail_app_password')) return 'gmail';
  return null;
}

export const mailReady = () => mailProvider() !== null;

// כתובת השולח: ב-Resend חייבת להיות על דומיין מאומת, או onboarding@resend.dev לבדיקות
export const mailFrom = () => (mailProvider() === 'resend'
  ? (getSetting('resend_from') || 'onboarding@resend.dev')
  : getSetting('gmail_user'));

async function sendViaResend({ to, subject, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getSetting('resend_api_key')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: mailFrom(), to: [to], subject, html }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data?.message || data?.error?.message || `שגיאה ${res.status}`;
    const err = new Error(`resend:${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// נקודת השליחה היחידה במערכת — כל מי ששולח מייל עובר דרך כאן
export async function deliverMail({ to, subject, html }) {
  if (!to) throw new Error('לא צוינה כתובת מייל ליעד');
  const body = `<div dir="rtl" style="font-family:Arial,sans-serif;line-height:1.7">${html}</div>`;
  if (mailProvider() === 'resend') return sendViaResend({ to, subject, html: body });
  await mailer().sendMail({ from: getSetting('gmail_user'), to, subject, html: body });
  return { to };
}

// תקציר יומי — סטטיסטיקות מכל אזור במערכת.
// כל אזור נאסף בנפרד ובתוך try משלו, כדי שטבלה חסרה או מודול כבוי לא יפילו את הדוח כולו.
export function buildDailySummary() {
  const today = isoDate(new Date());
  const one = (sql, ...args) => { try { return db.prepare(sql).get(...args); } catch { return null; } };
  const many = (sql, ...args) => { try { return db.prepare(sql).all(...args); } catch { return []; } };
  const num = (row, key = 'c') => (row && row[key] != null ? row[key] : 0);

  // ---- משימות ----
  const t = one(`SELECT COUNT(*) AS total, SUM(status='done') AS done, SUM(status=?) AS irrelevant,
                        SUM(status='open') AS open FROM task_instances WHERE due_date = ?`, TASK_IRRELEVANT, today) || {};
  const tasks = {
    total: num(t, 'total'), done: num(t, 'done'), irrelevant: num(t, 'irrelevant'), open: num(t, 'open'),
    late: num(one(`SELECT COUNT(*) c FROM task_instances WHERE status='open' AND due_date < ?`, today)),
    week: num(one(`SELECT COUNT(*) c FROM task_instances WHERE status='open' AND due_date > ? AND due_date <= date(?, '+7 day')`, today, today)),
    doneBy: many(`SELECT done_by AS name, COUNT(*) c FROM task_instances
                  WHERE status='done' AND date(done_at) = ? AND done_by IS NOT NULL
                  GROUP BY done_by ORDER BY c DESC`, today),
  };
  tasks.percent = tasks.total ? Math.round((tasks.done / tasks.total) * 100) : null;

  // ---- לוח בעיות ----
  const problems = {
    open: num(one(`SELECT COUNT(*) c FROM problems WHERE status != 'נבדק'`)),
    newToday: num(one(`SELECT COUNT(*) c FROM problems WHERE date(created_at) = ?`, today)),
    overdue: num(one(`SELECT COUNT(*) c FROM problems WHERE status != 'נבדק' AND due_date IS NOT NULL AND due_date < ?`, today)),
  };

  // ---- העברת משמרת והודעות ----
  const handover = {
    today: num(one(`SELECT COUNT(*) c FROM handovers WHERE date(created_at) = ?`, today)),
    unacked: num(one(`SELECT COUNT(*) c FROM handovers h WHERE h.acked_at IS NULL
                      AND NOT EXISTS (SELECT 1 FROM handover_acks a WHERE a.handover_id = h.id)`)),
  };
  const messages = {
    today: num(one(`SELECT COUNT(*) c FROM messages WHERE date(created_at) = ? AND status='sent'`, today)),
    unhandled: num(one(`SELECT COUNT(*) c FROM messages WHERE handled_at IS NULL AND status='sent'`)),
    drafts: num(one(`SELECT COUNT(*) c FROM messages WHERE status='draft'`)),
  };

  // ---- נוכחות ----
  const attendance = {
    rows: many(`SELECT u.name, a.check_in, a.check_out FROM attendance a JOIN users u ON u.id = a.user_id
                WHERE date(a.check_in) = ? ORDER BY a.check_in`, today),
    openShifts: num(one(`SELECT COUNT(*) c FROM attendance WHERE check_out IS NULL`)),
  };
  attendance.hours = attendance.rows.reduce((sum, r) => {
    if (!r.check_out) return sum;
    return sum + Math.max(0, (new Date(r.check_out.replace(' ', 'T')) - new Date(r.check_in.replace(' ', 'T'))) / 3600000);
  }, 0);

  // ---- מלאי והשכרה (רק אם המודול פעיל) ----
  let inventory = null;
  if (getSetting('inventory_module') === '1') {
    inventory = {
      pickupsToday: num(one(`SELECT COUNT(*) c FROM orders WHERE pickup_date = ? AND status IN ('שריון','נמסרה')`, today)),
      returnsToday: num(one(`SELECT COUNT(*) c FROM orders WHERE return_date = ? AND status = 'נמסרה'`, today)),
      activeOrders: num(one(`SELECT COUNT(*) c FROM orders WHERE status IN ('שריון','נמסרה')`)),
      lateReturns: num(one(`SELECT COUNT(*) c FROM orders WHERE status='נמסרה' AND return_date < ? AND delivery_back = 0`, today)),
      newOrders: num(one(`SELECT COUNT(*) c FROM orders WHERE date(created_at) = ?`, today)),
      itemsActive: num(one(`SELECT COUNT(*) c FROM items WHERE active = 1`)),
    };
  }

  // ---- קמפיין: נקודות ומוקדים ----
  let campaign = null;
  try {
    campaign = {
      newVolunteers: many(`SELECT phone, name FROM campaign_volunteers WHERE date(created_at) = ?`, today),
      pointsToday: num(one(`SELECT COALESCE(SUM(points), 0) c FROM campaign_point_transactions
                            WHERE status='approved' AND points > 0 AND date(created_at) = ?`, today)),
      pendingApprovals: num(one(`SELECT COUNT(*) c FROM campaign_point_transactions WHERE status='pending'`)),
      redemptionsToday: num(one(`SELECT COUNT(*) c FROM campaign_point_transactions WHERE type='redeem' AND date(created_at) = ?`, today)),
      volunteersTotal: num(one(`SELECT COUNT(*) c FROM campaign_volunteers`)),
      lowHubs: many(`SELECT name, kits_available, kits_total FROM campaign_hubs
                     WHERE kits_total > 0 AND (kits_available * 1.0 / kits_total) <= 0.2`),
    };
  } catch { /* טבלאות הקמפיין עוד לא קיימות */ }

  // ---- לשונית מכירה סינית: עסקים, שלבי סגירה, שאלות ו-AI ----
  let sinit = null;
  try {
    const stagesTotal = num(one(`SELECT COUNT(*) c FROM campaign_close_stages`));
    sinit = {
      businesses: num(one(`SELECT COUNT(*) c FROM campaign_businesses`)),
      newToday: num(one(`SELECT COUNT(*) c FROM campaign_businesses WHERE date(created_at) = ?`, today)),
      donated: num(one(`SELECT COUNT(*) c FROM campaign_businesses WHERE status='תרם'`)),
      refused: num(one(`SELECT COUNT(*) c FROM campaign_businesses WHERE status='סירב'`)),
      waiting: num(one(`SELECT COUNT(*) c FROM campaign_businesses WHERE status='ממתין'`)),
      notesToday: num(one(`SELECT COUNT(*) c FROM campaign_business_notes WHERE date(created_at) = ?`, today)),
      stagesMarkedToday: num(one(`SELECT COUNT(*) c FROM campaign_business_stages WHERE done=1 AND date(done_at) = ?`, today)),
      fullyClosed: stagesTotal ? num(one(`SELECT COUNT(*) c FROM (
          SELECT business_id FROM campaign_business_stages WHERE done=1
          GROUP BY business_id HAVING COUNT(*) >= ?)`, stagesTotal)) : 0,
      stagesTotal,
      questionsOpen: num(one(`SELECT COUNT(*) c FROM campaign_questions WHERE status NOT IN ('נענתה','נסגרה')`)),
      questionsToday: num(one(`SELECT COUNT(*) c FROM campaign_questions WHERE date(created_at) = ?`, today)),
      answeredToday: num(one(`SELECT COUNT(*) c FROM campaign_questions WHERE date(answered_at) = ?`, today)),
      aiToday: num(one(`SELECT COUNT(*) c FROM campaign_ai_log WHERE date(created_at) = ?`, today)),
      aiNoAnswerToday: num(one(`SELECT COUNT(*) c FROM campaign_ai_log WHERE outcome='אין מענה' AND date(created_at) = ?`, today)),
      kbDocs: num(one(`SELECT COUNT(*) c FROM campaign_kb_docs`)),
      kbPairs: num(one(`SELECT COUNT(*) c FROM campaign_kb_pairs`)),
      shareLinks: num(one(`SELECT COUNT(*) c FROM campaign_share_links WHERE active=1`)),
      sources: num(one(`SELECT COUNT(*) c FROM campaign_sync_sources WHERE active=1`)),
    };
  } catch { /* טבלאות הלשונית עוד לא קיימות */ }

  // ---- פעילות כללית במערכת ----
  const activity = {
    actions: num(one(`SELECT COUNT(*) c FROM audit_log WHERE date(at) = ?`, today)),
    users: num(one(`SELECT COUNT(DISTINCT user_name) c FROM audit_log WHERE date(at) = ? AND user_name IS NOT NULL`, today)),
  };

  return { today, tasks, problems, handover, messages, attendance, inventory, campaign, sinit, activity };
}

// ---- בניית גוף המייל ----
const ALERT = '#c1362f';
const fmtHours = (h) => (h >= 0.1 ? `${h.toFixed(1)} שעות` : '—');

function reportSections(s) {
  const sections = [];

  sections.push({
    title: '📋 משימות',
    rows: [
      ['משימות היום', s.tasks.total ? `${s.tasks.done} מתוך ${s.tasks.total} בוצעו (${s.tasks.percent}%)` : 'אין משימות להיום'],
      ['עדיין פתוחות להיום', s.tasks.open, s.tasks.open > 0],
      ['בפיגור מימים קודמים', s.tasks.late, s.tasks.late > 0],
      ['סומנו "לא רלוונטי"', s.tasks.irrelevant],
      ['פתוחות לשבוע הקרוב', s.tasks.week],
      ['מי ביצעה היום', s.tasks.doneBy.length
        ? s.tasks.doneBy.map((r) => `${r.name} (${r.c})`).join(', ') : '—'],
    ],
  });

  sections.push({
    title: '⚠️ לוח בעיות',
    rows: [
      ['בעיות פתוחות', s.problems.open, s.problems.open > 0],
      ['נפתחו היום', s.problems.newToday],
      ['עברו את תאריך היעד', s.problems.overdue, s.problems.overdue > 0],
    ],
  });

  sections.push({
    title: '🔄 משמרת והודעות',
    rows: [
      ['העברות משמרת היום', s.handover.today],
      ['העברות שאיש לא אישר', s.handover.unacked, s.handover.unacked > 0],
      ['הודעות שנשלחו היום', s.messages.today],
      ['הודעות שלא טופלו', s.messages.unhandled, s.messages.unhandled > 0],
      ['טיוטות שלא נשלחו', s.messages.drafts],
    ],
  });

  sections.push({
    title: '🕐 שעות נוכחות',
    rows: [
      ['נכנסו היום', s.attendance.rows.length
        ? s.attendance.rows.map((r) => r.name).join(', ') : '—'],
      ['סך שעות שנרשמו היום', fmtHours(s.attendance.hours)],
      ['משמרות שלא נסגרו', s.attendance.openShifts, s.attendance.openShifts > 0],
    ],
  });

  if (s.inventory) {
    sections.push({
      title: '👗 מלאי והשכרה',
      rows: [
        ['מסירות להיום', s.inventory.pickupsToday],
        ['החזרות להיום', s.inventory.returnsToday],
        ['הזמנות פעילות', s.inventory.activeOrders],
        ['הזמנות חדשות היום', s.inventory.newOrders],
        ['מאחרות בהחזרה', s.inventory.lateReturns, s.inventory.lateReturns > 0],
        ['פריטים פעילים במלאי', s.inventory.itemsActive],
      ],
    });
  }

  if (s.campaign) {
    sections.push({
      title: '🎗 קמפיין — נקודות ומוקדים',
      rows: [
        ['מתנדבות רשומות', s.campaign.volunteersTotal],
        ['נרשמו היום', s.campaign.newVolunteers.length
          ? `${s.campaign.newVolunteers.length} — ${s.campaign.newVolunteers.map((v) => v.name || v.phone).join(', ')}`
          : '0'],
        ['נקודות שחולקו היום', s.campaign.pointsToday],
        ['דיווחים הממתינים לאישור', s.campaign.pendingApprovals, s.campaign.pendingApprovals > 0],
        ['מתנות שמומשו היום', s.campaign.redemptionsToday],
        ['מוקדים כמעט ריקים', s.campaign.lowHubs.length
          ? s.campaign.lowHubs.map((h) => `${h.name} (${h.kits_available}/${h.kits_total})`).join(', ') : '—',
        s.campaign.lowHubs.length > 0],
      ],
    });
  }

  if (s.sinit) {
    sections.push({
      title: '🧾 מכירה סינית — עסקים ושאלות',
      rows: [
        ['סך עסקים', s.sinit.businesses],
        ['נוספו היום', s.sinit.newToday],
        ['תרמו / ממתינים / סירבו', `${s.sinit.donated} / ${s.sinit.waiting} / ${s.sinit.refused}`],
        ['סגורים לגמרי', s.sinit.stagesTotal ? `${s.sinit.fullyClosed} (מתוך ${s.sinit.businesses})` : '—'],
        ['שלבי סגירה שסומנו היום', s.sinit.stagesMarkedToday],
        ['תגובות שנרשמו היום', s.sinit.notesToday],
        ['שאלות פתוחות למנהלת', s.sinit.questionsOpen, s.sinit.questionsOpen > 0],
        ['שאלות חדשות היום / נענו היום', `${s.sinit.questionsToday} / ${s.sinit.answeredToday}`],
        ['שאלות ל-AI היום (מתוכן בלי מענה)', `${s.sinit.aiToday} (${s.sinit.aiNoAnswerToday})`, s.sinit.aiNoAnswerToday > 0],
        ['בסיס הידע', `${s.sinit.kbDocs} קבצים · ${s.sinit.kbPairs} שאלות`],
        ['קישורי מתנדבות פעילים', s.sinit.shareLinks],
        ['מקורות סנכרון פעילים', s.sinit.sources],
      ],
    });
  }

  sections.push({
    title: '📈 פעילות במערכת',
    rows: [
      ['פעולות שנרשמו היום', s.activity.actions],
      ['משתמשות פעילות היום', s.activity.users],
    ],
  });

  return sections;
}

function reportHtml(s) {
  const sections = reportSections(s);
  const body = sections.map((sec) => `
    <h3 style="margin:22px 0 6px;font-size:15px;color:#14497c;border-bottom:2px solid #e3e8f0;padding-bottom:4px">${sec.title}</h3>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      ${sec.rows.map(([label, value, alert]) => `
        <tr>
          <td style="padding:5px 0;color:#5a6b85;width:55%">${label}</td>
          <td style="padding:5px 0;font-weight:600;${alert ? `color:${ALERT}` : ''}">${value}${alert ? ' ⚠️' : ''}</td>
        </tr>`).join('')}
    </table>`).join('');

  const headline = s.tasks.total
    ? `${s.tasks.done}/${s.tasks.total} משימות בוצעו היום (${s.tasks.percent}%)`
    : 'אין משימות שהוגדרו להיום';

  return `
    <div style="max-width:640px">
      <h2 style="margin:0 0 4px;color:#14497c">דוח יומי — אמא במשמרת</h2>
      <div style="color:#6b7a90;font-size:13px;margin-bottom:10px">${s.today} · ${headline}</div>
      ${body}
      <p style="color:#8795a8;font-size:12px;margin-top:26px;border-top:1px solid #e3e8f0;padding-top:10px">
        נשלח אוטומטית ממערכת אמא במשמרת. לשינוי השעה או כיבוי הדוח: ניהול ← חיבורים ← דוח יומי.
      </p>
    </div>`;
}

export async function sendDailyReport(toOverride) {
  const to = toOverride || getSetting('report_email');
  if (!to) throw new Error('לא הוגדרה כתובת מייל לדוחות');
  const s = buildDailySummary();
  await deliverMail({ to, subject: `דוח יומי אמא במשמרת – ${s.today}`, html: reportHtml(s) });
  return { to };
}

// תצוגה מקדימה של הדוח בלי לשלוח אותו — למסך ההגדרות
export function previewDailyReport() {
  return reportHtml(buildDailySummary());
}

// התרעה דחופה — לדוגמה תגובה על משימה שסומנה "דחוף" — נשלחת ישירות לכתובת המייל שהוגדרה לדוחות
export async function sendUrgentAlert(subject, text) {
  const to = getSetting('report_email');
  if (!to) return; // אין כתובת מוגדרת — לא קריטי, הפנייה עדיין מופיעה באתר
  await deliverMail({ to, subject: `דחוף — ${subject}`, html: text });
}

// שליחת מייל לכתובת מסוימת — משמש את לשונית "מכירה סינית" לשאלות שנשלחות למנהלת המערכת
export async function sendMailTo({ to, subject, html }) {
  return deliverMail({ to, subject, html });
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
    // הטעות הנפוצה ב-Resend: הכנסת כתובת ג'ימייל פרטית כשולח. Resend דורש דומיין בבעלותך,
    // ולכן זה נדחה אצלו עם 403 רק בזמן השליחה — עדיף לעצור כאן ולהסביר.
    const freeMail = /@(gmail|googlemail|walla|hotmail|outlook|live|yahoo|icloud|aol)\./i;
    if (b.resend_from !== undefined && b.resend_from !== '' && freeMail.test(String(b.resend_from))) {
      return res.status(400).json({
        error: 'אי אפשר לשלוח דרך Resend מכתובת ג\'ימייל/וואלה/הוטמייל — Resend מאפשר לשלוח רק מדומיין שבבעלותך. '
          + 'יש להשאיר את שדה "כתובת השולח" ריק (אז נשלח מ-onboarding@resend.dev), או לאמת דומיין משלך ב-resend.com/domains.',
      });
    }
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
      await deliverMail({
        to: req.body?.to || mailFrom(),
        subject: 'בדיקת חיבור – מערכת אמא במשמרת',
        html: `✅ החיבור למייל עובד! נשלח דרך ${mailProvider() === 'resend' ? 'Resend' : 'Gmail'}.`,
      });
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  r.post('/email/daily-report', mustLogin, async (req, res) => {
    try { res.json({ ok: true, ...(await sendDailyReport(req.body?.to)) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  // תצוגה מקדימה של הדוח בדפדפן — לראות בדיוק מה יישלח, בלי לשלוח ובלי להמתין לשעה שנקבעה
  r.get('/email/daily-report/preview', mustLogin, requireFeature('integrations'), (req, res) => {
    res.type('html').send(`<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
      <title>תצוגה מקדימה — דוח יומי</title></head>
      <body style="font-family:Arial,sans-serif;background:#f6f8fb;padding:24px">
        <div style="background:#fff;border-radius:14px;padding:24px;max-width:700px;margin:0 auto;box-shadow:0 4px 16px rgba(11,42,74,.08)">
          ${previewDailyReport()}
        </div>
      </body></html>`);
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
