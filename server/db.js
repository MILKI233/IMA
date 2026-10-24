import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- דרגת העל ----------
// שם התפקיד הגיע מתמלול קולי ועשוי להשתנות — לכן כל ההיררכיה נגזרת מהקבוע היחיד הזה.
// דרגת העל — שם המנהלת הבכירה. שינוי המילה כאן משנה אותה בכל המערכת.
export const TOP_ROLE = 'יוטי';
// שמות קודמים של אותה דרגה — לצורך מיגרציה של התקנות ותיקות
export const TOP_ROLE_LEGACY = ['העובי', 'מנהלת ראשית', 'אהובי'];
// קוד כניסת חירום לדרגת העל — כדי שאובדן קוד אחד לא ינעל את המערכת
export const BACKUP_TOP_CODE = '9119';
export const BACKUP_TOP_NAME = 'כניסת גיבוי (יוטי)';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// בהתקנה אצל לקוח (Electron) הנתונים יושבים בתיקיית המשתמש — לא בתיקיית התוכנה
const dataDir = process.env.GEMACH_DATA_DIR || path.join(__dirname, '..');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
export const DB_PATH = path.join(dataDir, 'ama-tasks.db');
export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'מוקדנית',   -- יוטי / מנהלת / מוקדנית / מתנדבת
  code TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  check_in TEXT NOT NULL,
  check_out TEXT
);
CREATE TABLE IF NOT EXISTS task_templates (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  frequency TEXT NOT NULL,   -- daily / weekly / biweekly / monthly / quarterly
  role TEXT NOT NULL DEFAULT 'מנהלת',
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS task_instances (
  id INTEGER PRIMARY KEY,
  template_id INTEGER REFERENCES task_templates(id),
  title TEXT,                -- למשימות חד-פעמיות/אוטומטיות (ללא תבנית)
  category TEXT,
  period_key TEXT NOT NULL,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  done_by TEXT, done_at TEXT, note TEXT,
  source TEXT NOT NULL DEFAULT 'template',  -- template / manual / inventory
  uniq_key TEXT UNIQUE,      -- מפתח אידמפוטנטיות למשימות אוטומטיות
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_inst_tpl_period ON task_instances(template_id, period_key) WHERE template_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS problems (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  details TEXT,
  source_type TEXT,          -- עובדת / מתנדבת / לקוחה / זוהה עצמאית
  cause TEXT,                -- הסקת מסקנות כתובה לגורם
  prevention TEXT,           -- מסקנות למניעה
  decision TEXT,             -- מה הוחלט
  due_date TEXT,             -- תאריך יעד לביצוע
  status TEXT NOT NULL DEFAULT 'פתוח',  -- פתוח / בטיפול / הוחלט / בוצע / נבדק
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS handovers (
  id INTEGER PRIMARY KEY,
  user_name TEXT NOT NULL,
  shift_date TEXT NOT NULL,
  notes TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  from_user TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  handled_by TEXT, handled_at TEXT,
  kind TEXT NOT NULL DEFAULT 'report',  -- report = דיווח עובדת למנהלת (הזרימה המקורית) / announcement = תגובת מנהלת או הודעה כללית, מוצגת כבאנר
  to_user TEXT,                          -- יעד הודעת announcement; NULL = לכולם
  reply_to INTEGER REFERENCES messages(id)
);
CREATE TABLE IF NOT EXISTS message_dismissals (
  message_id INTEGER NOT NULL REFERENCES messages(id),
  user_name TEXT NOT NULL,
  PRIMARY KEY (message_id, user_name)
);
-- התכתבות על משימה ספציפית מול המנהלת — שאלות/הבהרות, כולל אפשרות לסמן כדחוף (שולח מייל ישירות)
CREATE TABLE IF NOT EXISTS task_comments (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES task_instances(id),
  from_user TEXT NOT NULL,
  body TEXT NOT NULL,
  urgent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
-- קבצים מצורפים למשימה (תמונות, מסמכים) — שמורים כ-base64, כמו הלוגו של הקמפיין
CREATE TABLE IF NOT EXISTS task_attachments (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES task_instances(id),
  uploaded_by TEXT NOT NULL,
  filename TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
-- פגישות/תורים אישיים בלוח השנה — פרטיים לגמרי, כל אחת רואה רק את שלה
CREATE TABLE IF NOT EXISTS personal_events (
  id INTEGER PRIMARY KEY,
  user_name TEXT NOT NULL,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_name TEXT,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  before_state TEXT,
  after_state TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`);

// ---------- מודול מלאי והשכרה ----------
db.exec(`
CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,          -- קוד דגם
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'נשים',   -- נשים / ילדות
  season TEXT DEFAULT 'כל השנה',      -- קיץ / חורף / כל השנה
  price REAL NOT NULL DEFAULT 0,      -- תעריף השכרה רגיל
  premium INTEGER NOT NULL DEFAULT 0, -- דגם פרימיום?
  premium_price REAL DEFAULT 0,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  barcode TEXT NOT NULL UNIQUE,       -- ללא הגבלת אורך (דרישת אפיון)
  model_id INTEGER NOT NULL REFERENCES models(id),
  size TEXT,
  status TEXT NOT NULL DEFAULT 'זמין', -- זמין/מושכר/בכביסה/בתיקון/לא תקין/נגרע
  condition_note TEXT,
  repair_count INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  tz TEXT UNIQUE,                     -- מספר זהות
  phone TEXT,
  name TEXT NOT NULL,                 -- שם משפחה / שם מלא
  email TEXT,
  notes TEXT DEFAULT '',              -- כולל הערות אוטומטיות (החזרה פגומה/מאוחרת)
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,             -- מספר הזמנה
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  event_date TEXT NOT NULL,
  pickup_date TEXT NOT NULL,          -- תאריך איסוף/משלוח הלוך
  return_date TEXT NOT NULL,          -- תאריך החזרה/משלוח חזור
  status TEXT NOT NULL DEFAULT 'שריון', -- שריון/נמסרה/הוחזרה/בוטלה
  delivery_out INTEGER NOT NULL DEFAULT 0,
  delivery_back INTEGER NOT NULL DEFAULT 0,
  delivery_address TEXT,
  notes TEXT,
  workstation TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  cancelled_at TEXT
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  item_id INTEGER REFERENCES items(id),   -- השמלה הפיזית — משויכת רק במסירה
  model_id INTEGER REFERENCES models(id), -- השריון עצמו הוא דגם + מידה
  size TEXT,
  price REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'משוריין', -- משוריין/נמסר/הוחזר/הוחזר פגום/החזרה מאוחרת/בוטל
  returned_at TEXT
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id),
  customer_id INTEGER REFERENCES customers(id),
  type TEXT NOT NULL,                 -- תשלום / החזר / דמי ביטול
  method TEXT NOT NULL DEFAULT 'מזומן', -- מזומן / אשראי
  amount REAL NOT NULL,
  note TEXT,
  by_user TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now','localtime'))  -- תאריך הפעולה בפועל (נוהל קופה דינמי)
);
CREATE TABLE IF NOT EXISTS return_rounds (
  id INTEGER PRIMARY KEY,
  round_date TEXT NOT NULL,
  closed_by TEXT,
  closed_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  late_count INTEGER NOT NULL DEFAULT 0
);
-- מעקב טיפול במשפחות שלא החזירו: כובסת פותחת ביציאה, מוקדנית ממשיכה במשמרת הבאה
CREATE TABLE IF NOT EXISTS return_followups (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  customer_id INTEGER REFERENCES customers(id),
  status TEXT NOT NULL DEFAULT 'פתוח',   -- פתוח / בטיפול / נסגר
  called INTEGER NOT NULL DEFAULT 0,      -- האם התקשרו למשפחה
  outcome TEXT,                           -- מה קרה בשיחה
  next_action TEXT,                       -- המשך טיפול למשמרת הבאה
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_by TEXT,
  updated_at TEXT,
  UNIQUE(order_id)
);
-- ברקודים שהוקלדו ידנית (הסורק לא עבד) — עם אימות כפול וחתימה; דוח יומי למוקדנית
CREATE TABLE IF NOT EXISTS manual_barcodes (
  id INTEGER PRIMARY KEY,
  barcode TEXT NOT NULL,
  order_id INTEGER REFERENCES orders(id),
  context TEXT NOT NULL,                  -- שריון / מסירה / החזרה
  signature TEXT NOT NULL,                -- טקסט החתימה שאושר
  user_name TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`);

// הגדרות מערכת (חיבורים: מייל, AI, גיבוי, ימות המשיח)
db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);
export const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? '';
export function setSetting(key, value) {
  db.prepare(`INSERT INTO settings(key, value) VALUES (?,?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value ?? '');
}

// מודול המלאי וההשכרה — ניתן לכיבוי מלא ע"י המנהלת (לשונית "חיבורים").
// כרגע הוא מגיע כבוי כברירת מחדל, כדי להתמקד במערכת המשימות. הבחירה נשמרת.
if (!db.prepare(`SELECT 1 FROM settings WHERE key = 'inventory_module'`).get()) {
  setSetting('inventory_module', '0');
}
export const inventoryEnabled = () => getSetting('inventory_module') !== '0';

// מיגרציה: שריון לפי דגם+מידה — item_id הופך לאופציונלי, נוספים model_id/size
{
  const cols = db.prepare('PRAGMA table_info(order_items)').all();
  const itemCol = cols.find((c) => c.name === 'item_id');
  const hasModelCol = cols.some((c) => c.name === 'model_id');
  if (!hasModelCol || itemCol?.notnull === 1) {
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
      db.exec(`
        CREATE TABLE order_items_new (
          id INTEGER PRIMARY KEY,
          order_id INTEGER NOT NULL REFERENCES orders(id),
          item_id INTEGER REFERENCES items(id),
          model_id INTEGER REFERENCES models(id),
          size TEXT,
          price REAL NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'משוריין',
          returned_at TEXT
        );
        INSERT INTO order_items_new (id, order_id, item_id, price, status, returned_at)
          SELECT id, order_id, item_id, price, status, returned_at FROM order_items;
        DROP TABLE order_items;
        ALTER TABLE order_items_new RENAME TO order_items;
      `);
      // שורות ישנות: גוזרים דגם+מידה מהשמלה שהייתה משויכת
      db.exec(`
        UPDATE order_items SET
          model_id = (SELECT model_id FROM items WHERE items.id = order_items.item_id),
          size     = (SELECT size     FROM items WHERE items.id = order_items.item_id)
        WHERE item_id IS NOT NULL;
      `);
    })();
    db.pragma('foreign_keys = ON');
  }
}

// מיגרציות עדינות — עמודות שנוספו אחרי הגרסה הראשונה
for (const stmt of [
  `ALTER TABLE task_templates ADD COLUMN priority TEXT NOT NULL DEFAULT 'רגיל'`,
  `ALTER TABLE task_instances ADD COLUMN priority TEXT NOT NULL DEFAULT 'רגיל'`,
  `ALTER TABLE task_templates ADD COLUMN assignee TEXT`,   // משימה לעובדת ספציפית (למשל: רותי)
  `ALTER TABLE task_instances ADD COLUMN assignee TEXT`,
  `ALTER TABLE task_templates ADD COLUMN scope TEXT NOT NULL DEFAULT 'תחילת משמרת'`,  // שיוך: תחילת משמרת/סוף משמרת/מנהלת/מוקדנית בוקר
  `ALTER TABLE task_instances ADD COLUMN scope TEXT NOT NULL DEFAULT 'תחילת משמרת'`,
  // נעיצת משימה לראש הלוח — מה שחשוב היום נשאר מול העיניים
  `ALTER TABLE task_instances ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`,
  // ימים נוספים בחצי מחיר להזמנה מראש (לקיחה מוקדמת / החזרה מאוחרת / נסיעה לחו"ל)
  `ALTER TABLE orders ADD COLUMN extra_days_before INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE orders ADD COLUMN extra_days_after INTEGER NOT NULL DEFAULT 0`,
  // העברות משמרת: קהל יעד ואישור קריאה
  `ALTER TABLE handovers ADD COLUMN audience TEXT NOT NULL DEFAULT 'next'`,  // next = המשמרת הבאה / all = כל המשמרות
  `ALTER TABLE handovers ADD COLUMN acked_by TEXT`,
  `ALTER TABLE handovers ADD COLUMN acked_at TEXT`,
  // תיאור קצר למשימה חד־פעמית (למשל כשמשבצים משימה מלוח השנה ליום מסוים)
  `ALTER TABLE task_instances ADD COLUMN description TEXT`,
  // הודעות: תגובת מנהלת / הכרזה כללית שמוצגת כבאנר בראש האתר
  `ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'report'`,
  `ALTER TABLE messages ADD COLUMN to_user TEXT`,
  `ALTER TABLE messages ADD COLUMN reply_to INTEGER REFERENCES messages(id)`,
  // טיוטה: נשמרת אך לא נשלחת עדיין — לא מופיעה בתיבה הנכנסת/באנר של אף אחת חוץ מהכותבת
  `ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'sent'`,
  // כתובת מייל לעסק
  `ALTER TABLE campaign_businesses ADD COLUMN email TEXT`,
  // מספר פנייה (כמה פעמים פנו) ומספר הודעה (איזו הודעה מוכנה נשלחה) — גם לעסק עצמו וגם לכל תגובה בהיסטוריה
  `ALTER TABLE campaign_businesses ADD COLUMN contact_number TEXT`,
  `ALTER TABLE campaign_businesses ADD COLUMN message_number TEXT`,
  `ALTER TABLE campaign_business_notes ADD COLUMN contact_number TEXT`,
  `ALTER TABLE campaign_business_notes ADD COLUMN message_number TEXT`,
  // לשונית "מכירה סינית": הדגשה וצביעה של עסק, ומאיזה מקור הוא נכנס (ידני / טופס / גיליון נוסף)
  `ALTER TABLE campaign_businesses ADD COLUMN color TEXT`,
  `ALTER TABLE campaign_businesses ADD COLUMN highlight INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE campaign_businesses ADD COLUMN source TEXT NOT NULL DEFAULT 'ידני'`,
  // מפתח זיהוי מול המקור החיצוני (מקור|שם מנורמל) — כדי שסנכרון חוזר יעדכן ולא ישכפל
  `ALTER TABLE campaign_businesses ADD COLUMN external_key TEXT`,
  `ALTER TABLE campaign_businesses ADD COLUMN product TEXT`,
  `ALTER TABLE campaign_businesses ADD COLUMN value_nis TEXT`,
  `ALTER TABLE campaign_businesses ADD COLUMN pickup TEXT`,
  `ALTER TABLE campaign_businesses ADD COLUMN validity TEXT`,
  `ALTER TABLE campaign_businesses ADD COLUMN logo_url TEXT`,
  `ALTER TABLE campaign_businesses ADD COLUMN synced_at TEXT`,
]) { try { db.exec(stmt); } catch { /* העמודה כבר קיימת */ } }

// ---------- מיזוג השיוך "כללי" אל "תחילת משמרת" ----------
// "כללי" היה מבלבל (כל משימה נפלה לתוכו והוא לא אמר כלום על מתי לבצע).
// המבנה החדש: תחילת משמרת / סוף משמרת / אישי (אחראית בשם) + מנהלת ומוקדנית בוקר כהרשאות.
// מיגרציה רכה — רצה גם על מסד קיים ולא מוחקת דבר, רק מסבה שם שיוך.
export const LEGACY_SCOPE = 'כללי';
export const DEFAULT_SCOPE = 'תחילת משמרת';
try {
  const a = db.prepare('UPDATE task_templates SET scope = ? WHERE scope = ?').run(DEFAULT_SCOPE, LEGACY_SCOPE);
  const b = db.prepare('UPDATE task_instances SET scope = ? WHERE scope = ?').run(DEFAULT_SCOPE, LEGACY_SCOPE);
  if (a.changes || b.changes) {
    console.log(`[migration] מיזוג "${LEGACY_SCOPE}" → "${DEFAULT_SCOPE}": ${a.changes} תבניות, ${b.changes} מופעים`);
  }
} catch { /* אין עמודת scope עדיין */ }

// ימים מיוחדים ביומן (אירוע/סגירה) — יום עם blocks=1 מתנהג כמו חג: לא נוצרות בו משימות
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS special_days (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      blocks INTEGER NOT NULL DEFAULT 1,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );`);
} catch { /* קיים */ }

// אישור קריאה אישי להערת משמרת. הערת 'all' נשארת מוצגת לכולן, אבל כל משתמשת
// מאשרת אותה בעצמה — כך המונה שלה מגיע ל-0 ולא נתקע לנצח.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS handover_acks (
      handover_id INTEGER NOT NULL,
      user_name TEXT NOT NULL,
      acked_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      PRIMARY KEY (handover_id, user_name)
    );`);
  // השלמה רטרואקטיבית: אישורים שנרשמו לפני קיום הטבלה
  db.exec(`INSERT OR IGNORE INTO handover_acks(handover_id, user_name, acked_at)
           SELECT id, acked_by, acked_at FROM handovers
           WHERE acked_by IS NOT NULL AND acked_at IS NOT NULL`);
} catch { /* קיים */ }

export function audit(userName, action, entity, entityId, before, after) {
  db.prepare(`INSERT INTO audit_log(user_name,action,entity,entity_id,before_state,after_state)
              VALUES(?,?,?,?,?,?)`)
    .run(userName || null, action, entity, String(entityId ?? ''),
         before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null);
}

// ---------- הרשאות גישה לפי דרגה ----------
db.exec(`
CREATE TABLE IF NOT EXISTS role_permissions (
  role TEXT NOT NULL,
  feature TEXT NOT NULL,
  allowed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (role, feature)
);
`);

// רשימת האזורים במערכת (לפי סדר התצוגה בתפריט) + תוויות עבריות
export const FEATURES = [
  { key: 'dashboard', label: 'לוח מנהלת' },
  { key: 'today', label: 'משימות היום' },
  { key: 'week', label: 'משימות השבוע' },
  { key: 'periodic', label: 'משימות תקופתיות' },
  { key: 'calendar', label: 'לוח שנה' },
  { key: 'problems', label: 'לוח בעיות' },
  { key: 'handover', label: 'העברת משמרת' },
  { key: 'messages', label: 'הודעות' },
  { key: 'attendance', label: 'שעות נוכחות' },
  { key: 'inventory', label: 'מלאי והשכרה (CRM)' },
  { key: 'campaign', label: 'קמפיין המכירה הסינית' },
  { key: 'campaign_prizes', label: 'קמפיין · ניהול קטלוג מתנות' },
  { key: 'campaign_hubs', label: 'קמפיין · הוספת מוקדים' },
  { key: 'campaign_settings', label: 'קמפיין · הגדרות ומיתוג' },
  { key: 'campaign_import', label: 'קמפיין · ייבוא מאקסל' },
  { key: 'ai', label: 'עוזרת AI' },
  { key: 'integrations', label: 'חיבורים (מייל/ימות/גיבוי)' },
  { key: 'admin', label: 'ניהול והרשאות' },
];
export const FEATURE_KEYS = FEATURES.map((f) => f.key);
// היררכיית הדרגות מלמעלה למטה.
export const ROLE_ORDER = [TOP_ROLE, 'מנהלת', 'מוקדנית', 'מתנדבת'];
// שם קודם לדרגת "מוקדנית" — לצורך מיגרציה של התקנות ותיקות
export const SHIFT_ROLE_LEGACY = 'אחמ"שית';
export const ROLES = ROLE_ORDER;

export const isTop = (role) => role === TOP_ROLE;
// "מנהלת ומעלה" — פעולות ניהול רגילות.
export function isManagerOrAbove(role) {
  const i = ROLE_ORDER.indexOf(role);
  return i !== -1 && i <= ROLE_ORDER.indexOf('מנהלת');
}

// מצבי משימה. 'לא רלוונטי' = לא היה מה לעשות היום (למשל לא היו מיילים דחופים) —
// לא פיגור, ולא נספר באחוזי הביצוע.
export const TASK_IRRELEVANT = 'לא רלוונטי';
export const TASK_STATUSES = ['open', 'done', TASK_IRRELEVANT];

// שיוך משימה — קובע מי רואה אותה
// "תחילת משמרת" ראשון — הוא ברירת המחדל (DEFAULT_SCOPE) שהחליפה את "כללי" שבוטל.
export const TASK_SCOPES = [
  { key: 'תחילת משמרת', label: 'תחילת משמרת', desc: 'צ׳ק-ליסט בכניסה — כל הצוות רואה' },
  { key: 'סוף משמרת', label: 'סוף משמרת', desc: 'צ׳ק-ליסט ביציאה' },
  { key: 'מוקדנית בוקר', label: 'מוקדנית בוקר', desc: 'כל מוקדנית שנכנסת' },
  { key: 'מנהלת', label: 'מנהלת בלבד', desc: 'סגור בפני העובדות' },
];
export const SCOPE_KEYS = TASK_SCOPES.map((s) => s.key);

// ברירות מחדל להרשאות. רק דרגת העל מקבלת הכל אוטומטית (נאכף בקוד);
// למנהלת ברירות מחדל רחבות — אבל בלי 'admin' (ניהול הרשאות ומשתמשות) שהוא בלעדי לדרגת העל.
const MANAGER_DEFAULTS = FEATURE_KEYS.filter((k) => k !== 'admin');
const PERM_DEFAULTS = {
  [TOP_ROLE]: FEATURE_KEYS,
  'מנהלת': MANAGER_DEFAULTS,
  'מוקדנית': ['today', 'week', 'periodic', 'calendar', 'problems', 'handover', 'messages', 'attendance', 'inventory', 'campaign', 'ai'],
  'מתנדבת': ['today', 'messages', 'attendance'],
};

if (db.prepare('SELECT COUNT(*) c FROM role_permissions').get().c === 0) {
  const ins = db.prepare('INSERT INTO role_permissions(role, feature, allowed) VALUES (?,?,?)');
  db.transaction(() => {
    for (const role of ROLES)
      for (const key of FEATURE_KEYS)
        ins.run(role, key, PERM_DEFAULTS[role].includes(key) ? 1 : 0);
  })();
}
// השלמת אזורים חדשים שנוספו אחרי הזריעה הראשונית
{
  const ins = db.prepare('INSERT OR IGNORE INTO role_permissions(role, feature, allowed) VALUES (?,?,?)');
  for (const role of ROLES)
    for (const key of FEATURE_KEYS)
      ins.run(role, key, PERM_DEFAULTS[role].includes(key) ? 1 : 0);
}

// ---------- מיגרציית ההיררכיה החדשה (רכה — רצה גם על מסד קיים) ----------
try {
  // 'עובדת' בוטל (חפף למוקדנית) — כל מי שהייתה עובדת הופכת למוקדנית
  db.prepare(`UPDATE users SET role = 'מוקדנית' WHERE role = 'עובדת'`).run();
  db.prepare(`DELETE FROM role_permissions WHERE role = 'עובדת'`).run();
} catch { /* אין מה לעדכן */ }
try {
  // 'כובסת' בוטל — אינו תפקיד רלוונטי לארגון; מי שהייתה בדרגה זו הופכת למתנדבת
  db.prepare(`UPDATE users SET role = 'מתנדבת' WHERE role = 'כובסת'`).run();
  db.prepare(`DELETE FROM role_permissions WHERE role = 'כובסת'`).run();
} catch { /* אין מה לעדכן */ }
try {
  // 'אחמ"שית' שונה ל'מוקדנית' — מעבירים משתמשות, הרשאות, ושיוכי משימות קיימים לשם החדש
  db.prepare('UPDATE users SET role = ? WHERE role = ?').run('מוקדנית', SHIFT_ROLE_LEGACY);
  db.prepare('DELETE FROM role_permissions WHERE role = ?').run(SHIFT_ROLE_LEGACY);
  db.prepare(`UPDATE task_templates SET scope = 'מוקדנית בוקר' WHERE scope = 'אחמשית בוקר'`).run();
  db.prepare(`UPDATE task_instances SET scope = 'מוקדנית בוקר' WHERE scope = 'אחמשית בוקר'`).run();
} catch { /* אין מה לעדכן */ }
try {
  // המנהלת הראשית (קוד 1111) מקבלת את דרגת העל
  db.prepare(`UPDATE users SET role = ? WHERE code = '1111' AND role != ?`).run(TOP_ROLE, TOP_ROLE);
} catch { /* אין משתמשת כזאת */ }
try {
  // שם דרגת העל השתנה — מעבירים משתמשות והרשאות מהשמות הישנים לשם הנוכחי
  for (const old of TOP_ROLE_LEGACY) {
    if (old === TOP_ROLE) continue;
    db.prepare('UPDATE users SET role = ? WHERE role = ?').run(TOP_ROLE, old);
    db.prepare('DELETE FROM role_permissions WHERE role = ?').run(old);
  }
  // שם התצוגה של משתמשת כניסת הגיבוי מכיל את שם הדרגה הישן — מתקנים גם אותו
  db.prepare(`UPDATE users SET name = ? WHERE code = ? AND name LIKE 'כניסת גיבוי (%'`).run(BACKUP_TOP_NAME, BACKUP_TOP_CODE);
} catch { /* אין מה לעדכן */ }
try {
  // מנהלת כבר לא עוקפת את טבלת ההרשאות — מוודאים שיש לה שורות בפועל, ושאין לה 'admin'
  const ins = db.prepare('INSERT OR IGNORE INTO role_permissions(role, feature, allowed) VALUES (?,?,?)');
  for (const key of FEATURE_KEYS) ins.run('מנהלת', key, PERM_DEFAULTS['מנהלת'].includes(key) ? 1 : 0);
  db.prepare(`UPDATE role_permissions SET allowed = 0 WHERE feature = 'admin' AND role != ?`).run(TOP_ROLE);
} catch { /* אין מה לעדכן */ }

// דרגת העל תמיד עם גישה מלאה — מונע נעילה מוחלטת של המערכת
export function hasFeature(role, feature) {
  // כיבוי מודול המלאי חוסם את כולן — כולל דרגת העל — גם בתפריט וגם בשרת
  if (feature === 'inventory' && !inventoryEnabled()) return false;
  if (isTop(role)) return true;
  if (feature === 'admin') return false;   // ניהול הרשאות ומשתמשות — בלעדי לדרגת העל
  const row = db.prepare('SELECT allowed FROM role_permissions WHERE role=? AND feature=?').get(role, feature);
  return !!(row && row.allowed);
}

export function featuresFor(role) {
  return FEATURE_KEYS.filter((k) => hasFeature(role, k));
}

export function permissionMatrix() {
  const m = {};
  for (const role of ROLES) {
    m[role] = {};
    for (const key of FEATURE_KEYS) m[role][key] = isTop(role) ? 1 : 0;
  }
  db.prepare('SELECT role, feature, allowed FROM role_permissions').all()
    .forEach((r) => { if (m[r.role] && FEATURE_KEYS.includes(r.feature)) m[r.role][r.feature] = r.allowed; });
  FEATURE_KEYS.forEach((k) => (m[TOP_ROLE][k] = 1));        // כפייה: דרגת העל תמיד מלא
  ROLES.forEach((r) => { if (!isTop(r)) m[r].admin = 0; }); // כפייה: 'admin' בלעדי לדרגת העל
  return m;
}

export function setPermission(role, feature, allowed) {
  if (isTop(role)) return false;                 // אי אפשר לשנות לדרגת העל
  if (feature === 'admin') return false;         // ניהול הרשאות ומשתמשות — בלעדי לדרגת העל
  if (!ROLES.includes(role) || !FEATURE_KEYS.includes(feature)) return false;
  db.prepare(`INSERT INTO role_permissions(role, feature, allowed) VALUES (?,?,?)
              ON CONFLICT(role, feature) DO UPDATE SET allowed=excluded.allowed`)
    .run(role, feature, allowed ? 1 : 0);
  return true;
}

// ---------- זריעת נתונים ראשונית ----------
const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
if (userCount === 0) {
  db.prepare(`INSERT INTO users(name, role, code) VALUES ('מנהלת ראשית', ?, '1111')`).run(TOP_ROLE);
}

// כניסת גיבוי לדרגת העל — כדי שאיבוד קוד אחד לא ינעל את מסך ההרשאות לתמיד.
// חייבת לרוץ *אחרי* זריעת המשתמשת הראשית: אם היא רצה לפניה, טבלת המשתמשות
// כבר אינה ריקה, והמשתמשת עם קוד 1111 לא נוצרת כלל בהתקנה חדשה.
// נוצרת פעם אחת בלבד; אם המשתמשת שינתה או מחקה אותה — לא משחזרים.
try {
  const exists = db.prepare('SELECT 1 FROM users WHERE code = ?').get(BACKUP_TOP_CODE);
  if (!exists && getSetting('backup_top_seeded') !== '1') {
    db.prepare('INSERT INTO users(name, role, code) VALUES (?,?,?)')
      .run(BACKUP_TOP_NAME, TOP_ROLE, BACKUP_TOP_CODE);
  }
  setSetting('backup_top_seeded', '1');
} catch { /* אין מה לעדכן */ }

// הזריעה האוטומטית למטה היא 105 משימות ספציפיות לגמ"ח השמלות (שמלות, ברקודים, דגמים) —
// לא רלוונטיות לאמא במשמרת, ולכן כבויה כאן. המשתמשת תגדיר תבניות משימות משלה בלשונית "ניהול".
const tplCount = db.prepare('SELECT COUNT(*) c FROM task_templates').get().c;
if (false && tplCount === 0) {
  // כל המשימות מתוך הדפים הקיימים: יומן, פעם בשבוע, שונות (דו-שבועי/חודשי/רבעוני)
  const T = [];
  const add = (frequency, category, titles) =>
    titles.forEach((title) => T.push({ frequency, category, title }));

  // ===== יומי (א'-ה') =====
  add('daily', 'ניהול צוות ועובדות', ['האזנה במיידי להודעות בקו אחמ"שיות']);
  add('daily', 'ניהול מתנדבות', [
    'טיפול בתלונות על מתנדבות אם יש',
    'בירור גורם התלונה וחשיבה על מניעת המקרה בעתיד',
  ]);
  add('daily', 'ניהול מלאי', ['מעבר על סטנד תקלות ופגומים וטיפול בבעיות']);
  add('daily', 'בקרת איכות התפירה', ['מענה לשאלות התופרות']);
  add('daily', 'בקרת איכות השמלות', [
    'מעקב ורישום אחר תיקונים שלא הוחזרו לקדמותם',
    'סיור על הסטנדים לאיתור שמלות בלויות',
    'בדיקת סטנד פגמים – החלטה מה לתיקון ומה לגריעה',
    'העברת שמלות מוכתמות לניקוי נוסף',
  ]);
  add('daily', 'שרות לקוחות', [
    'שיחת טלפון ללקוחה שצריכה מענה יוצא דופן (למשל: שמלה אבודה)',
    'מענה למיילים',
    'מענה מיידי למיילים דחופים',
    'טיפול מיידי במקרים דחופים',
  ]);
  add('daily', 'תיעוד ורישום', [
    'תיעוד תלונות מהעובדות (בלוח הבעיות)',
    'תיעוד תלונות מהמתנדבות (בלוח הבעיות)',
    'תיעוד תלונות מלקוחות (בלוח הבעיות)',
    'תיעוד בעיות ותקלות שזוהו עצמאית (בלוח הבעיות)',
    'מעבר על לוח הבעיות: מסקנות, החלטות, תאריכי יעד ומעקב ביצוע',
  ]);
  add('daily', 'כספים', [
    'מעקב יומי בגדול אחר היקף הנדרים',
    'בדיקה מיידית אם יש משהו יוצא דופן',
  ]);
  add('daily', 'נקיון', ['בדיקת ניקיון כללית של הגמ"ח (כולל שירותים)']);
  add('daily', 'בקרה', [
    'מעבר על הודעות מהאחמ"שיות, טיפול וחשיבה על מניעת התקלה בעתיד',
    'מעקב אחרי לקוחות שלא החזירו שמלות בזמן',
    'גביה מלקוחות שלא החזירו בזמן',
  ]);

  // ===== שבועי (לפי פרשה) =====
  add('weekly', 'ניהול צוות ועובדות', [
    'בדיקת נוכחות של עובדות',
    'פידבק לעובדת על משהו מיוחד שהצטיינה בו',
  ]);
  add('weekly', 'ניהול מתנדבות', [
    'רכישת צופר שבועי קבוע למתנדבות',
    'בדיקת נוכחות של מתנדבות – לפי עדכון שוטף מהאחמ"שיות',
    'בדיקת תיבת הערות מהמתנדבות',
    'פידבק למתנדבת על משהו מיוחד שהצטיינה בו',
  ]);
  add('weekly', 'בקרת איכות התפירה', ['דילול סטנד תיקונים משמלות לא רלוונטיות']);
  add('weekly', 'בקרת איכות השמלות', ['גביה על תיקונים שלא הוחזרו לקדמותם']);
  add('weekly', 'משוב', ['מעקב אחר תיבת המשוב בגמ"ח']);
  add('weekly', 'תיעוד ורישום', ['שליחת נתונים לאהובי – פעמיים בשבוע']);
  add('weekly', 'כספים', [
    'בדיקת סגירת קופה יומית',
    'דיווח כספי שבועי לאהובי',
  ]);
  add('weekly', 'מכירות', [
    'בדיקת משפך המכירות – כמה הורידו קטלוג וכמה הזמינו תור',
    'מעקב אחר מערכת התורים – פעמיים בשבוע',
    'צפיה אחר אחמ"שיות ומעקב מכירות',
    'תיעוד כתוב של הצפיה',
  ]);
  add('weekly', 'שווק', ['כתיבת מייל פעמיים בשבוע']);
  add('weekly', 'תחזוקה', [
    'בדיקת ציוד טכני: דפים, עטים, חומר מתכלה',
    'הזמנת כיבוד לפינת קפה (קפה, סוכר, חלב, כוסות)',
  ]);

  // ===== אחת לשבועיים =====
  add('biweekly', 'בקרה', [
    'בדיקת היערכות לתקופת עומס/שפל או תקופת חגים ושינוי קרוב',
    'התאמת מערכת התורים והשיבוץ, ותוספת מתנדבות אם צריך תגבור',
    'שיחה עם האחמ"שיות בנושא מעקב תפקוד המתנדבות',
    'שיחה עם מתנדבת שיש איתה בעיה בעקבות השיחה הנ"ל',
  ]);
  add('biweekly', 'ניהול מתנדבות', ['הכנת צופר למתנדבות לימי עומס מיוחדים (חנוכה, מבחנים וכו׳)']);
  add('biweekly', 'שרות לקוחות', ['מעבר על קובץ המשוב לבדיקת תלונות ספציפיות ומחשבה על שיפור']);
  add('biweekly', 'משוב', [
    'מעבר על קובץ המשובים החודשי (אקסל)',
    'ניתוח ציונים נמוכים (מתחת ל-7)',
    'הפקת לקחים מתלונה חוזרת',
  ]);
  add('biweekly', 'כספים', [
    'השוואת הכנסות שבועיות ליעד (20,000 ₪ לשבוע)',
    'מעקב הוצאות "קופה קטנה" של האחמ"שיות',
  ]);
  add('biweekly', 'מכירות', ['עדכון הודעה במערכת התורים']);

  // ===== חודשי =====
  add('monthly', 'כספים', [
    'אישור שעות עבודה חודשיות לצורך שכר',
    'חישוב שכר עובדות',
    'תשלום לספקים',
  ]);
  add('monthly', 'בקרת איכות התפירה', [
    'בדיקת מלאי בדים לתיקונים',
    'זריקת בדים לא רלוונטיים',
    'הזמנת רוכסנים לפי הצורך',
  ]);
  add('monthly', 'משוב', ['בדיקת אחוז המענה למשובים (האם צריך לעודד מענה?)']);
  add('monthly', 'מכירות', [
    'מעקב אחר סטים בגמ"ח – לראות שאין עומס בעיניים',
    'דילול לפי הצורך',
  ]);
  add('monthly', 'שווק', ['עדכון הקטלוג הדיגיטלי בתמונות חדשות']);
  add('monthly', 'תחזוקה', [
    'הזמנת חומרי ניקוי וטואלטיקה (נייר, סבון, שקיות)',
    'הזמנת ציוד משרדי (דפים למדפסת, טונר)',
    'בדיקת תקינות תאורה ותיקון נורות שרופות',
    'בדיקת תקינות מזגנים (במיוחד בקיץ/חורף)',
  ]);

  // ===== רבעוני =====
  add('quarterly', 'ניהול צוות ועובדות', [
    'לוודא שכל העובדות יודעות על חשיבות המכירות (אסיפות ומודעות כללית)',
    'הערכות לאסיפת צוות: בניית תוכן, הגדרת מטרות ורישום הנהלים',
    'הערכות טכנית לאסיפת צוות: לו"ז, תכניה, מיקום, כיבוד, חלוקת תפקידים, תאריך',
    'התאמת תפקוד הגמ"ח שלא ייפגע בזמן אסיפת הצוות',
    'איתור וגיוס עובדת חדשה: פרסום מודעה, מעבר על קו"ח, בירור, ראיון',
    'הכשרת עובדת חדשה: הדרכה וחפיפה',
    'הערה לעובדת שחרגה מהנהלים',
    'השגת ממלאת מקום למקרה של היעדרות מוצדקת',
    'בדיקת מצבת המשמרות וּוידוא שאין חורים – ואם יש, לטפל',
    'מתנה או מכתב לעובדת לרגל שמחה',
  ]);
  add('quarterly', 'ניהול מתנדבות', [
    'בדיקת מצבת משמרות המתנדבות וטיפול בחורים',
    'שיחת טלפון למתנדבת שלא הגיעה – לברר סיבה',
  ]);
  add('quarterly', 'ניהול מלאי', [
    'ספירת מלאי מדגמית לשתי קטגוריות: נשים / ילדות',
    'ספירת מלאי מדגמית לשתי קטגוריות: חורף / קיץ',
    'הוצאת דגמים ישנים למחסן/תרומה',
    'החלפת מיקום סטנדים לפי עונה',
    'קבלת סחורה מספקים ופריקה',
    'בדיקת התאמה בין המלאי במחשב למלאי בפועל',
    'הדפסת ברקודים לשמלות חדשות שהגיעו',
    'הזנת שמלות חדשות לתוכנת המחשב',
    'בדיקת איכות סחורה חדשה שהגיעה מספק',
    'מעקב אחר סט חדש בתוכנה – כמות הזמנות',
    'מעקב אחר סט חדש בצפיה – לראות איך הולך ולמה',
    'מעקב אחר סט חדש בשיחה עם האחמ"שיות',
    'מעקב אחר מידות סט חדש – האם צריך לקנות עוד',
    'רכישות ממשפחות – במידה ורוצים להגדיל סט',
    'תשלום למשפחות שרכשו מהן',
  ]);
  add('quarterly', 'כספים', ['בדיקת הוצאות חריגות (חשמל, ציוד משרדי מוגזם)']);
  add('quarterly', 'מכירות', [
    'הסקת מסקנות מתיעוד הצפיות באחמ"שיות',
    'שינוי ההודעה במערכת התורים לפי הצורך',
  ]);
  add('quarterly', 'שווק', [
    'חשיבה על מבצע שיווקי לתקופות "מתות"',
    'סקירת מתחרים (מה חדש בגמ"חים אחרים?)',
    'תיאום יום צילומים לקולקציה חדשה (צלמת, דוגמניות)',
  ]);
  add('quarterly', 'תחזוקה', [
    'תחזוקת שלטי הכוונה ושילוט בגמ"ח',
    'טיפול בתקלות מחשב/מדפסת ברקודים',
  ]);
  add('quarterly', 'נקיון', ['תיאום מול המנקה – בדיקת זמני הגעה']);

  const ins = db.prepare(
    'INSERT INTO task_templates(title, category, frequency, role, sort) VALUES (?,?,?,?,?)'
  );
  db.transaction(() => {
    T.forEach((t, i) => ins.run(t.title, t.category, t.frequency, 'מנהלת', i));
  })();
}

// ========================================================================
// קמפיין המכירה הסינית — מערכת נקודות למתנדבות (נבנה 12/10/2026)
// משתמש בטבלת settings הכללית (מפתחות עם תחילית campaign_) ולא בטבלה נפרדת.
// ========================================================================
db.exec(`
CREATE TABLE IF NOT EXISTS campaign_volunteers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT UNIQUE NOT NULL,
  name TEXT,
  identified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS campaign_point_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  volunteer_id INTEGER NOT NULL REFERENCES campaign_volunteers(id),
  type TEXT NOT NULL,
  points INTEGER,
  status TEXT NOT NULL DEFAULT 'approved',
  value_nis INTEGER,
  note TEXT,
  recording_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  approved_at TEXT
);

CREATE TABLE IF NOT EXISTS campaign_weekly_goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  volunteer_id INTEGER NOT NULL REFERENCES campaign_volunteers(id),
  week_start TEXT NOT NULL,
  goal_points INTEGER NOT NULL,
  bonus_claimed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(volunteer_id, week_start)
);

-- מעקב פניות לעסקים: מי פנתה, לאיזה עסק, ומה הייתה התגובה
CREATE TABLE IF NOT EXISTS campaign_businesses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contacted_by TEXT,
  phone TEXT,
  response TEXT,
  status TEXT NOT NULL DEFAULT 'ממתין',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT
);

-- סטטוסים מותאמים-אישית שמתווספים על גבי הרשימה הקבועה (ממתין/נוצר קשר/תרם/סירב)
CREATE TABLE IF NOT EXISTS campaign_business_statuses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- היסטוריית תגובות/עדכונים לעסק — כל מה שהיה בקשר איתו במשך הזמן (לא רק התגובה האחרונה)
CREATE TABLE IF NOT EXISTS campaign_business_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES campaign_businesses(id),
  text TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS campaign_prizes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code INTEGER UNIQUE NOT NULL,
  name TEXT NOT NULL,
  value_nis INTEGER,
  points_cost INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS campaign_hubs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  pin TEXT UNIQUE NOT NULL,
  kits_total INTEGER NOT NULL DEFAULT 0,
  kits_available INTEGER NOT NULL DEFAULT 0,
  area_path TEXT,
  pickup_info TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS campaign_hub_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hub_id INTEGER NOT NULL REFERENCES campaign_hubs(id),
  kind TEXT NOT NULL,
  phone TEXT,
  amount INTEGER,
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`);

// ========================================================================
// לשונית "מכירה סינית" (נבנה 24/10/2026) — עסקים מסונכרנים מכל הטפסים,
// שלבי סגירה, שאלות למנהלת עם שלבי מענה, ומענה AI מתוך קבצי וורד.
// ========================================================================
db.exec(`
-- מקורות סנכרון נוספים: כל גיליון/טופס גוגל שהמנהלת מדביקה בעצמה, בלי קוד
CREATE TABLE IF NOT EXISTS campaign_sync_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sheet_id TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  last_synced_at TEXT,
  last_rows INTEGER,
  last_error TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(sheet_id, sheet_name)
);

-- הגדרת שלבי הסגירה (אותו מסלול לכל העסקים, בסדר קבוע וניתן לעריכה)
CREATE TABLE IF NOT EXISTS campaign_close_stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- איזה שלב סגירה הושלם לאיזה עסק, על ידי מי ומתי
CREATE TABLE IF NOT EXISTS campaign_business_stages (
  business_id INTEGER NOT NULL REFERENCES campaign_businesses(id),
  stage_id INTEGER NOT NULL REFERENCES campaign_close_stages(id),
  done INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  done_by TEXT,
  done_at TEXT,
  PRIMARY KEY (business_id, stage_id)
);

-- שאלות שנשאלו (ידנית או דרך ה-AI) + שלבי המענה על כל שאלה
CREATE TABLE IF NOT EXISTS campaign_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  asked_by TEXT,
  business_id INTEGER REFERENCES campaign_businesses(id),
  status TEXT NOT NULL DEFAULT 'נשאלה',
  answer TEXT,
  answered_by TEXT,
  answered_at TEXT,
  origin TEXT NOT NULL DEFAULT 'ידני',
  email_sent_at TEXT,
  email_to TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS campaign_question_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES campaign_questions(id),
  text TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- בסיס הידע של ה-AI: קבצי וורד שהועלו, והטקסט המלא שחולץ מהם
CREATE TABLE IF NOT EXISTS campaign_kb_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  char_count INTEGER NOT NULL DEFAULT 0,
  uploaded_by TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- זוגות שאלה-תשובה שחולצו מתוך קובץ הוורד (מה שה-AI שואב ממנו תשובות)
CREATE TABLE IF NOT EXISTS campaign_kb_pairs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL REFERENCES campaign_kb_docs(id),
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- יומן המענה של ה-AI — מוצג כסטטוס עם כל השאלות והתשובות הקודמות
CREATE TABLE IF NOT EXISTS campaign_ai_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  answer TEXT,
  outcome TEXT NOT NULL,
  source_doc TEXT,
  asked_by TEXT,
  question_id INTEGER REFERENCES campaign_questions(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`);

// שלבי סגירה ברירת מחדל — נזרעים רק בפעם הראשונה, אחר כך המנהלת עורכת בעצמה
try {
    const haveStages = db.prepare('SELECT COUNT(*) AS c FROM campaign_close_stages').get().c;
    if (!haveStages) {
        const ins = db.prepare('INSERT INTO campaign_close_stages (name, position) VALUES (?, ?)');
        ['פנייה ראשונה', 'נשלח חומר הסבר', 'ממתין לתשובה', 'אישרו תרומה', 'המוצר התקבל', 'לוגו וחומר פרסומי', 'סגור והושלם']
            .forEach((name, i) => ins.run(name, i + 1));
    }
} catch (e) { console.error('זריעת שלבי הסגירה נכשלה:', e.message); }

// שחזור חד-פעמי של תגובות עסקים שנכתבו לפני שהייתה טבלת היסטוריה נפרדת (campaign_business_notes) —
// התגובות הקודמות עדיין קיימות ביומן הפעולות (audit_log) בכל עדכון, רק לא הוצגו כרשומות נפרדות.
try {
    const businessesNoHistory = db.prepare(`
        SELECT b.id, b.response, b.created_at, b.updated_at FROM campaign_businesses b
        WHERE NOT EXISTS (SELECT 1 FROM campaign_business_notes n WHERE n.business_id = b.id)
    `).all();
    const insertNote = db.prepare('INSERT INTO campaign_business_notes (business_id, text, created_by, created_at) VALUES (?, ?, ?, ?)');
    for (const biz of businessesNoHistory) {
        const auditRows = db.prepare(`
            SELECT user_name, after_state, at FROM audit_log
            WHERE entity = 'campaign_businesses' AND entity_id = ? AND action = 'campaign.business.update'
            ORDER BY id ASC
        `).all(String(biz.id));
        let lastText = null;
        const toInsert = [];
        for (const row of auditRows) {
            let after;
            try { after = JSON.parse(row.after_state); } catch { continue; }
            const text = String(after?.response ?? '').trim();
            if (!text || text === lastText) continue;
            toInsert.push({ text, created_by: row.user_name, created_at: row.at });
            lastText = text;
        }
        const currentText = String(biz.response ?? '').trim();
        if (currentText && currentText !== lastText) {
            toInsert.push({ text: currentText, created_by: null, created_at: biz.updated_at || biz.created_at });
        }
        for (const n of toInsert) insertNote.run(biz.id, n.text, n.created_by, n.created_at);
    }
} catch (e) { console.error('שחזור היסטוריית תגובות לעסקים נכשל:', e.message); }

const CAMPAIGN_SETTING_DEFAULTS = {
    campaign_points_outreach: '2',
    campaign_points_errand: '4',
    campaign_goal_bonus_percent: '10',
    campaign_product_conversion_percent: '',
    campaign_brand_primary: '#14497c',
    campaign_brand_accent: '#1e5fa8',
    campaign_brand_dark: '#0b2a4a',
    campaign_brand_logo: '',
    campaign_sheets_write_url: '',
    campaign_sheets_write_secret: '',
    campaign_sync_admin_password: '',
    // לשונית "מכירה סינית": לאן נשלחות שאלות למנהלת המערכת (אם ריק — נופלים לכתובת הדוחות report_email)
    campaign_admin_email: '',
    campaign_admin_name: 'מנהלת המערכת'
};

export function getCampaignSetting(key) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return (row && row.value !== '') ? row.value : (CAMPAIGN_SETTING_DEFAULTS[key] ?? '');
}

export function getAllCampaignSettings() {
    const result = { ...CAMPAIGN_SETTING_DEFAULTS };
    for (const key of Object.keys(CAMPAIGN_SETTING_DEFAULTS)) {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
        if (row && row.value !== '') result[key] = row.value;
    }
    return result;
}

export function setCampaignSettings(obj) {
    for (const [key, value] of Object.entries(obj)) {
        if (key in CAMPAIGN_SETTING_DEFAULTS) setSetting(key, String(value ?? ''));
    }
}

export const CAMPAIGN_POINTS = () => ({
    outreach: parseInt(getCampaignSetting('campaign_points_outreach'), 10) || 0,
    errand: parseInt(getCampaignSetting('campaign_points_errand'), 10) || 0
});
export const CAMPAIGN_GOAL_BONUS_RATE = () => (parseFloat(getCampaignSetting('campaign_goal_bonus_percent')) || 0) / 100;

export function findOrCreateVolunteer(phone) {
    let v = db.prepare('SELECT * FROM campaign_volunteers WHERE phone = ?').get(phone);
    if (!v) {
        const info = db.prepare("INSERT INTO campaign_volunteers (phone, identified, created_at) VALUES (?, 0, datetime('now','localtime'))").run(phone);
        v = db.prepare('SELECT * FROM campaign_volunteers WHERE id = ?').get(info.lastInsertRowid);
        audit(phone, 'campaign.phone.new_volunteer', 'campaign_volunteers', v.id, null, { phone });
    }
    return v;
}

export function getVolunteerBalance(volunteerId) {
    const row = db.prepare(
        `SELECT COALESCE(SUM(points), 0) AS total FROM campaign_point_transactions
         WHERE volunteer_id = ? AND status = 'approved' AND points IS NOT NULL`
    ).get(volunteerId);
    return row.total;
}

export function campaignWeekStart(date = new Date()) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - d.getDay());
    return d.toISOString().slice(0, 10);
}

export function pointsEarnedSinceWeekStart(volunteerId, ws) {
    const row = db.prepare(
        `SELECT COALESCE(SUM(points), 0) AS total FROM campaign_point_transactions
         WHERE volunteer_id = ? AND status = 'approved' AND points IS NOT NULL
           AND type IN ('outreach', 'errand', 'product')
           AND created_at >= ?`
    ).get(volunteerId, ws + ' 00:00:00');
    return row.total;
}

export function findHubByAreaPath(areaPath) {
    return db.prepare('SELECT * FROM campaign_hubs WHERE area_path = ?').get(areaPath);
}

// עץ האזורים/ערים/שכונות שמסרה נחמי (מזכירת אמא במשמרת) ב-12/10/2026.
// הערה: "הר יונה" ו"טבריה" הופיעו ברשימה המקורית בלי מספור מפורש תחת צפון -
// יוחסו להן 4-5 לפי סדר ההופעה כדי שאפשר יהיה להקיש עליהן בטלפון.
export const CAMPAIGN_GEO_TREE = [
    { key: '1', name: 'צפון', children: [
        { key: '1', name: 'חיפה', children: [
            { key: '1', name: 'הדר', children: [] },
            { key: '2', name: 'נווה שאנן', children: [] }
        ] },
        { key: '2', name: 'צפת', children: [] },
        { key: '3', name: 'עפולה', children: [
            { key: '1', name: 'עפולה עילית', children: [] },
            { key: '2', name: 'גבעת המורה', children: [] }
        ] },
        { key: '4', name: 'הר יונה', children: [] },
        { key: '5', name: 'טבריה', children: [] }
    ] },
    { key: '2', name: 'מרכז', children: [
        { key: '1', name: 'בני ברק', children: [
            { key: '1', name: 'פרדס כץ וצפון העיר', children: [] },
            { key: '2', name: 'מרכז העיר ורמת אהרן', children: [] },
            { key: '3', name: 'קריית הרצוג ודרום העיר', children: [] }
        ] },
        { key: '2', name: 'מודיעין עילית', children: [
            { key: '1', name: 'קריית ספר', children: [] },
            { key: '2', name: 'ברכפלד', children: [] },
            { key: '3', name: 'גרין פארק נאות הפסגה', children: [] }
        ] },
        { key: '3', name: 'אלעד', children: [] }
    ] },
    { key: '3', name: 'דרום', children: [
        { key: '1', name: 'אשדוד', children: [
            { key: '1', name: 'רובעים א ב ג ד', children: [] },
            { key: '2', name: 'רובעים ו ז ח', children: [] },
            { key: '3', name: 'רובעים חדשים', children: [] }
        ] },
        { key: '2', name: 'אופקים', children: [
            { key: '1', name: 'מרכז העיר והשכונות הוותיקות', children: [] },
            { key: '2', name: 'השכונות החדשות', children: [] }
        ] }
    ] },
    { key: '4', name: 'ירושלים והסביבה', children: [
        { key: '1', name: 'ירושלים', children: [
            { key: '1', name: 'רמות', children: [] },
            { key: '2', name: 'רוממה מהשכונות הצפוניות וגבעת שאול', children: [] },
            { key: '3', name: 'גאולה בית ישראל שמואל הנביא', children: [] }
        ] },
        { key: '2', name: 'בית שמש', children: [
            { key: '1', name: 'בית שמש הוותיקה', children: [] },
            { key: '2', name: 'רמת בית שמש א', children: [] },
            { key: '3', name: 'רמת בית שמש ב וג', children: [] },
            { key: '4', name: 'רמת בית שמש ד', children: [] }
        ] },
        { key: '3', name: 'ביתר עילית', children: [
            { key: '1', name: 'הגבעה', letter: 'A', children: [] },
            { key: '2', name: 'הגבעה', letter: 'B', children: [] },
            { key: '3', name: 'הגבעה', letter: 'C', children: [] }
        ] }
    ] }
];

export function campaignGeoLeaves() {
    const result = [];
    function walk(nodes, pathNames) {
        for (const node of nodes) {
            const label = node.letter ? `${node.name} ${node.letter}` : node.name;
            const names = [...pathNames, label];
            if (!node.children || node.children.length === 0) {
                result.push({ path: names.join('/'), label: names.join(' / ') });
            } else {
                walk(node.children, names);
            }
        }
    }
    walk(CAMPAIGN_GEO_TREE, []);
    return result;
}
