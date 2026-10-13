import { db, audit, isManagerOrAbove, DEFAULT_SCOPE } from './db.js';
import { hebInfo, isoDate } from './hebrew.js';

// יצירת משימה אוטומטית ממודול המלאי (אידמפוטנטי לפי uniq_key)
export function createAutoTask({ title, category = 'בקרה', due_date = null, uniq_key, priority = 'דחוף' }) {
  const exists = db.prepare('SELECT id FROM task_instances WHERE uniq_key = ?').get(uniq_key);
  if (exists) return { id: exists.id, existed: true };
  const r = db.prepare(`INSERT INTO task_instances(title, category, period_key, due_date, source, uniq_key, priority)
                        VALUES (?,?,?,?,'inventory',?,?)`)
    .run(title, category, 'auto-' + uniq_key, due_date, uniq_key, priority);
  audit('inventory-module', 'task.create.auto', 'task_instance', r.lastInsertRowid, null, { title, uniq_key });
  return { id: r.lastInsertRowid, existed: false };
}

// ברירת המחדל כליטרל SQL. DEFAULT_SCOPE הוא קבוע קוד (לא קלט משתמש), והמרכאות
// מוכפלות כדי שהליטרל יהיה תקין גם אם השם ישונה בעתיד לשם עם גרש.
const SQL_DEFAULT_SCOPE = `'${DEFAULT_SCOPE.replace(/'/g, "''")}'`;

export const FREQS = ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly'];

// יום מיוחד שחוסם — מתנהג כמו חג: לא נוצרות בו משימות אוטומטיות
export function blockingSpecialDay(date) {
  try {
    return db.prepare(`SELECT id, date, title, blocks FROM special_days WHERE date = ? AND blocks = 1`)
      .get(isoDate(date)) || null;
  } catch { return null; }
}

// יצירת מופעי משימות לתקופות הנוכחיות (אידמפוטנטי)
export function ensureInstances(date = new Date()) {
  const info = hebInfo(date);
  if (blockingSpecialDay(date)) return info;   // יום אירוע/סגירה — אין משימות אוטומטיות
  const ins = db.prepare(`
    INSERT OR IGNORE INTO task_instances(template_id, period_key, due_date, priority, assignee, scope)
    VALUES (@id, @key, @due, @priority, @assignee, @scope)`);
  const tpls = db.prepare('SELECT id, frequency, priority, assignee, scope FROM task_templates WHERE active = 1').all();
  db.transaction(() => {
    for (const t of tpls) {
      if (t.frequency === 'daily' && !info.isShabbatWeekday) continue; // אין משימות יומיות בשישי-שבת
      if (!FREQS.includes(t.frequency)) continue;
      ins.run({ id: t.id, key: info.keys[t.frequency], due: info.dues[t.frequency],
                priority: t.priority || 'רגיל', assignee: t.assignee || null, scope: t.scope || DEFAULT_SCOPE });
    }
  })();
  return info;
}

// תנאי הרשאה: מה משתמשת רואה — מנהלת ומעלה רואות הכל; אחרת: לא רואה שיוך "מנהלת",
// ורואה רק משימות לא-משויכות או משויכות אליה אישית (שיוך אישי בשם — כדי שלא תופיע לכולן).
export function visibilityClause(user) {
  if (isManagerOrAbove(user?.role)) return { sql: '', params: [] };
  return {
    sql: `AND COALESCE(i.scope,${SQL_DEFAULT_SCOPE}) != 'מנהלת' AND (i.assignee IS NULL OR i.assignee = ?)`,
    params: [user?.name || ''],
  };
}

// user: המשתמשת המחוברת — עובדת רואה משימות כלליות + משימות על שמה; המנהלת רואה הכל
export function tasksForScope(scope, date = new Date(), user = null) {
  const info = ensureInstances(date);
  const freqsByScope = {
    today: ['daily'],
    week: ['weekly', 'biweekly'],
    periodic: ['monthly', 'quarterly'],
  };
  const freqs = freqsByScope[scope] || ['daily'];
  const keys = freqs.map((f) => info.keys[f]);
  const vis = visibilityClause(user);

  const rows = db.prepare(`
    SELECT i.id, i.period_key, i.due_date, i.status, i.done_by, i.done_at, i.note, i.source, i.assignee,
           i.description,
           COALESCE(i.priority, 'רגיל') AS priority, COALESCE(i.pinned, 0) AS pinned,
           COALESCE(i.scope, ${SQL_DEFAULT_SCOPE}) AS scope,
           COALESCE(i.title, t.title) AS title,
           COALESCE(i.category, t.category) AS category,
           COALESCE(t.frequency, 'once') AS frequency,
           COALESCE(t.sort, 9999) AS sort
    FROM task_instances i
    LEFT JOIN task_templates t ON t.id = i.template_id
    WHERE i.period_key IN (${keys.map(() => '?').join(',')})
      -- רשת ביטחון: משימה מתבנית שהושבתה לא מוצגת, גם אם נשאר לה מופע פתוח
      AND (i.template_id IS NULL OR t.active = 1 OR i.status != 'open')
      ${vis.sql}
    ORDER BY sort, i.id`).all(...keys, ...vis.params);

  // משימות אוטומטיות/חד-פעמיות מוצגות בלשונית "היום": כל הפתוחות תמיד,
  // ובנוסף כאלה שבוצעו היום — כדי שמשימה שסומנה לא תיעלם מהמסך מיד.
  // (משימות שבוצעו בימים קודמים כבר לא מוצגות, כדי שהמסך לא ייערם.)
  if (scope === 'today') {
    const extras = db.prepare(`
      SELECT i.id, i.period_key, i.due_date, i.status, i.done_by, i.done_at, i.note, i.source, i.assignee,
             i.description,
             COALESCE(i.priority, 'רגיל') AS priority, COALESCE(i.pinned, 0) AS pinned,
             COALESCE(i.scope, ${SQL_DEFAULT_SCOPE}) AS scope,
             i.title, i.category, 'once' AS frequency, 9999 AS sort
      FROM task_instances i
      WHERE i.template_id IS NULL
        AND (i.status = 'open' OR date(i.done_at) = date('now','localtime'))
        ${vis.sql}
      ORDER BY i.status, i.due_date, i.id`).all(...vis.params);
    rows.push(...extras);
  }
  // משימות נעוצות תמיד ראשונות — הן נשארות מול העיניים ללא תלות בקטגוריה או בסדר התבנית
  rows.sort((a, b) => (b.pinned || 0) - (a.pinned || 0));
  return { info, rows };
}
