import express from 'express';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { db, audit, hasFeature, featuresFor, permissionMatrix, setPermission, inventoryEnabled,
         FEATURES, ROLES, TASK_SCOPES, SCOPE_KEYS, DEFAULT_SCOPE, TASK_STATUSES, TASK_IRRELEVANT, TOP_ROLE, isTop, isManagerOrAbove } from './server/db.js';
import { hebInfo, isoDate, dayInfo, hebMonthTitle } from './server/hebrew.js';
import { ensureInstances, tasksForScope, FREQS, visibilityClause } from './server/tasks.js';
import { inventoryRouter } from './server/inventory.js';
import { vText, vEnum, vDate, vAmount, firstError } from './server/validate.js';
import { integrationsRouter, scheduleAutoBackup, scheduleDailyReport } from './server/integrations.js';
import { createYemotRouter } from './server/yemot.js';
import { createCampaignYemotRouter } from './server/campaign-yemot.js';
import { campaignApiRouter } from './server/campaign-api.js';

const PRIORITIES = ['רגיל', 'דחוף', 'חשוב', 'להמשך'];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3900;

// גשר אירועים למודול המלאי העתידי: task.created / task.completed / problem.updated
export const events = new EventEmitter();

const app = express();
// מגבלת ברירת המחדל (100kb) קטנה מדי עבור לוגו ממותג וקובצי אקסל מיובאים בבסיס 64
app.use(express.json({ limit: '8mb' }));

// מודול המלאי כבוי — חוסמים גם כניסה ישירה לכתובת הדף, לפני הגשת הקבצים הסטטיים,
// כדי שלא ייפתח מסך שבור. ההפעלה מחדש היא בלשונית "חיבורים" אצל המנהלת.
app.get('/inventory.html', (req, res, next) => {
  if (inventoryEnabled()) return next();
  res.status(403).type('html').send(`<!DOCTYPE html><html lang="he" dir="rtl"><head><meta charset="UTF-8">
    <title>מודול המלאי כבוי</title>
    <style>body{font-family:system-ui,Arial;background:#0b2a4a;color:#fff;display:flex;align-items:center;
    justify-content:center;height:100vh;margin:0;text-align:center}
    .b{background:#fff;color:#0b2a4a;padding:40px 48px;border-radius:18px;max-width:520px}
    h1{margin:0 0 12px;font-size:1.6rem}p{font-size:1.1rem;line-height:1.7;color:#44546b}
    a{display:inline-block;margin-top:18px;background:#0b2a4a;color:#fff;text-decoration:none;
    padding:14px 28px;border-radius:999px;font-weight:700}</style></head>
    <body><div class="b"><h1>מודול המלאי וההשכרה כבוי כרגע</h1>
    <p>המערכת מוגדרת לעבוד עם ניהול המשימות בלבד.<br>
    להפעלה מחדש: כניסה כמנהלת ← לשונית <b>חיבורים</b> ← <b>מודול מלאי והשכרה</b>.</p>
    <a href="/">← למערכת המשימות</a></div></body></html>`);
});

app.use(express.static(path.join(__dirname, 'public')));

// --- זיהוי משתמשת (כותרת x-user-id שנשלחת מהדפדפן אחרי כניסה) ---
app.use((req, res, next) => {
  const uid = req.header('x-user-id');
  if (uid) req.user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(uid);
  next();
});
const mustLogin = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'נדרשת כניסה' }));
// פעולות ניהול רגילות — מנהלת ומעלה
const mustManager = (req, res, next) =>
  isManagerOrAbove(req.user?.role) ? next() : res.status(403).json({ error: 'פעולה למנהלת בלבד' });
// ניהול הרשאות ומשתמשות — דרגת העל בלבד
const mustTop = (req, res, next) =>
  isTop(req.user?.role) ? next() : res.status(403).json({ error: `פעולה ל${TOP_ROLE} בלבד` });
// אכיפת הרשאות לפי דרגה — לא רק הסתרה בממשק אלא חסימה אמיתית בשרת
const requireFeature = (feature) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'נדרשת כניסה' });
  if (hasFeature(req.user.role, feature)) return next();
  return res.status(403).json({ error: 'אין לך הרשאת גישה לאזור זה' });
};

// ---------- כניסה, יציאה ונוכחות ----------
app.post('/api/login', (req, res) => {
  const { code } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE code = ? AND active = 1').get(String(code || ''));
  if (!user) return res.status(401).json({ error: 'קוד עובדת שגוי' });
  const open = db.prepare('SELECT id FROM attendance WHERE user_id = ? AND check_out IS NULL').get(user.id);
  if (!open) {
    db.prepare(`INSERT INTO attendance(user_id, check_in) VALUES (?, datetime('now','localtime'))`).run(user.id);
  }
  audit(user.name, 'login', 'attendance', user.id);
  res.json({ id: user.id, name: user.name, role: user.role, features: featuresFor(user.role) });
});

// ---------- הרשאות גישה ----------
// האזורים המותרים למשתמשת הנוכחית (לבניית התפריט בצד הלקוח)
app.get('/api/permissions/me', mustLogin, (req, res) => {
  res.json({ role: req.user.role, features: featuresFor(req.user.role) });
});
// מטריצת ההרשאות המלאה — לעריכה במסך המנהלת
app.get('/api/permissions', mustLogin, mustTop, (req, res) => {
  res.json({ features: FEATURES, roles: ROLES, matrix: permissionMatrix() });
});
app.post('/api/permissions', mustLogin, mustTop, (req, res) => {
  const { role, feature, allowed } = req.body || {};
  if (!setPermission(role, feature, !!allowed))
    return res.status(400).json({ error: 'לא ניתן לעדכן הרשאה זו' });
  audit(req.user.name, 'permission.update', 'role_permission', `${role}/${feature}`, null, { allowed: !!allowed });
  res.json({ ok: true, matrix: permissionMatrix() });
});

app.post('/api/logout', mustLogin, (req, res) => {
  db.prepare(`UPDATE attendance SET check_out = datetime('now','localtime')
              WHERE user_id = ? AND check_out IS NULL`).run(req.user.id);
  audit(req.user.name, 'logout', 'attendance', req.user.id);
  res.json({ ok: true });
});

// ---------- הקשר עברי ----------
app.get('/api/context', (req, res) => {
  const info = hebInfo(new Date());
  res.json({ hdate: info.hdateStr, parsha: info.parsha, labels: info.labels, today: isoDate(new Date()) });
});

// ---------- משימות ----------
app.get('/api/tasks', mustLogin, (req, res) => {
  const scope = req.query.scope || 'today';
  const feat = { today: 'today', week: 'week', periodic: 'periodic' }[scope] || 'today';
  if (!hasFeature(req.user.role, feat)) return res.status(403).json({ error: 'אין לך הרשאת גישה לאזור זה' });
  const { info, rows } = tasksForScope(scope, new Date(), req.user);
  res.json({ labels: info.labels, tasks: rows });
});

// בדיקות משותפות לכל שינוי מצב של משימה. מחזיר מחרוזת שגיאה, או null אם מותר.
function taskChangeError(inst, user) {
  // מי שאינה מנהלת ומעלה לא יכולה לסמן משימת מנהלת או משימה אישית של מישהי אחרת
  if (!isManagerOrAbove(user.role)) {
    if ((inst.scope || DEFAULT_SCOPE) === 'מנהלת' || (inst.assignee && inst.assignee !== user.name))
      return { code: 403, error: 'אין לך גישה למשימה זו' };
  }
  // אי אפשר לסמן מראש משימה של מחר — היום והעבר מותרים
  if (inst.due_date && inst.due_date > isoDate(new Date())) {
    const [, mm, dd] = inst.due_date.split('-');
    return { code: 400, error: `לא ניתן לסמן משימה שמיועדת לתאריך עתידי (${dd}/${mm})` };
  }
  return null;
}

// שינוי מצב משימה. שלושה מצבים:
//   open        — פתוחה
//   done        — בוצעה
//   לא רלוונטי  — לא הייתה רלוונטית היום (למשל: לא היו מיילים דחופים). לא נחשבת כפיגור,
//                 ולא נספרת באחוזי הביצוע — לא בוצעה ולא נכשלה.
app.post('/api/tasks/:id/state', mustLogin, (req, res) => {
  const inst = db.prepare('SELECT * FROM task_instances WHERE id = ?').get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'משימה לא נמצאה' });
  const bad = taskChangeError(inst, req.user);
  if (bad) return res.status(bad.code).json({ error: bad.error });
  const { status, note } = req.body || {};
  const e = vEnum(status, 'מצב המשימה', TASK_STATUSES);
  if (e) return res.status(400).json({ error: e });

  const before = { status: inst.status, done_by: inst.done_by };
  if (status === 'open') {
    db.prepare(`UPDATE task_instances SET status='open', done_by=NULL, done_at=NULL WHERE id=?`).run(inst.id);
  } else {
    db.prepare(`UPDATE task_instances SET status=?, done_by=?, done_at=datetime('now','localtime'),
                note=COALESCE(?, note) WHERE id=?`)
      .run(status, req.user.name, note || null, inst.id);
    if (status === 'done') events.emit('task.completed', { id: inst.id, by: req.user.name });
  }
  const after = db.prepare('SELECT status, done_by, done_at FROM task_instances WHERE id = ?').get(inst.id);
  audit(req.user.name, 'task.state', 'task_instance', inst.id, before, after);
  res.json({ ok: true, task: { id: inst.id, ...after } });
});

app.post('/api/tasks/:id/toggle', mustLogin, (req, res) => {
  const inst = db.prepare('SELECT * FROM task_instances WHERE id = ?').get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'משימה לא נמצאה' });
  const bad = taskChangeError(inst, req.user);
  if (bad) return res.status(bad.code).json({ error: bad.error });
  const before = { status: inst.status, done_by: inst.done_by };
  if (inst.status === 'open') {
    db.prepare(`UPDATE task_instances SET status='done', done_by=?, done_at=datetime('now','localtime'), note=COALESCE(?, note)
                WHERE id=?`).run(req.user.name, req.body?.note || null, inst.id);
    events.emit('task.completed', { id: inst.id, by: req.user.name });
  } else {
    db.prepare(`UPDATE task_instances SET status='open', done_by=NULL, done_at=NULL WHERE id=?`).run(inst.id);
  }
  const after = db.prepare('SELECT status, done_by FROM task_instances WHERE id = ?').get(inst.id);
  audit(req.user.name, 'task.toggle', 'task_instance', inst.id, before, after);
  res.json({ ok: true });
});

// נעיצת משימה לראש הלוח (או ביטול נעיצה)
app.post('/api/tasks/:id/pin', mustLogin, (req, res) => {
  const inst = db.prepare('SELECT id, pinned FROM task_instances WHERE id = ?').get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'משימה לא נמצאה' });
  const pinned = req.body?.pinned === undefined ? !inst.pinned : !!req.body.pinned;
  db.prepare('UPDATE task_instances SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, inst.id);
  audit(req.user.name, 'task.pin', 'task_instance', inst.id, { pinned: !!inst.pinned }, { pinned });
  res.json({ ok: true, pinned });
});

// שינוי עדיפות (דחוף / חשוב / להמשך / רגיל)
app.post('/api/tasks/:id/priority', mustLogin, (req, res) => {
  const { priority } = req.body || {};
  if (!PRIORITIES.includes(priority)) return res.status(400).json({ error: 'עדיפות לא חוקית' });
  const inst = db.prepare('SELECT id, priority FROM task_instances WHERE id = ?').get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'משימה לא נמצאה' });
  db.prepare('UPDATE task_instances SET priority = ? WHERE id = ?').run(priority, inst.id);
  audit(req.user.name, 'task.priority', 'task_instance', inst.id, { priority: inst.priority }, { priority });
  res.json({ ok: true });
});

// משימה חד-פעמית ידנית
app.post('/api/tasks', mustLogin, (req, res) => {
  const { title, category = 'בקרה', due_date = null, priority = 'רגיל', assignee = null, scope = DEFAULT_SCOPE, description = null } = req.body || {};
  const vErr = firstError(
    vText(title, 'כותרת המשימה', { min: 2, max: 200 }),
    vText(category, 'קטגוריה', { max: 50 }),
    vDate(due_date, 'תאריך יעד', { required: false }),
    vEnum(priority, 'עדיפות', PRIORITIES, { required: false }),
    vText(description, 'תיאור', { required: false, max: 300 }),
  );
  if (vErr) return res.status(400).json({ error: vErr });
  const isMgr = isManagerOrAbove(req.user.role);
  // רק מנהלת קובעת שיוך ואחראית; עובדת יוצרת משימה בשיוך ברירת המחדל
  const useScope = isMgr && SCOPE_KEYS.includes(scope) ? scope : DEFAULT_SCOPE;
  const useAssignee = isMgr ? (assignee || null) : null;
  const r = db.prepare(`INSERT INTO task_instances(title, category, period_key, due_date, source, priority, assignee, scope, description)
                        VALUES (?,?,?,?,'manual',?,?,?,?)`)
    .run(title, category, 'once-' + Date.now(), due_date, PRIORITIES.includes(priority) ? priority : 'רגיל', useAssignee, useScope, description || null);
  audit(req.user.name, 'task.create', 'task_instance', r.lastInsertRowid, null, { title, scope: useScope });
  events.emit('task.created', { id: r.lastInsertRowid, title, source: 'manual' });
  res.json({ id: r.lastInsertRowid });
});

// רשימת השיוכים — לבניית הבוררים בממשק
app.get('/api/task-scopes', mustLogin, (req, res) => res.json(TASK_SCOPES));

// ---------- תבניות (ניהול) ----------
app.get('/api/templates', mustLogin, (req, res) => {
  res.json(db.prepare('SELECT * FROM task_templates ORDER BY frequency, sort').all());
});
app.post('/api/templates', mustLogin, mustManager, (req, res) => {
  const { title, category, frequency, role = 'מנהלת', priority = 'רגיל', assignee = null, scope = DEFAULT_SCOPE } = req.body || {};
  if (!title || !category || !frequency) return res.status(400).json({ error: 'חסרים פרטים' });
  const cErr = firstError(
    vText(title, 'כותרת המשימה', { min: 2, max: 200 }),
    vText(category, 'קטגוריה', { max: 50 }),
    vEnum(frequency, 'תדירות', FREQS),
    vEnum(scope, 'שיוך', SCOPE_KEYS, { required: false }),
    vEnum(priority, 'עדיפות', PRIORITIES, { required: false }),
    vText(assignee, 'אחראית', { required: false, max: 50 }),
  );
  if (cErr) return res.status(400).json({ error: cErr });
  const useScope = SCOPE_KEYS.includes(scope) ? scope : DEFAULT_SCOPE;
  const r = db.prepare(`INSERT INTO task_templates(title, category, frequency, role, priority, assignee, scope, sort)
                        VALUES (?,?,?,?,?,?,?, (SELECT COALESCE(MAX(sort),0)+1 FROM task_templates))`)
    .run(title, category, frequency, role, PRIORITIES.includes(priority) ? priority : 'רגיל', assignee || null, useScope);
  audit(req.user.name, 'template.create', 'task_template', r.lastInsertRowid, null, { title, frequency, scope: useScope });
  res.json({ id: r.lastInsertRowid });
});
// שיוך מרוכז של כמה תבניות בבת אחת — כדי לא לשנות 105 שורות אחת-אחת.
// מקבל רשימת מזהים + שיוך ו/או אחראית, ומעדכן גם את המופעים הפתוחים שלהן.
app.post('/api/templates/bulk', mustLogin, mustManager, (req, res) => {
  const { ids, scope, assignee } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'לא נבחרו תבניות' });
  if (scope === undefined && assignee === undefined)
    return res.status(400).json({ error: 'לא נבחר מה לעדכן (שיוך או אחראית)' });
  const err = firstError(
    scope !== undefined ? vEnum(scope, 'שיוך', SCOPE_KEYS) : null,
    assignee ? vText(assignee, 'אחראית', { required: false, max: 50 }) : null,
  );
  if (err) return res.status(400).json({ error: err });

  const clean = [...new Set(ids.map((n) => parseInt(n, 10)).filter(Number.isInteger))];
  if (!clean.length) return res.status(400).json({ error: 'רשימת התבניות אינה תקינה' });
  const marks = clean.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, scope, assignee FROM task_templates WHERE id IN (${marks})`).all(...clean);
  if (!rows.length) return res.status(404).json({ error: 'לא נמצאו תבניות מתאימות' });

  let changed = 0;
  db.transaction(() => {
    for (const t of rows) {
      const newScope = scope !== undefined ? scope : (t.scope || DEFAULT_SCOPE);
      const newAssignee = assignee !== undefined ? (assignee || null) : t.assignee;
      if (newScope === (t.scope || DEFAULT_SCOPE) && newAssignee === t.assignee) continue;
      db.prepare('UPDATE task_templates SET scope=?, assignee=? WHERE id=?').run(newScope, newAssignee, t.id);
      // גם המופעים הפתוחים מתעדכנים, אחרת הלוח של היום יישאר עם השיוך הישן
      db.prepare(`UPDATE task_instances SET scope=?, assignee=? WHERE template_id=? AND status='open'`)
        .run(newScope, newAssignee, t.id);
      changed++;
    }
  })();
  audit(req.user.name, 'template.bulk', 'task_template', clean.join(','), null,
        { count: changed, scope: scope ?? null, assignee: assignee ?? null });
  res.json({ ok: true, changed, requested: clean.length });
});

app.patch('/api/templates/:id', mustLogin, mustManager, (req, res) => {
  const tpl = db.prepare('SELECT * FROM task_templates WHERE id = ?').get(req.params.id);
  if (!tpl) return res.status(404).json({ error: 'לא נמצא' });
  const b = req.body || {};
  // ולידציה רק על שדות שנשלחו בפועל (PATCH חלקי)
  const err = firstError(
    b.title !== undefined ? vText(b.title, 'כותרת המשימה', { min: 2, max: 200 }) : null,
    b.category !== undefined ? vText(b.category, 'קטגוריה', { max: 50 }) : null,
    b.frequency !== undefined ? vEnum(b.frequency, 'תדירות', FREQS) : null,
    b.priority !== undefined ? vEnum(b.priority, 'עדיפות', PRIORITIES) : null,
    b.scope !== undefined ? vEnum(b.scope, 'שיוך', SCOPE_KEYS) : null,
    b.assignee ? vText(b.assignee, 'אחראית', { required: false, max: 50 }) : null,
  );
  if (err) return res.status(400).json({ error: err });
  const active = b.active !== undefined ? (b.active ? 1 : 0) : tpl.active;
  const title = b.title ?? tpl.title;
  const category = b.category ?? tpl.category;
  const frequency = b.frequency ?? tpl.frequency;
  const priority = PRIORITIES.includes(b.priority) ? b.priority : tpl.priority;
  const scope = SCOPE_KEYS.includes(b.scope) ? b.scope : (tpl.scope || DEFAULT_SCOPE);
  const assignee = b.assignee !== undefined ? (b.assignee || null) : tpl.assignee;
  db.prepare('UPDATE task_templates SET active=?, title=?, category=?, frequency=?, priority=?, scope=?, assignee=? WHERE id=?')
    .run(active, title, category, frequency, priority, scope, assignee, tpl.id);
  // עדכון כותרת/עדיפות/שיוך גם למופעים פתוחים קיימים של התבנית
  if (priority !== tpl.priority) db.prepare(`UPDATE task_instances SET priority=? WHERE template_id=? AND status='open'`).run(priority, tpl.id);
  if (scope !== (tpl.scope || DEFAULT_SCOPE)) db.prepare(`UPDATE task_instances SET scope=? WHERE template_id=? AND status='open'`).run(scope, tpl.id);
  if (assignee !== tpl.assignee) db.prepare(`UPDATE task_instances SET assignee=? WHERE template_id=? AND status='open'`).run(assignee, tpl.id);
  // השבתת תבנית מסירה גם את המופעים ה**פתוחים** שכבר נוצרו ממנה.
  // בלי זה, משימה שהושבתה המשיכה להופיע על הלוח עד סוף היום — כי המופע של היום
  // כבר נוצר לפני ההשבתה, וההשבתה מנעה רק יצירה של מופעים חדשים.
  // מופעים שכבר בוצעו נשמרים — הם היסטוריה ולא נמחקים.
  let removed = 0;
  if (active === 0 && tpl.active === 1) {
    removed = db.prepare(`DELETE FROM task_instances WHERE template_id = ? AND status = 'open'`).run(tpl.id).changes;
  }
  // הפעלה מחדש — המופעים לתקופה הנוכחית נוצרים מיד ולא רק מחר
  if (active === 1 && tpl.active === 0) ensureInstances();
  audit(req.user.name, 'template.update', 'task_template', tpl.id,
    { active: tpl.active, title: tpl.title, category: tpl.category, frequency: tpl.frequency,
      priority: tpl.priority, scope: tpl.scope, assignee: tpl.assignee },
    { active, title, category, frequency, priority, scope, assignee, removed_instances: removed });
  res.json({ ok: true, removed, template: db.prepare('SELECT * FROM task_templates WHERE id = ?').get(tpl.id) });
});

// ---------- לוח שנה ----------
app.get('/api/calendar', mustLogin, requireFeature('calendar'), (req, res) => {
  const now = new Date();
  const y = parseInt(req.query.y) || now.getFullYear();
  const m = parseInt(req.query.m) || now.getMonth() + 1; // 1-12
  const first = new Date(y, m - 1, 1);
  const last = new Date(y, m, 0);
  const todayIso = isoDate(now);

  // יצירת מופעים לימים שנותרו בחודש המוצג, כדי שהלוח יציג גם את הצפוי
  const gen = new Date(Math.max(first, new Date(now.getFullYear(), now.getMonth(), now.getDate())));
  while (gen <= last) { ensureInstances(new Date(gen)); gen.setDate(gen.getDate() + 1); }

  const fromIso = isoDate(first), toIso = isoDate(last);
  const vis = visibilityClause(req.user);
  const items = db.prepare(`
    SELECT i.id, 'task' AS type, COALESCE(i.title, t.title) AS title,
           COALESCE(i.category, t.category) AS category,
           i.description, i.assignee, COALESCE(i.scope, '${DEFAULT_SCOPE}') AS scope,
           i.status, COALESCE(i.priority,'רגיל') AS priority, i.due_date, i.source,
           COALESCE(t.frequency,'once') AS frequency
    FROM task_instances i LEFT JOIN task_templates t ON t.id = i.template_id
    WHERE i.due_date BETWEEN ? AND ?
      ${vis.sql}
    ORDER BY CASE COALESCE(i.priority,'רגיל')
      WHEN 'דחוף' THEN 0 WHEN 'חשוב' THEN 1 WHEN 'רגיל' THEN 2 ELSE 3 END, i.id`).all(fromIso, toIso, ...vis.params);
  const problems = db.prepare(`
    SELECT id, 'problem' AS type, title, status, due_date FROM problems
    WHERE due_date BETWEEN ? AND ? AND status != 'נבדק'`).all(fromIso, toIso);

  const byDate = {};
  [...items, ...problems].forEach((it) => (byDate[it.due_date] = byDate[it.due_date] || []).push(it));

  // ימים מיוחדים — לצביעה בממשק (blocks=1 מתנהג כמו חג: לא נוצרות בו משימות)
  const specialByDate = {};
  db.prepare('SELECT id, date, title, blocks FROM special_days WHERE date BETWEEN ? AND ?')
    .all(fromIso, toIso)
    .forEach((s) => (specialByDate[s.date] = { id: s.id, title: s.title, blocks: s.blocks }));

  const days = [];
  for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
    const ds = isoDate(d);
    days.push({
      date: ds, dow: d.getDay(), day: d.getDate(),
      isToday: ds === todayIso,
      ...dayInfo(new Date(d)),
      special: specialByDate[ds] || null,
      items: byDate[ds] || [],
    });
  }
  res.json({
    year: y, month: m,
    hebTitle: hebMonthTitle(first, last),
    days,
  });
});

// ---------- לוח טיפול בבעיות (6 השלבים) ----------
const PROBLEM_STATUSES = ['פתוח', 'בטיפול', 'הוחלט', 'בוצע', 'נבדק'];
app.get('/api/problems', mustLogin, requireFeature('problems'), (req, res) => {
  res.json(db.prepare(`SELECT * FROM problems ORDER BY
    CASE status WHEN 'נבדק' THEN 1 ELSE 0 END, due_date IS NULL, due_date, id DESC`).all());
});
app.post('/api/problems', mustLogin, requireFeature('problems'), (req, res) => {
  // כל שדות תהליך 6 השלבים נשמרים כבר ביצירה. קודם נשמרו רק כותרת/פירוט/מקור,
  // וכל מה שהוקלד בשדות הגורם/המניעה/ההחלטה נמחק בשקט בשמירה.
  const { title, details, source_type, cause, prevention, decision,
          due_date, status } = req.body || {};
  const err = firstError(
    vText(title, 'תיאור הבעיה', { min: 3, max: 200 }),
    vText(details, 'פירוט', { required: false, max: 1000 }),
    vEnum(source_type, 'מקור', ['זוהה עצמאית', 'עובדת', 'מתנדבת', 'לקוחה'], { required: false }),
    vText(cause, 'הגורם לבעיה', { required: false, max: 1000 }),
    vText(prevention, 'מסקנות למניעה', { required: false, max: 1000 }),
    vText(decision, 'מה הוחלט', { required: false, max: 1000 }),
    vDate(due_date, 'תאריך יעד', { required: false }),
    vEnum(status, 'סטטוס', PROBLEM_STATUSES, { required: false }),
  );
  if (err) return res.status(400).json({ error: err });
  // אותו כלל כמו בעדכון: "נבדק" מחייב החלטה ותאריך יעד
  if (status === 'נבדק' && (!decision || !due_date))
    return res.status(400).json({ error: 'לפני "נבדק" חובה למלא החלטה ותאריך יעד' });
  const r = db.prepare(`INSERT INTO problems(title, details, source_type, cause, prevention,
                        decision, due_date, status, created_by) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(title, details || null, source_type || 'זוהה עצמאית', cause || null, prevention || null,
         decision || null, due_date || null, status || 'פתוח', req.user.name);
  audit(req.user.name, 'problem.create', 'problem', r.lastInsertRowid, null,
        { title, status: status || 'פתוח', due_date: due_date || null });
  events.emit('problem.created', { id: r.lastInsertRowid, title });
  res.json({ id: r.lastInsertRowid });
});
app.patch('/api/problems/:id', mustLogin, requireFeature('problems'), (req, res) => {
  const p = db.prepare('SELECT * FROM problems WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'לא נמצא' });
  const b = req.body || {};
  if (b.status && !PROBLEM_STATUSES.includes(b.status)) return res.status(400).json({ error: 'סטטוס לא חוקי' });
  // אי אפשר לסמן "נבדק" בלי החלטה ותאריך יעד — לפי תהליך 6 השלבים
  const decision = b.decision ?? p.decision, due = b.due_date ?? p.due_date;
  if (b.status === 'נבדק' && (!decision || !due))
    return res.status(400).json({ error: 'לפני "נבדק" חובה למלא החלטה ותאריך יעד' });
  const upd = {
    title: b.title ?? p.title, details: b.details ?? p.details, source_type: b.source_type ?? p.source_type,
    cause: b.cause ?? p.cause, prevention: b.prevention ?? p.prevention,
    decision, due_date: due, status: b.status ?? p.status,
  };
  db.prepare(`UPDATE problems SET title=@title, details=@details, source_type=@source_type, cause=@cause,
              prevention=@prevention, decision=@decision, due_date=@due_date, status=@status,
              updated_at=datetime('now','localtime') WHERE id=${p.id}`).run(upd);
  audit(req.user.name, 'problem.update', 'problem', p.id, p, upd);
  events.emit('problem.updated', { id: p.id, status: upd.status });
  res.json({ ok: true });
});

// ---------- העברת משמרות ----------
const HANDOVER_AUDIENCES = ['next', 'all'];
// הערה פעילה = טרם אושרה, או שהיא לכל המשמרות (כזאת נשארת מוצגת גם אחרי אישור)
const HANDOVER_OPEN_SQL = `(acked_at IS NULL OR COALESCE(audience,'next') = 'all')`;
// אבל למונה: הערה נספרת רק אם *המשתמשת הנוכחית* עוד לא אישרה אותה בעצמה.
// כך המונה מגיע ל-0 ולא נתקע לנצח בגלל הערת 'all' אחת.
const HANDOVER_UNACKED_BY_ME_SQL = `
  (${HANDOVER_OPEN_SQL})
  AND NOT EXISTS (SELECT 1 FROM handover_acks a WHERE a.handover_id = handovers.id AND a.user_name = ?)`;

// שדות ההערה + אישור הקריאה האישי של המשתמשת הנוכחית
const HANDOVER_COLS = `id, user_name, shift_date, notes, created_at,
        COALESCE(audience,'next') AS audience, acked_by, acked_at,
        (SELECT a.acked_at FROM handover_acks a WHERE a.handover_id = handovers.id AND a.user_name = ?) AS my_acked_at`;

app.get('/api/handovers', mustLogin, requireFeature('handover'), (req, res) => {
  const onlyOpen = String(req.query.open || '') === '1';
  res.json(db.prepare(`SELECT ${HANDOVER_COLS}
                       FROM handovers ${onlyOpen ? 'WHERE ' + HANDOVER_OPEN_SQL : ''}
                       ORDER BY id DESC LIMIT 30`).all(req.user.name));
});
app.post('/api/handovers', mustLogin, requireFeature('handover'), (req, res) => {
  const { notes, audience = 'next' } = req.body || {};
  if (!notes) return res.status(400).json({ error: 'אין תוכן' });
  const err = vEnum(audience, 'קהל יעד', HANDOVER_AUDIENCES);
  if (err) return res.status(400).json({ error: err });
  const r = db.prepare('INSERT INTO handovers(user_name, shift_date, notes, audience) VALUES (?,?,?,?)')
    .run(req.user.name, isoDate(new Date()), notes, audience);
  audit(req.user.name, 'handover.create', 'handover', r.lastInsertRowid, null, { audience });
  res.json({ id: r.lastInsertRowid, audience });
});
// אישור קריאה — הערה ל"משמרת הבאה" יוצאת מהרשימה הפעילה; הערה "לכל המשמרות" נשארת
app.post('/api/handovers/:id/ack', mustLogin, requireFeature('handover'), (req, res) => {
  const h = db.prepare('SELECT * FROM handovers WHERE id = ?').get(req.params.id);
  if (!h) return res.status(404).json({ error: 'הערת משמרת לא נמצאה' });
  db.prepare(`UPDATE handovers SET acked_by=?, acked_at=datetime('now','localtime') WHERE id=?`)
    .run(req.user.name, h.id);
  db.prepare(`INSERT OR REPLACE INTO handover_acks(handover_id, user_name, acked_at)
              VALUES (?,?,datetime('now','localtime'))`).run(h.id, req.user.name);
  audit(req.user.name, 'handover.ack', 'handover', h.id, { acked_by: h.acked_by }, { acked_by: req.user.name });
  res.json(db.prepare(`SELECT ${HANDOVER_COLS} FROM handovers WHERE id = ?`).get(req.user.name, h.id));
});

// ---------- הודעות פנימיות ----------
// היסטוריית ההודעות גלויה למנהלת בלבד; שאר התפקידים רק כותבים
app.get('/api/messages', mustLogin, mustManager, (req, res) => {
  res.json(db.prepare("SELECT * FROM messages WHERE kind = 'report' ORDER BY handled_at IS NOT NULL, id DESC LIMIT 50").all());
});
app.post('/api/messages', mustLogin, requireFeature('messages'), (req, res) => {
  const { body } = req.body || {};
  if (!body) return res.status(400).json({ error: 'אין תוכן' });
  const r = db.prepare('INSERT INTO messages(from_user, body) VALUES (?,?)').run(req.user.name, body);
  res.json({ id: r.lastInsertRowid });
});
// היסטוריה אישית — כל מה שהמשתמשת המחוברת שלחה, קיבלה אישית, או הכרזות כלליות שראתה. כמו תיבת מייל.
app.get('/api/messages/mine', mustLogin, requireFeature('messages'), (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM messages
    WHERE from_user = ? OR to_user = ? OR (to_user IS NULL AND kind = 'announcement')
    ORDER BY id DESC LIMIT 150
  `).all(req.user.name, req.user.name);
  res.json(rows);
});
app.patch('/api/messages/:id/handle', mustLogin, mustManager, (req, res) => {
  db.prepare(`UPDATE messages SET handled_by=?, handled_at=datetime('now','localtime') WHERE id=?`)
    .run(req.user.name, req.params.id);
  res.json({ ok: true });
});

// תגובה להודעה — מוצגת כבאנר בראש האתר אצל מי ששלחה, וגם מסמנת את ההודעה המקורית כטופלה.
// מנהלת יכולה להשיב לכל הודעה (כולל דיווח מקורי); כל משתמשת אחרת יכולה להשיב רק להודעה שהופנתה אליה
// (כתגובה לבאנר שקיבלה) או להודעה כללית לכולם — כדי שהבאנר יהפוך לשיחה דו-כיוונית ולא רק תצוגה חד-פעמית.
app.post('/api/messages/:id/reply', mustLogin, (req, res) => {
  const text = (req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'אין תוכן לתגובה' });
  const original = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!original) return res.status(404).json({ error: 'ההודעה לא נמצאה' });
  // "to_user is null" חייב להתייחס רק להכרזה כללית (announcement) — דיווח מקורי (report) גם הוא עם to_user ריק כברירת מחדל,
  // אבל אסור שזה יאפשר לכל אחת להשיב לדיווח שלא מופנה אליה
  const isRecipient = original.kind === 'announcement' && (original.to_user === req.user.name || original.to_user === null);
  if (!isRecipient && !isManagerOrAbove(req.user.role)) return res.status(403).json({ error: 'אין לך גישה להשיב להודעה זו' });
  const r = db.prepare(`INSERT INTO messages(from_user, body, kind, to_user, reply_to) VALUES (?, ?, 'announcement', ?, ?)`)
    .run(req.user.name, text, original.from_user, original.id);
  db.prepare(`UPDATE messages SET handled_by = ?, handled_at = datetime('now','localtime') WHERE id = ? AND handled_at IS NULL`)
    .run(req.user.name, original.id);
  audit(req.user.name, 'message.reply', 'messages', r.lastInsertRowid, null, { to: original.from_user, body: text });
  res.json({ id: r.lastInsertRowid });
});

// הכרזה כללית — לכולם (to_user ריק) או למשתמשת ספציפית. פתוח לכל מי שיש לה גישה למערכת, לא רק מנהלת
app.post('/api/messages/broadcast', mustLogin, requireFeature('messages'), (req, res) => {
  const text = (req.body?.text || '').trim();
  const toUser = (req.body?.to_user || '').trim() || null;
  if (!text) return res.status(400).json({ error: 'אין תוכן להודעה' });
  const r = db.prepare(`INSERT INTO messages(from_user, body, kind, to_user) VALUES (?, ?, 'announcement', ?)`)
    .run(req.user.name, text, toUser);
  audit(req.user.name, 'message.broadcast', 'messages', r.lastInsertRowid, null, { to: toUser || 'הכול', body: text });
  res.json({ id: r.lastInsertRowid });
});

// הודעות שעדיין לא נסגרו עבור המשתמשת המחוברת — להצגה כבאנר בראש האתר
app.get('/api/messages/banner', mustLogin, (req, res) => {
  const rows = db.prepare(`
    SELECT m.* FROM messages m
    WHERE m.kind = 'announcement' AND m.from_user != ?
      AND (m.to_user = ? OR m.to_user IS NULL)
      AND m.id NOT IN (SELECT message_id FROM message_dismissals WHERE user_name = ?)
    ORDER BY m.id DESC LIMIT 5
  `).all(req.user.name, req.user.name, req.user.name);
  res.json(rows);
});
app.post('/api/messages/:id/dismiss', mustLogin, (req, res) => {
  db.prepare('INSERT OR IGNORE INTO message_dismissals (message_id, user_name) VALUES (?, ?)')
    .run(req.params.id, req.user.name);
  res.json({ ok: true });
});

// רשימת שמות הצוות — לשיוך משימות ולבחירת נמענת להודעה. פתוח לכל מחוברת (לא רק מנהלת)
// כדי שכל מי שיש לה גישה למערכת תוכל לשלוח הודעה למישהי ספציפית
app.get('/api/users/names', mustLogin, (req, res) => {
  res.json(db.prepare(`SELECT name FROM users WHERE active = 1 AND role != 'מתנדבת' ORDER BY name`).all().map((u) => u.name));
});

// ---------- מונים להתראות בתפריט ----------
// מחזיר כמות פריטים חדשים/לא מטופלים בכל אזור. אין הרשאה לאזור → 0.
app.get('/api/counters', mustLogin, (req, res) => {
  const role = req.user.role;
  const problems = hasFeature(role, 'problems')
    ? db.prepare(`SELECT COUNT(*) c FROM problems WHERE status = 'פתוח'`).get().c : 0;
  // היסטוריית ההודעות גלויה למנהלת ומעלה בלבד — ולכן גם המונה
  const messages = (hasFeature(role, 'messages') && isManagerOrAbove(role))
    ? db.prepare(`SELECT COUNT(*) c FROM messages WHERE handled_at IS NULL AND kind = 'report'`).get().c : 0;
  const handover = hasFeature(role, 'handover')
    ? db.prepare(`SELECT COUNT(*) c FROM handovers WHERE ${HANDOVER_UNACKED_BY_ME_SQL}`).get(req.user.name).c : 0;
  res.json({ problems, messages, handover });
});

// ---------- ימים מיוחדים ביומן (אירועים / סגירה) ----------
app.get('/api/special-days', mustLogin, (req, res) => {
  const { from, to } = req.query;
  const err = firstError(
    vDate(from, 'מתאריך', { required: false }),
    vDate(to, 'עד תאריך', { required: false }),
  );
  if (err) return res.status(400).json({ error: err });
  const where = [], params = [];
  if (from) { where.push('date >= ?'); params.push(from); }
  if (to) { where.push('date <= ?'); params.push(to); }
  res.json(db.prepare(`SELECT * FROM special_days ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                       ORDER BY date`).all(...params));
});
app.post('/api/special-days', mustLogin, mustManager, (req, res) => {
  const { date, title, blocks = 1 } = req.body || {};
  const err = firstError(
    vDate(date, 'תאריך'),
    vText(title, 'שם האירוע', { min: 2, max: 100 }),
  );
  if (err) return res.status(400).json({ error: err });
  try {
    const r = db.prepare('INSERT INTO special_days(date, title, blocks, created_by) VALUES (?,?,?,?)')
      .run(date, String(title).trim(), blocks ? 1 : 0, req.user.name);
    audit(req.user.name, 'special_day.create', 'special_day', r.lastInsertRowid, null, { date, title, blocks: blocks ? 1 : 0 });
    res.json({ id: r.lastInsertRowid, date, title: String(title).trim(), blocks: blocks ? 1 : 0 });
  } catch { res.status(400).json({ error: 'כבר מוגדר אירוע לתאריך הזה' }); }
});
app.delete('/api/special-days/:id', mustLogin, mustManager, (req, res) => {
  const sd = db.prepare('SELECT * FROM special_days WHERE id = ?').get(req.params.id);
  if (!sd) return res.status(404).json({ error: 'לא נמצא' });
  db.prepare('DELETE FROM special_days WHERE id = ?').run(sd.id);
  audit(req.user.name, 'special_day.delete', 'special_day', sd.id, sd, null);
  res.json({ ok: true });
});

// ---------- ניהול משתמשות ----------
app.get('/api/users', mustLogin, mustTop, (req, res) => {
  res.json(db.prepare('SELECT id, name, role, code, active FROM users').all());
});
app.post('/api/users', mustLogin, mustTop, (req, res) => {
  const { name, role = 'אחמ"שית', code } = req.body || {};
  const err = firstError(
    vText(name, 'שם העובדת', { min: 2, max: 50 }),
    vEnum(role, 'תפקיד', ROLES),
    vText(code, 'קוד כניסה', { min: 3, max: 10 }),
    !/^\d+$/.test(String(code || '').trim()) ? 'קוד כניסה — ספרות בלבד (לפחות 3)' : null,
  );
  if (err) return res.status(400).json({ error: err });
  try {
    const r = db.prepare('INSERT INTO users(name, role, code) VALUES (?,?,?)').run(name, role, String(code));
    audit(req.user.name, 'user.create', 'user', r.lastInsertRowid, null, { name, role });
    res.json({ id: r.lastInsertRowid });
  } catch { res.status(400).json({ error: 'הקוד כבר קיים' }); }
});
// עדכון עובדת — שם / תפקיד / קוד כניסה / פעילה. לדרגת העל בלבד.
// שינוי הקוד חיוני: קוד הגיבוי נוצר אוטומטית וחייב להיות ניתן להחלפה.
app.patch('/api/users/:id', mustLogin, mustTop, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'עובדת לא נמצאה' });
  const { name, role, code, active } = req.body || {};
  const err = firstError(
    name !== undefined ? vText(name, 'שם העובדת', { min: 2, max: 50 }) : null,
    role !== undefined ? vEnum(role, 'תפקיד', ROLES) : null,
    code !== undefined ? firstError(
      vText(code, 'קוד כניסה', { min: 3, max: 10 }),
      !/^\d+$/.test(String(code || '').trim()) ? 'קוד כניסה — ספרות בלבד (לפחות 3)' : null,
    ) : null,
  );
  if (err) return res.status(400).json({ error: err });
  // הגנה: אסור להישאר בלי אף כניסה פעילה לדרגת העל — זו נעילה שאין ממנה חזרה
  const losesTop = (role !== undefined && role !== TOP_ROLE) || active === 0 || active === false;
  if (u.role === TOP_ROLE && losesTop) {
    const others = db.prepare('SELECT COUNT(*) c FROM users WHERE role = ? AND active = 1 AND id != ?')
      .get(TOP_ROLE, u.id).c;
    if (!others) return res.status(400).json({ error: `זו הכניסה האחרונה בדרגת ${TOP_ROLE} — ביטולה ינעל את מסך ההרשאות. צרי קודם כניסה נוספת` });
  }
  const before = { name: u.name, role: u.role, active: u.active };
  try {
    db.prepare(`UPDATE users SET name = COALESCE(?, name), role = COALESCE(?, role),
                code = COALESCE(?, code), active = COALESCE(?, active) WHERE id = ?`)
      .run(name ?? null, role ?? null, code !== undefined ? String(code).trim() : null,
           active === undefined ? null : (active ? 1 : 0), u.id);
  } catch { return res.status(400).json({ error: 'הקוד כבר קיים אצל עובדת אחרת' }); }
  const after = db.prepare('SELECT id, name, role, code, active FROM users WHERE id = ?').get(u.id);
  // הקוד עצמו לא נכתב ליומן הפעולות
  audit(req.user.name, 'user.update', 'user', u.id, before,
        { name: after.name, role: after.role, active: after.active, code_changed: code !== undefined });
  res.json({ ok: true, user: after });
});

// ---------- דוחות ----------
app.get('/api/reports/summary', mustLogin, mustManager, (req, res) => {
  const byCat = db.prepare(`
    SELECT COALESCE(i.category, t.category) AS category,
           COUNT(*) AS total, SUM(i.status='done') AS done
    FROM task_instances i LEFT JOIN task_templates t ON t.id = i.template_id
    WHERE i.created_at >= date('now','-30 days')
      AND i.due_date <= date('now','localtime')
      -- משימות שסומנו "לא רלוונטי" יוצאות מהחישוב לגמרי: הן לא בוצעו ולא נכשלו,
      -- וספירתן כפיגור הייתה מציגה אחוזי ביצוע נמוכים מהאמת
      AND i.status != ?
    GROUP BY 1 ORDER BY total DESC`).all(TASK_IRRELEVANT);
  const attendance = db.prepare(`
    SELECT u.name, a.check_in, a.check_out FROM attendance a JOIN users u ON u.id = a.user_id
    ORDER BY a.id DESC LIMIT 40`).all();
  const auditTail = db.prepare('SELECT user_name, action, entity, at FROM audit_log ORDER BY id DESC LIMIT 30').all();
  res.json({ byCat, attendance, auditTail });
});

// ---------- מודול מלאי והשכרה ----------
app.use('/api/inv', requireFeature('inventory'), inventoryRouter({ mustLogin, mustManager, events }));

// ---------- קמפיין המכירה הסינית (אמא במשמרת) ----------
app.use('/api/campaign', requireFeature('campaign'), campaignApiRouter({ mustLogin, mustManager, events }));
app.use('/yemot-campaign', createCampaignYemotRouter({ events }));

// ---------- לוח מנהלת ----------
app.get('/api/dashboard', mustLogin, requireFeature('dashboard'), (req, res) => {
  ensureInstances();
  const today = isoDate(new Date());
  // "לא רלוונטי" לא נספרת לא במונה ולא במכנה — מוצגת בנפרד
  const t = db.prepare(`SELECT COUNT(*) total, COALESCE(SUM(status='done'),0) done
                        FROM task_instances WHERE due_date = ? AND status != ?`).get(today, TASK_IRRELEVANT);
  t.irrelevant = db.prepare(`SELECT COUNT(*) c FROM task_instances WHERE due_date = ? AND status = ?`)
    .get(today, TASK_IRRELEVANT).c;
  const overdue = db.prepare(`SELECT COUNT(*) c FROM task_instances
                              WHERE status='open' AND due_date IS NOT NULL AND due_date < ?`).get(today).c;
  const problemsByStatus = db.prepare(`SELECT status, COUNT(*) c FROM problems GROUP BY status`).all();
  const openProblems = db.prepare(`SELECT COUNT(*) c FROM problems WHERE status != 'נבדק'`).get().c;
  const problemsOverdue = db.prepare(`SELECT COUNT(*) c FROM problems
                                      WHERE status NOT IN ('נבדק','בוצע') AND due_date IS NOT NULL AND due_date < ?`).get(today).c;
  const onShift = db.prepare(`SELECT u.name, u.role, a.check_in FROM attendance a
                              JOIN users u ON u.id = a.user_id WHERE a.check_out IS NULL ORDER BY a.check_in`).all();
  const team = db.prepare(`SELECT role, COUNT(*) c FROM users WHERE active = 1 GROUP BY role`).all();
  const unhandledMsgs = db.prepare(`SELECT COUNT(*) c FROM messages WHERE handled_at IS NULL AND kind = 'report'`).get().c;
  const auditTail = db.prepare(`SELECT user_name, action, entity, at FROM audit_log ORDER BY id DESC LIMIT 10`).all();
  const catPerf = db.prepare(`
    SELECT COALESCE(i.category, t.category) AS category,
           COUNT(*) AS total, COALESCE(SUM(i.status='done'),0) AS done
    FROM task_instances i LEFT JOIN task_templates t ON t.id = i.template_id
    WHERE i.due_date = ? AND i.status != ? GROUP BY 1 ORDER BY total DESC`).all(today, TASK_IRRELEVANT);
  res.json({ today: t, overdue, problemsByStatus, openProblems, problemsOverdue,
             onShift, team, unhandledMsgs, auditTail, catPerf });
});

// ---------- חיבורים: מייל, עוזרת AI, גיבוי לענן ----------
app.use('/api/integrations', integrationsRouter({ mustLogin, mustManager, requireFeature }));

// ---------- חיבור למערכת ימות המשיח (שלוחה טלפונית ללקוחות) ----------
app.use('/yemot', createYemotRouter());

// ---------- ממשק אינטגרציה למודול המלאי העתידי ----------
// POST עם uniq_key — קריאה חוזרת עם אותו מפתח לא תיצור כפילות.
app.post('/api/integration/tasks', (req, res) => {
  const { title, category = 'בקרה', due_date = null, uniq_key, priority = 'דחוף' } = req.body || {};
  if (!title || !uniq_key) return res.status(400).json({ error: 'title ו-uniq_key חובה' });
  const exists = db.prepare('SELECT id FROM task_instances WHERE uniq_key = ?').get(uniq_key);
  if (exists) return res.json({ id: exists.id, existed: true });
  const r = db.prepare(`INSERT INTO task_instances(title, category, period_key, due_date, source, uniq_key, priority)
                        VALUES (?,?,?,?,'inventory',?,?)`)
    .run(title, category, 'auto-' + uniq_key, due_date, uniq_key, PRIORITIES.includes(priority) ? priority : 'דחוף');
  audit('inventory-module', 'task.create.auto', 'task_instance', r.lastInsertRowid, null, { title, uniq_key });
  events.emit('task.created', { id: r.lastInsertRowid, title, source: 'inventory' });
  res.json({ id: r.lastInsertRowid, existed: false });
});
app.get('/api/integration/health', (req, res) => res.json({ ok: true, module: 'tasks', version: 1 }));

// יצירת מופעים להיום בעת עליית השרת + תזמון גיבוי אוטומטי
ensureInstances();
scheduleAutoBackup();
scheduleDailyReport();
app.listen(PORT, () => console.log(`מערכת אמא במשמרת עלתה על http://localhost:${PORT}`));
