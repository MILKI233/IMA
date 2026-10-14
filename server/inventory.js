import { Router } from 'express';
import { db, audit, getSetting } from './db.js';
import { vText, vTz, vPhone, vEmail, vDate, vAmount, vBarcode, vEnum, firstError } from './validate.js';
import { createAutoTask } from './tasks.js';
import { isoDate, pickupDate, returnDate } from './hebrew.js';

const ITEM_STATUSES = ['זמין', 'מושכר', 'בכביסה', 'בתיקון', 'לא תקין', 'נגרע'];
// אמצעי תשלום. "שובר מתנה" — למתנדבות/משפחות שמקבלות בחינם; אינו נכנס ליתרת הקופה.
const PAY_METHODS = ['מזומן', 'אשראי', 'שובר מתנה'];
const VOUCHER_METHOD = 'שובר מתנה';
// יום נוסף להזמנה מראש = 50% ממחיר השמלות בהזמנה
const EXTRA_DAY_RATE = 0.5;
const MAX_EXTRA_DAYS = 7;
const round2 = (n) => Math.round(n * 100) / 100;
// "החזרות" — הזמנות שנמסרו והשמלות עדיין אצל הלקוחה, ממתינות לחזור
const RETURNS_WHERE = `o.status = 'נמסרה'
  AND EXISTS (SELECT 1 FROM order_items x WHERE x.order_id = o.id AND x.status IN ('נמסר','החזרה מאוחרת'))`;

// אימות זהות לשינוי הזמנה: מספר הזמנה + ת"ז או טלפון של המזמינה (דרישת אפיון)
function verifyOrderAccess(orderId, idOrPhone) {
  if (!idOrPhone) return null;
  const o = db.prepare(`
    SELECT o.*, c.tz, c.phone, c.name AS customer_name FROM orders o
    JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`).get(orderId);
  if (!o) return null;
  const v = String(idOrPhone).replace(/[^\d]/g, '');
  const tz = String(o.tz || '').replace(/[^\d]/g, '');
  const phone = String(o.phone || '').replace(/[^\d]/g, '');
  return (v && (v === tz || v === phone)) ? o : null;
}

function appendCustomerNote(customerId, note) {
  const stamp = isoDate(new Date());
  db.prepare(`UPDATE customers SET notes = TRIM(COALESCE(notes,'') || CASE WHEN COALESCE(notes,'')='' THEN '' ELSE char(10) END || ?)
              WHERE id = ?`).run(`[${stamp}] ${note}`, customerId);
}

// בדיקת זמינות פריט בטווח תאריכים
function itemConflicts(itemId, pickup, ret, excludeOrderId = null) {
  return db.prepare(`
    SELECT o.id, o.pickup_date, o.return_date FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE oi.item_id = ? AND oi.status IN ('משוריין','נמסר')
      AND o.status IN ('שריון','נמסרה')
      AND NOT (o.return_date < ? OR o.pickup_date > ?)
      ${excludeOrderId ? 'AND o.id != ' + Number(excludeOrderId) : ''}`)
    .all(itemId, pickup, ret);
}

// ---------- שריון לפי דגם + מידה ----------
// הברקוד בנוי: [קוד דגם][מידה 2 ספרות][מס' סידורי 2 ספרות]. למשל 5331001 = דגם 533, מידה 10, סידורי 01.
// הלקוחה מזמינה דגם ומידה — לא שמלה ספציפית. השמלה הפיזית משויכת רק במסירה.
function resolveModelSize(barcode) {
  const bc = String(barcode || '').trim();
  if (!bc) return null;
  // עדיפות ראשונה: הברקוד קיים במלאי — הדגם והמידה נלקחים ממנו ישירות
  const item = db.prepare(`
    SELECT i.size AS item_size, m.* FROM items i JOIN models m ON m.id = i.model_id
    WHERE i.barcode = ? AND i.active = 1`).get(bc);
  if (item) {
    const { item_size, ...model } = item;
    return { model, size: item_size, viaItem: true };
  }
  // אחרת: פירוק הברקוד לפי המבנה
  const digits = bc.replace(/\D/g, '');
  if (digits.length >= 5) {
    const model = db.prepare('SELECT * FROM models WHERE code = ? AND active = 1').get(digits.slice(0, -4));
    if (model) return { model, size: String(parseInt(digits.slice(-4, -2), 10)), viaItem: false };
  }
  return null;
}

// כמה שמלות מדגם+מידה קיימות פיזית מול כמה משוריינות בטווח התאריכים
function modelSizeAvailability(modelId, size, pickup, ret, excludeOrderId = null) {
  const s = String(size ?? '').trim();
  const physical = db.prepare(`
    SELECT COUNT(*) c FROM items
    WHERE model_id = ? AND CAST(TRIM(COALESCE(size,'')) AS TEXT) IN (?, ?)
      AND active = 1 AND status NOT IN ('לא תקין','נגרע')`)
    .get(modelId, s, String(parseInt(s, 10) || s)).c;
  const booked = db.prepare(`
    SELECT COUNT(*) c FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE oi.model_id = ? AND CAST(TRIM(COALESCE(oi.size,'')) AS TEXT) IN (?, ?)
      AND oi.status IN ('משוריין','מוכן','נמסר')
      AND o.status IN ('טיוטה','שריון','מוכנה','נמסרה')
      AND NOT (o.return_date < ? OR o.pickup_date > ?)
      ${excludeOrderId ? 'AND o.id != ' + Number(excludeOrderId) : ''}`)
    .get(modelId, s, String(parseInt(s, 10) || s), pickup, ret).c;
  return { physical, booked, available: physical - booked };
}

// הזמנה לפי דגם בלבד (בלי ברקוד) — נשלטת ע"י המנהלת בלשונית "חיבורים".
// ברירת המחדל היא "מותר"; המנהלת יכולה לכבות בכל רגע (הדרישה: חייבת להיות אופציה לחסום).
function manualModelOrderAllowed() {
  const v = getSetting('manual_model_order');
  return v === '' || v === null || v === undefined ? true : v === '1';
}

// חישוב תאריכי איסוף/החזרה בפועל — זהה לחישוב שביצירת הזמנה, כדי שהזמינות שמוצגת
// לעובדת תהיה בדיוק הזמינות שתיבדק בשמירה
function orderWindow({ event_date, pickup_date, return_date, extra_before = 0, extra_after = 0 }) {
  const ev = new Date(event_date);
  let pick = pickup_date || isoDate(pickupDate(ev));
  let ret = return_date || isoDate(returnDate(ev));
  const eb = Math.min(Math.max(parseInt(extra_before, 10) || 0, 0), MAX_EXTRA_DAYS);
  const ea = Math.min(Math.max(parseInt(extra_after, 10) || 0, 0), MAX_EXTRA_DAYS);
  if (eb) pick = isoDate(pickupDate(new Date(pick), eb));
  if (ea) ret = isoDate(returnDate(new Date(ret), ea));
  return { pick, ret };
}

// מחירי משלוח מהגדרות המנהלת (הלוך / חזור). חזור ריק = כמו הלוך.
export function deliveryPrices() {
  const out = Math.round((+getSetting('delivery_price') || 0) * 100) / 100;
  const backRaw = getSetting('delivery_price_back');
  const back = backRaw === '' || backRaw === null || backRaw === undefined
    ? out : Math.round((+backRaw || 0) * 100) / 100;
  return { out, back };
}
// חישוב עלות המשלוחים בהזמנה
function deliveryCharge(deliveryOut, deliveryBack) {
  const p = deliveryPrices();
  return (deliveryOut ? p.out : 0) + (deliveryBack ? p.back : 0);
}

const orderWithDetails = (id) => {
  const o = db.prepare(`
    SELECT o.*, c.name AS customer_name, c.tz, c.phone, c.email, c.notes AS customer_notes
    FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`).get(id);
  if (!o) return null;
  o.items = db.prepare(`
    SELECT oi.id AS oi_id, oi.status AS oi_status, oi.price, oi.returned_at,
           i.id AS item_id, i.barcode, COALESCE(i.size, oi.size) AS size, i.status AS item_status,
           m.code AS model_code, m.name AS model_name, m.category, m.premium
    FROM order_items oi
    LEFT JOIN items i ON i.id = oi.item_id
    JOIN models m ON m.id = COALESCE(oi.model_id, i.model_id)
    WHERE oi.order_id = ?`).all(id);
  o.transactions = db.prepare('SELECT * FROM transactions WHERE order_id = ? ORDER BY at').all(id);
  o.paid = o.transactions.reduce((s, t) => s + (t.type === 'תשלום' ? t.amount : t.type === 'החזר' ? -t.amount : 0), 0);
  // פירוט חיוב: שמלות + ימים נוספים (חצי מחיר) + משלוחים
  o.dresses_total = o.items.filter((i) => i.oi_status !== 'בוטל').reduce((s, i) => s + i.price, 0);
  o.extra_days_before = o.extra_days_before || 0;
  o.extra_days_after = o.extra_days_after || 0;
  o.extra_days = o.extra_days_before + o.extra_days_after;
  o.extra_days_total = round2(o.extra_days * EXTRA_DAY_RATE * o.dresses_total);
  o.delivery_total = deliveryCharge(o.delivery_out, o.delivery_back);
  o.billed_total = round2(o.dresses_total + o.extra_days_total + o.delivery_total);
  o.delivery_prices = deliveryPrices();
  return o;
};

export function inventoryRouter({ mustLogin, mustManager, events }) {
  const r = Router();
  r.use(mustLogin);

  // מחירי משלוח (להצגה בטופס הזמנה)
  r.get('/delivery-prices', (req, res) => res.json(deliveryPrices()));

  // דגלי הגדרות שהממשק צריך להכיר (מה מותר להציג לעובדת)
  r.get('/flags', (req, res) => res.json({ manual_model_order: manualModelOrderAllowed() }));

  // ---------- הזמנה לפי דגם, בלי ברקוד ----------
  // מקבלת קוד דגם + תאריכי ההזמנה, ומחזירה אילו מידות פנויות בפועל בתאריכים האלה.
  r.get('/model-availability', (req, res) => {
    if (!manualModelOrderAllowed())
      return res.status(403).json({ error: 'הזמנה לפי דגם (בלי ברקוד) חסומה כרגע ע"י המנהלת' });
    const code = String(req.query.model_code || '').trim();
    if (!code) return res.status(400).json({ error: 'קוד דגם — שדה חובה' });
    const dErr = firstError(vDate(req.query.event_date, 'תאריך האירוע'));
    if (dErr) return res.status(400).json({ error: dErr });

    const model = db.prepare('SELECT * FROM models WHERE code = ? AND active = 1').get(code);
    if (!model) return res.status(404).json({ error: `לא נמצא דגם בקוד ${code}` });

    const { pick, ret } = orderWindow({
      event_date: req.query.event_date,
      pickup_date: req.query.pickup_date || null,
      return_date: req.query.return_date || null,
      extra_before: req.query.extra_before,
      extra_after: req.query.extra_after,
    });

    // כל המידות שקיימות פיזית לדגם (שמלות תקינות בלבד)
    const sizes = db.prepare(`
      SELECT DISTINCT CAST(TRIM(COALESCE(size,'')) AS TEXT) AS size FROM items
      WHERE model_id = ? AND active = 1 AND status NOT IN ('לא תקין','נגרע')
        AND TRIM(COALESCE(size,'')) != ''`).all(model.id)
      .map((r0) => r0.size);

    const rows = sizes.map((size) => ({ size, ...modelSizeAvailability(model.id, size, pick, ret) }))
      .sort((a, b) => (parseInt(a.size, 10) || 0) - (parseInt(b.size, 10) || 0));

    res.json({
      model: { id: model.id, code: model.code, name: model.name, premium: !!model.premium,
               price: model.premium ? model.premium_price : model.price },
      pickup_date: pick, return_date: ret,
      free: rows.filter((x) => x.available > 0),
      taken: rows.filter((x) => x.available <= 0),
    });
  });

  // ---------- דגמים ----------
  r.get('/models', (req, res) => {
    const models = db.prepare(`
      SELECT m.*, COUNT(i.id) AS item_count,
             SUM(CASE WHEN i.status = 'זמין' THEN 1 ELSE 0 END) AS available_count
      FROM models m LEFT JOIN items i ON i.model_id = m.id AND i.active = 1
      WHERE m.active = 1 GROUP BY m.id ORDER BY m.code`).all();
    res.json(models);
  });
  r.post('/models', mustManager, (req, res) => {
    const { code, name, category = 'נשים', season = 'כל השנה', price = 0, premium = 0, premium_price = 0, notes } = req.body || {};
    const err = firstError(
      vText(code, 'קוד דגם', { max: 20 }),
      vText(name, 'שם הדגם', { min: 2, max: 100 }),
      vEnum(category, 'קטגוריה', ['נשים', 'ילדות']),
      vEnum(season, 'עונה', ['כל השנה', 'קיץ', 'חורף']),
      vAmount(price, 'מחיר השכרה', { min: 0, max: 10000, allowZero: true }),
      premium ? vAmount(premium_price, 'מחיר פרימיום', { min: 1, max: 10000 }) : null,
      vText(notes, 'הערות', { required: false, max: 500 }),
    );
    if (err) return res.status(400).json({ error: err });
    try {
      const x = db.prepare(`INSERT INTO models(code, name, category, season, price, premium, premium_price, notes)
                            VALUES (?,?,?,?,?,?,?,?)`)
        .run(String(code).trim(), name, category, season, +price || 0, premium ? 1 : 0, +premium_price || 0, notes || null);
      audit(req.user.name, 'model.create', 'model', x.lastInsertRowid, null, { code, name });
      res.json({ id: x.lastInsertRowid });
    } catch { res.status(400).json({ error: 'קוד הדגם כבר קיים' }); }
  });
  r.patch('/models/:id', mustManager, (req, res) => {
    const m = db.prepare('SELECT * FROM models WHERE id = ?').get(req.params.id);
    if (!m) return res.status(404).json({ error: 'דגם לא נמצא' });
    const b = req.body || {};
    const upd = {
      name: b.name ?? m.name, category: b.category ?? m.category, season: b.season ?? m.season,
      price: b.price !== undefined ? +b.price : m.price,
      premium: b.premium !== undefined ? (b.premium ? 1 : 0) : m.premium,
      premium_price: b.premium_price !== undefined ? +b.premium_price : m.premium_price,
      notes: b.notes ?? m.notes, active: b.active !== undefined ? (b.active ? 1 : 0) : m.active,
    };
    db.prepare(`UPDATE models SET name=@name, category=@category, season=@season, price=@price,
                premium=@premium, premium_price=@premium_price, notes=@notes, active=@active
                WHERE id = ${m.id}`).run(upd);
    // שינוי פרימיום משפיע מיידית על שריונים עתידיים שטרם שולמו (דרישת אפיון):
    // המחיר נלקח מהדגם בזמן החיוב, לכן אין צורך בעדכון רטרואקטיבי של שורות.
    audit(req.user.name, 'model.update', 'model', m.id, m, upd);
    res.json({ ok: true });
  });

  // ---------- פריטים וברקודים ----------
  r.get('/models/:id/items', (req, res) => {
    res.json(db.prepare('SELECT * FROM items WHERE model_id = ? AND active = 1 ORDER BY barcode').all(req.params.id));
  });
  r.post('/items', mustManager, (req, res) => {
    const { barcode, model_id, size } = req.body || {};
    const err = firstError(
      vBarcode(barcode),
      !model_id ? 'דגם — יש לבחור דגם' : null,
      vText(size, 'מידה', { required: false, max: 10 }),
    );
    if (err) return res.status(400).json({ error: err });
    if (!db.prepare('SELECT 1 FROM models WHERE id = ?').get(model_id))
      return res.status(400).json({ error: 'הדגם שנבחר לא קיים' });
    try {
      const x = db.prepare('INSERT INTO items(barcode, model_id, size) VALUES (?,?,?)')
        .run(String(barcode).trim(), model_id, size || null);
      audit(req.user.name, 'item.create', 'item', x.lastInsertRowid, null, { barcode, model_id });
      res.json({ id: x.lastInsertRowid });
    } catch { res.status(400).json({ error: 'הברקוד כבר קיים' }); }
  });
  r.patch('/items/:id', (req, res) => {
    const it = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
    if (!it) return res.status(404).json({ error: 'פריט לא נמצא' });
    const b = req.body || {};
    if (b.status && !ITEM_STATUSES.includes(b.status)) return res.status(400).json({ error: 'סטטוס לא חוקי' });
    const status = b.status ?? it.status;
    const note = b.condition_note ?? it.condition_note;
    const repair = status === 'בתיקון' && it.status !== 'בתיקון' ? it.repair_count + 1 : it.repair_count;
    db.prepare('UPDATE items SET status=?, condition_note=?, size=?, repair_count=?, active=? WHERE id=?')
      .run(status, note, b.size ?? it.size, repair, b.active !== undefined ? (b.active ? 1 : 0) : it.active, it.id);
    audit(req.user.name, 'item.update', 'item', it.id, { status: it.status }, { status });
    res.json({ ok: true });
  });

  // ---------- לקוחות ----------
  r.get('/customers', (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);
    const like = `%${q}%`;
    res.json(db.prepare(`SELECT * FROM customers WHERE tz LIKE ? OR phone LIKE ? OR name LIKE ? LIMIT 20`)
      .all(like, like, like));
  });
  r.post('/customers', (req, res) => {
    const { tz, phone, name, email } = req.body || {};
    const err = firstError(
      vText(name, 'שם הלקוחה', { min: 2, max: 100 }),
      !tz && !phone ? 'חובה להזין ת"ז או טלפון (לפחות אחד מהם)' : null,
      vTz(tz),
      vPhone(phone),
      vEmail(email),
    );
    if (err) return res.status(400).json({ error: err });
    try {
      const x = db.prepare('INSERT INTO customers(tz, phone, name, email) VALUES (?,?,?,?)')
        .run(tz ? String(tz).trim() : null, phone ? String(phone).trim() : null, name, email || null);
      audit(req.user.name, 'customer.create', 'customer', x.lastInsertRowid, null, { name, tz });
      res.json({ id: x.lastInsertRowid });
    } catch { res.status(400).json({ error: 'ת"ז כבר קיימת במערכת' }); }
  });
  r.get('/customers/:id', (req, res) => {
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'לקוחה לא נמצאה' });
    c.orders = db.prepare('SELECT id, event_date, status, created_at FROM orders WHERE customer_id = ? ORDER BY id DESC').all(c.id);
    res.json(c);
  });

  // ---------- הזמנות ----------
  r.get('/orders', (req, res) => {
    const today = isoDate(new Date());
    const { filter, q } = req.query;
    let where = "o.status NOT IN ('בוטלה','טיוטה')", params = [], orderBy = 'o.event_date DESC';
    if (q) {
      const digits = String(q).replace(/[^\d]/g, '');
      where = '(o.id = ? OR c.tz = ? OR c.phone LIKE ?)';
      params = [Number(q) || 0, digits, `%${digits}%`];
    } else if (filter === 'drafts') {
      where = "o.status = 'טיוטה'";
    } else if (filter === 'not_taken') {
      // שוריינו או הוכנו לשקיות אבל טרם נלקחו, ותאריך האיסוף הגיע
      where = `o.status IN ('שריון','מוכנה') AND o.pickup_date <= '${today}'`;
    } else if (filter === 'ready') {
      where = `o.status = 'מוכנה'`; // מוכנות בשקיות, ממתינות לאיסוף
    } else if (filter === 'partial') {
      where = `o.status IN ('שריון','מוכנה','נמסרה') AND EXISTS (SELECT 1 FROM order_items x WHERE x.order_id=o.id AND x.status IN ('מוכן','נמסר'))
               AND EXISTS (SELECT 1 FROM order_items x WHERE x.order_id=o.id AND x.status='משוריין')`;
    } else if (filter === 'late') {
      where = `o.status = 'נמסרה' AND o.return_date < '${today}' AND o.delivery_back = 0
               AND EXISTS (SELECT 1 FROM order_items x WHERE x.order_id=o.id AND x.status IN ('נמסר','החזרה מאוחרת'))`;
    } else if (filter === 'returns') {
      // השמלות אצל הלקוחה וממתינות לחזור — הקרובות להחזרה קודם
      where = RETURNS_WHERE;
      orderBy = 'o.return_date ASC';
    } else if (filter === 'cancelled') {
      where = "o.status = 'בוטלה'";
    } else if (filter === 'today') {
      where = `(o.pickup_date = '${today}' OR o.return_date = '${today}') AND o.status IN ('שריון','מוכנה','נמסרה')`;
    }
    const rows = db.prepare(`
      SELECT o.id, o.event_date, o.pickup_date, o.return_date, o.status,
             o.delivery_out, o.delivery_back, o.created_at,
             c.name AS customer_name, c.phone,
             COUNT(oi.id) AS item_count,
             GROUP_CONCAT(m.code, ', ') AS model_codes
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      LEFT JOIN order_items oi ON oi.order_id = o.id AND oi.status != 'בוטל'
      LEFT JOIN items i ON i.id = oi.item_id
      LEFT JOIN models m ON m.id = COALESCE(oi.model_id, i.model_id)
      WHERE ${where}
      GROUP BY o.id ORDER BY ${orderBy} LIMIT 100`).all(...params);
    res.json(rows);
  });

  // ---------- חיפוש מתקדם ----------
  // ברקוד / דגם / דגם+מידה / חודש / יום אירוע / לקוחה. מחזיר בדיוק את מבנה השורות של GET /orders
  r.get('/search', (req, res) => {
    const { barcode, model_code, size, month, event_date, customer } = req.query;
    const bc = String(barcode || '').trim();
    const mc = String(model_code || '').trim();
    const sz = String(size || '').trim();
    const mo = String(month || '').trim();
    const ed = String(event_date || '').trim();
    const cu = String(customer || '').trim();
    if (!bc && !mc && !sz && !mo && !ed && !cu)
      return res.status(400).json({ error: 'יש להזין לפחות שדה חיפוש אחד' });
    if (mo && !/^\d{4}-\d{2}$/.test(mo)) return res.status(400).json({ error: 'חודש — הפורמט הנדרש הוא YYYY-MM' });
    if (ed && !/^\d{4}-\d{2}-\d{2}$/.test(ed)) return res.status(400).json({ error: 'יום אירוע — הפורמט הנדרש הוא YYYY-MM-DD' });

    const conds = [], params = [];
    if (bc) {
      // גם ההזמנות שהשמלה הזו שויכה אליהן בפועל, וגם אלה ששיריינו את הדגם+מידה שלה
      const item = db.prepare('SELECT id, model_id, size FROM items WHERE barcode = ?').get(bc);
      const rs = resolveModelSize(bc);
      if (!item && !rs) return res.status(404).json({ error: `ברקוד ${bc} לא מזוהה — לא נמצא דגם מתאים` });
      const modelId = item?.model_id ?? rs.model.id;
      const msize = String(item?.size ?? rs.size ?? '').trim();
      conds.push(`EXISTS (SELECT 1 FROM order_items x WHERE x.order_id = o.id
        AND (x.item_id = ? OR (x.model_id = ? AND CAST(TRIM(COALESCE(x.size,'')) AS TEXT) IN (?, ?))))`);
      params.push(item?.id ?? -1, modelId, msize, String(parseInt(msize, 10) || msize));
    }
    if (mc || (sz && !bc)) {
      // דגם (ואם נבחרה גם מידה — סינון נוסף לפיה)
      let sub = `EXISTS (SELECT 1 FROM order_items x
        LEFT JOIN items xi ON xi.id = x.item_id
        JOIN models xm ON xm.id = COALESCE(x.model_id, xi.model_id)
        WHERE x.order_id = o.id`;
      if (mc) { sub += ' AND xm.code = ?'; params.push(mc); }
      if (sz) {
        sub += ` AND CAST(TRIM(COALESCE(x.size, xi.size, '')) AS TEXT) IN (?, ?)`;
        params.push(sz, String(parseInt(sz, 10) || sz));
      }
      conds.push(sub + ')');
    }
    if (mo) { conds.push('substr(o.event_date, 1, 7) = ?'); params.push(mo); }
    if (ed) { conds.push('o.event_date = ?'); params.push(ed); }
    if (cu) {
      const digits = cu.replace(/[^\d]/g, '');
      conds.push(`(c.name LIKE ? OR c.tz LIKE ? OR c.phone LIKE ?)`);
      params.push(`%${cu}%`, `%${digits || cu}%`, `%${digits || cu}%`);
    }
    const rows = db.prepare(`
      SELECT o.id, o.event_date, o.pickup_date, o.return_date, o.status,
             o.delivery_out, o.delivery_back, o.created_at,
             c.name AS customer_name, c.phone,
             COUNT(oi.id) AS item_count,
             GROUP_CONCAT(m.code, ', ') AS model_codes
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      LEFT JOIN order_items oi ON oi.order_id = o.id AND oi.status != 'בוטל'
      LEFT JOIN items i ON i.id = oi.item_id
      LEFT JOIN models m ON m.id = COALESCE(oi.model_id, i.model_id)
      WHERE ${conds.join(' AND ')}
      GROUP BY o.id ORDER BY o.event_date DESC LIMIT 200`).all(...params);
    res.json(rows);
  });

  r.get('/orders/:id', (req, res) => {
    const o = orderWithDetails(req.params.id);
    o ? res.json(o) : res.status(404).json({ error: 'הזמנה לא נמצאה' });
  });

  // יצירת הזמנה. הזמנה סופית = 1–6 שמלות + תשלום (אין שמלות/אין תשלום → אין הזמנה).
  // טיוטה (draft=true) = הזמנה פתוחה שנשמרת בלי חובת תשלום/שמלות, בעמודת "טיוטות".
  r.post('/orders', (req, res) => {
    const { customer, event_date, pickup_date, return_date, delivery_out = 0, delivery_back = 0,
            delivery_address, notes, barcodes, items, payment, payments, force, draft,
            extra_days_before = 0, extra_days_after = 0 } = req.body || {};
    const isDraft = !!draft;
    // ימים נוספים בחצי מחיר — מספר שלם 0–7 לכל צד
    const vExtra = (v, label) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > MAX_EXTRA_DAYS)
        return `${label} — יש להזין מספר שלם בין 0 ל-${MAX_EXTRA_DAYS}`;
      return null;
    };
    const extraErr = firstError(
      vExtra(extra_days_before, 'ימים נוספים לפני'),
      vExtra(extra_days_after, 'ימים נוספים אחרי'),
    );
    if (extraErr) return res.status(400).json({ error: extraErr });
    const extraBefore = Number(extra_days_before), extraAfter = Number(extra_days_after);
    if (!customer) return res.status(400).json({ error: 'לקוחה — שדה חובה' });
    // ולידציית שדות ההזמנה
    const today = isoDate(new Date());
    const vErr = firstError(
      vDate(event_date, 'תאריך האירוע'),
      vDate(pickup_date, 'תאריך איסוף', { required: false }),
      vDate(return_date, 'תאריך החזרה', { required: false }),
      (delivery_out || delivery_back) ? vText(delivery_address, 'כתובת למשלוח', { min: 5, max: 200 }) : null,
      vText(notes, 'הערות', { required: false, max: 500 }),
      // לקוחה חדשה — בדיקת פרטיה
      !customer.id ? firstError(
        vText(customer.name, 'שם הלקוחה', { min: 2, max: 100 }),
        !customer.tz && !customer.phone ? 'ללקוחה חדשה חובה ת"ז או טלפון' : null,
        vTz(customer.tz), vPhone(customer.phone), vEmail(customer.email),
      ) : null,
    );
    if (vErr) return res.status(400).json({ error: vErr });
    // תאריך אירוע בעבר — התרעה (אלא אם נכפה במפורש)
    if (event_date < today && !force)
      return res.status(400).json({ error: `תאריך האירוע (${event_date}) כבר עבר. לרישום רטרואקטיבי יש לאשר חריגה`, canForce: true });
    // סדר תאריכים הגיוני
    if (pickup_date && return_date && pickup_date > return_date)
      return res.status(400).json({ error: 'תאריך האיסוף מאוחר מתאריך ההחזרה' });
    if (pickup_date && event_date && pickup_date > event_date)
      return res.status(400).json({ error: 'תאריך האיסוף מאוחר מתאריך האירוע' });
    if (return_date && event_date && return_date < event_date)
      return res.status(400).json({ error: 'תאריך ההחזרה מוקדם מתאריך האירוע' });

    // --- שמלות (עד 6, ללא כפילויות). בהזמנה סופית חובה לפחות אחת ---
    const list = Array.isArray(barcodes) ? barcodes.map((b) => String(b || '').trim()).filter(Boolean) : [];
    // שורות שהוזמנו לפי דגם+מידה בלבד, בלי ברקוד. שתי שמלות מאותו דגם ומידה הן בקשה לגיטימית
    // (יש כמה שמלות פיזיות) — ולכן כאן אין בדיקת כפילות, רק בדיקת זמינות בהמשך.
    const modelLines = Array.isArray(items)
      ? items.map((x) => ({ model_code: String(x?.model_code ?? '').trim(), size: String(x?.size ?? '').trim() }))
             .filter((x) => x.model_code)
      : [];
    if (modelLines.length && !manualModelOrderAllowed())
      return res.status(403).json({ error: 'הזמנה לפי דגם (בלי ברקוד) חסומה כרגע ע"י המנהלת' });
    const total = list.length + modelLines.length;
    if (!isDraft && !total) return res.status(400).json({ error: 'לא ניתן ליצור הזמנה ללא שמלות — הוסיפי לפחות שמלה אחת' });
    if (total > 6) return res.status(400).json({ error: 'ניתן להוסיף עד 6 שמלות בהזמנה' });
    const dup = list.find((b, i) => list.indexOf(b) !== i);
    if (dup) return res.status(400).json({ error: `השמלה ${dup} נוספה פעמיים` });

    // --- תשלום. בהזמנה סופית חובה; בטיוטה אופציונלי. תמיכה בפיצול (payments[]) ---
    // אמצעי התשלום נשמר כפי שהוזן (ללא ברירת מחדל שקטה) — ונבדק בהמשך
    const rawPays = Array.isArray(payments) && payments.length ? payments : (payment ? [payment] : []);
    const payList = rawPays
      .map((p) => ({ amount: Math.round((+p.amount || 0) * 100) / 100, method: String(p.method ?? '').trim() }))
      .filter((p) => p.amount !== 0);
    const payAmount = payList.reduce((s, p) => s + p.amount, 0);
    if (!isDraft && !(payAmount > 0)) return res.status(400).json({ error: 'לא ניתן ליצור הזמנה ללא תשלום — הזיני סכום תשלום' });
    // ולידציית סכומי התשלום
    for (const p of payList) {
      const e = firstError(vAmount(p.amount, 'סכום תשלום', { min: 1, max: 50000 }), vEnum(p.method, 'אמצעי תשלום', PAY_METHODS));
      if (e) return res.status(400).json({ error: e });
    }

    // ברירת מחדל לתאריכים: איסוף יומיים לפני, החזרה יום אחרי
    const ev = new Date(event_date);
    // ברירת מחדל: יומיים לפני / יום אחרי — מדלג על שבת ויו"ט
    let pick = pickup_date || isoDate(pickupDate(ev));
    let ret = return_date || isoDate(returnDate(ev));
    // הזמנה מראש: הימים הנוספים מתווספים על גבי החישוב הקיים (וגם הם מדלגים על שבת ויו"ט)
    if (extraBefore) pick = isoDate(pickupDate(new Date(pick), extraBefore));
    if (extraAfter) ret = isoDate(returnDate(new Date(ret), extraAfter));

    // --- זיהוי דגם+מידה מכל ברקוד (השריון הוא על דגם+מידה, לא על השמלה הספציפית) ---
    const resolved = [];
    for (const barcode of list) {
      const r0 = resolveModelSize(barcode);
      if (!r0) return res.status(404).json({ error: `ברקוד ${barcode} לא מזוהה — לא נמצא דגם מתאים` });
      resolved.push({ ...r0, barcode });
    }
    // שורות ללא ברקוד: דגם+מידה שהוקלדו ידנית
    for (const line of modelLines) {
      const model = db.prepare('SELECT * FROM models WHERE code = ? AND active = 1').get(line.model_code);
      if (!model) return res.status(404).json({ error: `לא נמצא דגם בקוד ${line.model_code}` });
      if (!line.size) return res.status(400).json({ error: `לדגם ${line.model_code} חסרה מידה` });
      resolved.push({ model, size: line.size, viaItem: false, barcode: null, byModel: true });
    }
    // --- בדיקת זמינות לפי דגם+מידה, כולל כפילויות בתוך אותה הזמנה ---
    const localCount = {};
    const conflicts = [];
    for (const { model, size } of resolved) {
      const key = model.id + '|' + String(size).trim();
      localCount[key] = (localCount[key] || 0) + 1;
      const a = modelSizeAvailability(model.id, size, pick, ret);
      if (a.available - localCount[key] < 0) {
        conflicts.push({ model: model.code, size, physical: a.physical, booked: a.booked });
      }
    }
    // חוסר מלאי חוסם תמיד — אין חריגת חירום ממלאי בשום מקרה (דרישת הלקוחה)
    if (conflicts.length) {
      return res.status(409).json({
        error: 'אין מספיק שמלות פנויות בתאריכים אלה: ' +
          conflicts.map((c) => `דגם ${c.model} מידה ${c.size} (${c.physical} במלאי, ${c.booked} משוריינות)`).join(' · '),
        conflicts,
      });
    }

    // --- לקוחה (קיימת או חדשה) ---
    let customerId = customer.id;
    if (!customerId) {
      if (!customer.name || (!customer.tz && !customer.phone))
        return res.status(400).json({ error: 'ללקוחה חדשה: שם + ת"ז או טלפון' });
      const existing = customer.tz ? db.prepare('SELECT id FROM customers WHERE tz = ?').get(String(customer.tz).trim()) : null;
      customerId = existing?.id ?? db.prepare('INSERT INTO customers(tz, phone, name, email) VALUES (?,?,?,?)')
        .run(customer.tz || null, customer.phone || null, customer.name, customer.email || null).lastInsertRowid;
    }

    // --- יצירה אטומית ---
    let orderId, billed = 0;
    const status = isDraft ? 'טיוטה' : 'שריון';
    db.transaction(() => {
      const station = req.header('x-station') ? 'מחשב ' + req.header('x-station') : null;
      orderId = db.prepare(`INSERT INTO orders(customer_id, event_date, pickup_date, return_date, delivery_out, delivery_back, delivery_address, notes, workstation, created_by, status, extra_days_before, extra_days_after)
                            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(customerId, event_date, pick, ret, delivery_out ? 1 : 0, delivery_back ? 1 : 0,
             delivery_address || null, notes || null, station, req.user.name, status,
             extraBefore, extraAfter).lastInsertRowid;
      const insItem = db.prepare('INSERT INTO order_items(order_id, model_id, size, price) VALUES (?,?,?,?)');
      let dressesTotal = 0;
      for (const { model, size } of resolved) {
        const price = model.premium ? model.premium_price : model.price;
        dressesTotal += price;
        insItem.run(orderId, model.id, String(size).trim(), price);
      }
      billed += dressesTotal;
      // כל יום נוסף = 50% ממחיר השמלות בהזמנה
      billed += round2((extraBefore + extraAfter) * EXTRA_DAY_RATE * dressesTotal);
      // תשלום — שורה נפרדת לכל אמצעי (פיצול מזומן/אשראי)
      const payNote = isDraft ? 'מקדמה על טיוטה' : 'תשלום ביצירת הזמנה';
      const insTx = db.prepare(`INSERT INTO transactions(order_id, customer_id, type, method, amount, note, by_user)
                                VALUES (?,?,'תשלום',?,?,?,?)`);
      for (const p of payList) insTx.run(orderId, customerId, p.method, p.amount, payNote, req.user.name);
      billed += deliveryCharge(delivery_out, delivery_back); // עלות משלוחים נכללת בחיוב
      billed = round2(billed);
    })();
    // ה-force שנותר הוא רק רישום רטרואקטיבי (תאריך אירוע בעבר) — לא חריגת מלאי
    const retro = !isDraft && !!force && event_date < today;
    audit(req.user.name, isDraft ? 'order.draft.create' : (retro ? 'order.create.RETRO' : 'order.create'), 'order', orderId, null,
      { customerId, event_date, items: resolved.length, billed, paid: payAmount, draft: isDraft, retroactive: retro,
        extra_days_before: extraBefore, extra_days_after: extraAfter,
        // תיעוד שורות שהוזמנו בלי ברקוד — כדי שהמנהלת תוכל לבחון אם השימוש בזה מועיל או מזיק
        by_model: modelLines.length,
        by_model_lines: modelLines.length ? modelLines.map((x) => `${x.model_code}/${x.size}`).join(', ') : undefined });
    events.emit('order.created', { id: orderId, draft: isDraft });
    res.json({ id: orderId, items: resolved.length, billed, paid: payAmount, draft: isDraft,
               pickup_date: pick, return_date: ret, extra_days_before: extraBefore, extra_days_after: extraAfter });
  });

  // הפיכת טיוטה להזמנה סופית — דורש לפחות שמלה אחת ותשלום (קיים או שנרשם עכשיו)
  r.post('/orders/:id/finalize', (req, res) => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!o) return res.status(404).json({ error: 'הזמנה לא נמצאה' });
    if (o.status !== 'טיוטה') return res.status(400).json({ error: 'רק טיוטה ניתנת להפיכה להזמנה' });
    const activeItems = db.prepare(`SELECT COUNT(*) c FROM order_items WHERE order_id = ? AND status != 'בוטל'`).get(o.id).c;
    if (!activeItems) return res.status(400).json({ error: 'אין שמלות בטיוטה — הוסיפי לפחות שמלה אחת' });

    const { payment } = req.body || {};
    const payAmount = Math.round((+(payment?.amount) || 0) * 100) / 100;
    const payMethod = PAY_METHODS.includes(payment?.method) ? payment.method : 'מזומן';
    const paidSoFar = db.prepare(`SELECT COALESCE(SUM(CASE type WHEN 'תשלום' THEN amount WHEN 'דמי ביטול' THEN amount WHEN 'החזר' THEN -amount ELSE 0 END),0) s
                                  FROM transactions WHERE order_id = ?`).get(o.id).s;
    if (!(paidSoFar + payAmount > 0)) return res.status(400).json({ error: 'לא ניתן להפוך להזמנה ללא תשלום — הזיני סכום' });

    db.transaction(() => {
      if (payAmount > 0)
        db.prepare(`INSERT INTO transactions(order_id, customer_id, type, method, amount, note, by_user)
                    VALUES (?,?,'תשלום',?,?,?,?)`).run(o.id, o.customer_id, payMethod, payAmount, 'תשלום בהפיכת טיוטה להזמנה', req.user.name);
      db.prepare(`UPDATE orders SET status = 'שריון' WHERE id = ?`).run(o.id);
    })();
    audit(req.user.name, 'order.finalize', 'order', o.id, { status: 'טיוטה' }, { status: 'שריון', added_payment: payAmount });
    res.json({ ok: true });
  });

  // מחיקת טיוטה — טיוטה תלושה, נמחקת לגמרי (לא נכנסת לדוח הביטולים)
  r.delete('/orders/:id', (req, res) => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!o) return res.status(404).json({ error: 'הזמנה לא נמצאה' });
    if (o.status !== 'טיוטה') return res.status(400).json({ error: 'רק טיוטה ניתנת למחיקה — הזמנה מאושרת יש לבטל' });
    db.transaction(() => {
      db.prepare('DELETE FROM transactions WHERE order_id = ?').run(o.id);
      db.prepare('DELETE FROM order_items WHERE order_id = ?').run(o.id);
      db.prepare('DELETE FROM orders WHERE id = ?').run(o.id);
    })();
    audit(req.user.name, 'order.draft.delete', 'order', o.id, { status: 'טיוטה' }, null);
    res.json({ ok: true });
  });

  // הוספת שמלה להזמנה לפי ברקוד, עם בדיקת זמינות
  r.post('/orders/:id/items', (req, res) => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!o) return res.status(404).json({ error: 'הזמנה לא נמצאה' });
    if (o.status === 'בוטלה') return res.status(400).json({ error: 'ההזמנה מבוטלת' });
    // תקרה של 6 שמלות בהזמנה (דרישת אפיון)
    const activeCount = db.prepare(`SELECT COUNT(*) c FROM order_items WHERE order_id = ? AND status != 'בוטל'`).get(o.id).c;
    if (activeCount >= 6) return res.status(400).json({ error: 'בהזמנה כבר 6 שמלות — זו התקרה' });
    const { barcode, manual = false, signature } = req.body || {};
    if (manual && signature !== SIGNATURE_TEXT)
      return res.status(400).json({ error: 'הקלדה ידנית דורשת אישור חתימה', needSignature: true });
    // הסריקה מזהה דגם+מידה — השריון אינו על השמלה הספציפית שנסרקה
    const r0 = resolveModelSize(barcode);
    if (!r0) return res.status(404).json({ error: 'ברקוד לא מזוהה — לא נמצא דגם מתאים' });
    const { model, size } = r0;
    const a = modelSizeAvailability(model.id, size, o.pickup_date, o.return_date, o.id);
    // מפחיתים שריונים שכבר קיימים בהזמנה הזו לאותו דגם+מידה
    const inThisOrder = db.prepare(`
      SELECT COUNT(*) c FROM order_items WHERE order_id = ? AND model_id = ?
        AND TRIM(COALESCE(size,'')) = TRIM(?) AND status IN ('משוריין','מוכן','נמסר')`).get(o.id, model.id, String(size).trim()).c;
    // חוסר מלאי חוסם תמיד — אין חריגת חירום ממלאי בשום מקרה (דרישת הלקוחה)
    if (a.available - inThisOrder <= 0) {
      return res.status(409).json({
        error: `אין שמלות פנויות מדגם ${model.code} מידה ${size} בתאריכים אלה (${a.physical} במלאי, ${a.booked + inThisOrder} משוריינות)`,
        conflicts: [{ model: model.code, size, physical: a.physical, booked: a.booked }],
      });
    }
    const price = model.premium ? model.premium_price : model.price;
    const x = db.prepare('INSERT INTO order_items(order_id, model_id, size, price) VALUES (?,?,?,?)')
      .run(o.id, model.id, String(size).trim(), price);
    if (manual) logManual(String(barcode).trim(), o.id, 'שריון', signature, req.user.name);
    audit(req.user.name, 'order.item.add', 'order', o.id, null, { model: model.code, size, price, manual });
    // מלאי פנוי אחרי השריון הנוכחי — כדי שהעובדת תראה כמה נשאר
    const after = modelSizeAvailability(model.id, size, o.pickup_date, o.return_date, o.id);
    const inThisAfter = db.prepare(`SELECT COUNT(*) c FROM order_items WHERE order_id = ? AND model_id = ?
        AND TRIM(COALESCE(size,'')) = TRIM(?) AND status IN ('משוריין','מוכן','נמסר')`).get(o.id, model.id, String(size).trim()).c;
    res.json({
      id: x.lastInsertRowid, price, model: model.name, size,
      physical: after.physical, remaining: Math.max(0, after.available - inThisAfter),
    });
  });

  // הסרת שמלה מהזמנה — נעול: דורש ת"ז/טלפון של המזמינה
  r.delete('/orders/:id/items/:oiId', (req, res) => {
    const o = verifyOrderAccess(req.params.id, req.query.verify);
    if (!o) return res.status(403).json({ error: 'לשינוי הזמנה חובה להזין ת"ז או טלפון של המזמינה' });
    const oi = db.prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?').get(req.params.oiId, o.id);
    if (!oi) return res.status(404).json({ error: 'פריט לא נמצא בהזמנה' });
    // אין הזמנה ללא שמלות — לא מסירים את השמלה האחרונה (בטיוטה מותר להישאר ריק)
    if (o.status !== 'טיוטה') {
      const activeCount = db.prepare(`SELECT COUNT(*) c FROM order_items WHERE order_id = ? AND status != 'בוטל'`).get(o.id).c;
      if (activeCount <= 1) return res.status(400).json({ error: 'זו השמלה האחרונה בהזמנה — להסרה בטלי את ההזמנה כולה' });
    }
    db.prepare(`UPDATE order_items SET status = 'בוטל' WHERE id = ?`).run(oi.id);
    audit(req.user.name, 'order.item.remove', 'order', o.id, { order_item: oi.id, was: oi.status }, { status: 'בוטל' });
    res.json({ ok: true });
  });

  // מסירה בסריקה: סורקים את השמלה הפיזית שנמסרת — המערכת משדכת אותה לשריון דגם+מידה פתוח
  // ===== מסירה דו-שלבית =====
  // שלב 1 — הכנה לשקיות: סורקים כל שמלה, משדכים לשריון ומעבירים ל"מוכן". ההזמנה → "מוכנה".
  const prepareScan = (req, res) => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!o) return res.status(404).json({ error: 'הזמנה לא נמצאה' });
    if (!['שריון', 'מוכנה'].includes(o.status))
      return res.status(400).json({ error: `ההזמנה בסטטוס "${o.status}" — אין מה להכין` });
    const barcode = String(req.body?.barcode || '').trim();
    const { manual = false, signature } = req.body || {};
    if (manual && signature !== SIGNATURE_TEXT)
      return res.status(400).json({ error: 'הקלדה ידנית דורשת אישור חתימה', needSignature: true });
    const item = db.prepare(`
      SELECT i.*, m.code AS model_code, m.name AS model_name
      FROM items i JOIN models m ON m.id = i.model_id WHERE i.barcode = ? AND i.active = 1`).get(barcode);
    if (!item) return res.status(404).json({ error: 'הברקוד לא נמצא במלאי' });
    if (['לא תקין', 'נגרע'].includes(item.status))
      return res.status(400).json({ error: `השמלה במצב "${item.status}" — אי אפשר להשתמש בה` });
    if (item.status === 'מושכר')
      return res.status(400).json({ error: 'השמלה הזו כבר שובצה/מושכרת ללקוחה אחרת' });
    const line = db.prepare(`
      SELECT id FROM order_items
      WHERE order_id = ? AND status = 'משוריין' AND item_id IS NULL
        AND model_id = ? AND TRIM(COALESCE(size,'')) = TRIM(?)
      LIMIT 1`).get(o.id, item.model_id, String(item.size || '').trim());
    if (!line) return res.status(400).json({ error: `השמלה שנסרקה (דגם ${item.model_code} מידה ${item.size}) לא תואמת שריון פתוח בהזמנה זו` });
    db.transaction(() => {
      db.prepare(`UPDATE order_items SET item_id = ?, status = 'מוכן' WHERE id = ?`).run(item.id, line.id);
      db.prepare(`UPDATE items SET status = 'מושכר' WHERE id = ?`).run(item.id);
      const open = db.prepare(`SELECT COUNT(*) c FROM order_items WHERE order_id = ? AND status = 'משוריין'`).get(o.id).c;
      if (open === 0) db.prepare(`UPDATE orders SET status = 'מוכנה' WHERE id = ?`).run(o.id);
    })();
    const remaining = db.prepare(`SELECT COUNT(*) c FROM order_items WHERE order_id = ? AND status = 'משוריין'`).get(o.id).c;
    if (manual) logManual(barcode, o.id, 'הכנה', signature, req.user.name);
    audit(req.user.name, 'order.prepare.scan', 'order', o.id, null, { barcode, line: line.id, remaining, manual });
    res.json({ ok: true, model: item.model_name, barcode, remaining, ready: remaining === 0 });
  };
  r.post('/orders/:id/prepare-scan', prepareScan);
  r.post('/orders/:id/deliver-scan', prepareScan); // תאימות לאחור

  // שלב 2 — נלקח בפועל: המשפחה הגיעה / יצא למשלוחן. "מוכנה" → "נמסרה", "מוכן" → "נמסר".
  r.post('/orders/:id/handover', (req, res) => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!o) return res.status(404).json({ error: 'הזמנה לא נמצאה' });
    if (o.status !== 'מוכנה')
      return res.status(400).json({ error: o.status === 'שריון' ? 'יש קודם להכין את השמלות (שלב 1)' : `ההזמנה בסטטוס "${o.status}"` });
    const note = String(req.body?.note || '').trim(); // מי לקח / יצא למשלוחן
    db.transaction(() => {
      db.prepare(`UPDATE order_items SET status = 'נמסר' WHERE order_id = ? AND status = 'מוכן'`).run(o.id);
      db.prepare(`UPDATE orders SET status = 'נמסרה'${note ? ", notes = TRIM(COALESCE(notes,'') || char(10) || 'נלקח: ' || ?)" : ''} WHERE id = ?`)
        .run(...(note ? [note, o.id] : [o.id]));
    })();
    audit(req.user.name, 'order.handover', 'order', o.id, { status: 'מוכנה' }, { status: 'נמסרה', note });
    res.json({ ok: true });
  });

  // מסירה ישנה (לשורות שכבר משויכת להן שמלה — תאימות לאחור)
  r.post('/orders/:id/deliver', (req, res) => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!o) return res.status(404).json({ error: 'הזמנה לא נמצאה' });
    const items = db.prepare(`SELECT oi.id, oi.item_id FROM order_items oi
      WHERE oi.order_id = ? AND oi.status = 'משוריין' AND oi.item_id IS NOT NULL`).all(o.id);
    if (!items.length) return res.status(400).json({ error: 'למסירה יש לסרוק את השמלות שנמסרות (שריון הוא לפי דגם ומידה)' });
    db.transaction(() => {
      for (const it of items) {
        db.prepare(`UPDATE order_items SET status = 'נמסר' WHERE id = ?`).run(it.id);
        db.prepare(`UPDATE items SET status = 'מושכר' WHERE id = ?`).run(it.item_id);
      }
      const open = db.prepare(`SELECT COUNT(*) c FROM order_items WHERE order_id = ? AND status = 'משוריין'`).get(o.id).c;
      if (open === 0) db.prepare(`UPDATE orders SET status = 'נמסרה' WHERE id = ?`).run(o.id);
    })();
    audit(req.user.name, 'order.deliver', 'order', o.id, { status: o.status }, { status: 'נמסרה', items: items.length });
    res.json({ ok: true, delivered: items.length });
  });

  // ביטול הזמנה — נעול + רישום כספי בקופת יום הביטול (נוהל קופה דינמי)
  r.post('/orders/:id/cancel', (req, res) => {
    const { verify, fee = 0, refund = 0, method = 'מזומן' } = req.body || {};
    const cErr = firstError(
      vAmount(fee, 'דמי ביטול', { required: false, min: 0, max: 50000, allowZero: true }),
      vAmount(refund, 'סכום החזר', { required: false, min: 0, max: 50000, allowZero: true }),
      (+fee > 0 || +refund > 0) ? vEnum(method, 'אמצעי תשלום', PAY_METHODS) : null,
    );
    if (cErr) return res.status(400).json({ error: cErr });
    const o = verifyOrderAccess(req.params.id, verify);
    if (!o) return res.status(403).json({ error: 'לביטול חובה להזין ת"ז או טלפון של המזמינה' });
    if (o.status === 'בוטלה') return res.status(400).json({ error: 'ההזמנה כבר מבוטלת' });
    // הזמנה שנמסרה — השמלות אצל הלקוחה; אין ביטול, רק החזרה בעמדת הסריקה
    if (o.status === 'נמסרה')
      return res.status(400).json({ error: 'ההזמנה כבר נמסרה והשמלות אצל הלקוחה — לא ניתן לבטל. קולטים החזרה בעמדת הסריקה' });
    // הזמנה שהסתיימה (השמלות חזרו) — אין מה לבטל
    if (o.status === 'הוחזרה')
      return res.status(400).json({ error: 'ההזמנה כבר הסתיימה והשמלות חזרו — לא ניתן לבטל אותה' });
    db.transaction(() => {
      // כולל שמלות שהוכנו בשקיות ("מוכן") — משתחררות בחזרה למלאי
      const its = db.prepare(`SELECT oi.id, oi.item_id FROM order_items oi WHERE oi.order_id = ? AND oi.status IN ('משוריין','מוכן','נמסר')`).all(o.id);
      for (const it of its) {
        db.prepare(`UPDATE order_items SET status = 'בוטל' WHERE id = ?`).run(it.id);
        db.prepare(`UPDATE items SET status = 'זמין' WHERE id = ? AND status = 'מושכר'`).run(it.item_id);
      }
      db.prepare(`UPDATE orders SET status = 'בוטלה', cancelled_at = datetime('now','localtime') WHERE id = ?`).run(o.id);
      if (+fee > 0) db.prepare(`INSERT INTO transactions(order_id, customer_id, type, method, amount, note, by_user)
        VALUES (?,?,'דמי ביטול',?,?,?,?)`).run(o.id, o.customer_id, method, +fee, 'דמי ביטול הזמנה ' + o.id, req.user.name);
      if (+refund > 0) db.prepare(`INSERT INTO transactions(order_id, customer_id, type, method, amount, note, by_user)
        VALUES (?,?,'החזר',?,?,?,?)`).run(o.id, o.customer_id, method, +refund, 'החזר בגין ביטול הזמנה ' + o.id, req.user.name);
    })();
    audit(req.user.name, 'order.cancel', 'order', o.id, { status: o.status }, { status: 'בוטלה', fee, refund });
    events.emit('order.cancelled', { id: o.id });
    res.json({ ok: true });
  });

  // ---------- עמדת סריקה ----------
  r.get('/scan/:barcode', (req, res) => {
    const item = db.prepare(`
      SELECT i.*, m.code AS model_code, m.name AS model_name, m.category, m.price, m.premium, m.premium_price
      FROM items i JOIN models m ON m.id = i.model_id WHERE i.barcode = ?`)
      .get(String(req.params.barcode).trim());
    if (!item) return res.status(404).json({ error: 'ברקוד לא נמצא במערכת' });
    // ההזמנה הפעילה שהפריט משויך אליה
    item.current_order = db.prepare(`
      SELECT o.id, o.status, o.event_date, o.return_date, c.name AS customer_name, c.phone, oi.status AS oi_status, oi.id AS oi_id
      FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN customers c ON c.id = o.customer_id
      WHERE oi.item_id = ? AND oi.status IN ('משוריין','נמסר','החזרה מאוחרת') AND o.status IN ('שריון','נמסרה')
      ORDER BY o.id DESC LIMIT 1`).get(item.id) || null;
    res.json(item);
  });

  // רישום ברקוד שהוקלד ידנית (הסורק לא עבד) — עם חתימה
  function logManual(barcode, orderId, context, signature, userName) {
    const ins = db.prepare('INSERT INTO manual_barcodes(barcode, order_id, context, signature, user_name) VALUES (?,?,?,?,?)')
      .run(barcode, orderId || null, context, signature, userName);
    audit(userName, 'barcode.manual', 'manual_barcode', barcode, null, { context, orderId });
    const today = isoDate(new Date());
    // התראה מיידית פר-הקלדה — משימה לא משויכת, נראית גם למנהלת וגם למוקדנית
    createAutoTask({
      title: `⌨️ ברקוד תקול הוקלד ידנית: ${barcode} (${context}${orderId ? ', הזמנה #' + orderId : ''}) — ע"י ${userName}`,
      category: 'ניהול מלאי', due_date: today, priority: 'חשוב',
      uniq_key: `manual-entry-${ins.lastInsertRowid}`,
    });
    // הודעה פנימית (למסך ההודעות של המנהלת)
    db.prepare('INSERT INTO messages(from_user, body) VALUES (?,?)').run('מערכת ⌨️',
      `ברקוד תקול הוקלד ידנית: ${barcode} (${context})${orderId ? ' · הזמנה #' + orderId : ''} · ע"י ${userName}`);
  }
  const SIGNATURE_TEXT = 'אני מאשרת שהשמלה אכן בידי עכשיו';

  // רישום מיידי של ברקוד שהוקלד ידנית — עצמאי, לא תלוי בהצלחת הפעולה שאחריו.
  // כך כל הקלדה ידנית (גם של ברקוד לא קיים) נכנסת לדוח ומפעילה התראה.
  r.post('/manual-barcode', (req, res) => {
    const { barcode, context = 'כללי', order_id, signature } = req.body || {};
    const bc = String(barcode || '').trim();
    if (!bc) return res.status(400).json({ error: 'חסר ברקוד' });
    if (signature !== SIGNATURE_TEXT) return res.status(400).json({ error: 'נדרש אישור חתימה', needSignature: true });
    logManual(bc, order_id || null, context, signature, req.user.name);
    res.json({ ok: true });
  });

  // קליטת החזרה בסריקה — תקין / פגום. מזהה החזרה מאוחרת ומצפצף
  r.post('/return', (req, res) => {
    const { barcode, damaged = false, note, manual = false, signature } = req.body || {};
    const bc = String(barcode || '').trim();
    if (manual && signature !== SIGNATURE_TEXT)
      return res.status(400).json({ error: 'הקלדה ידנית דורשת אישור חתימה', needSignature: true });
    const item = db.prepare('SELECT * FROM items WHERE barcode = ?').get(bc);
    if (!item) return res.status(404).json({ error: 'ברקוד לא נמצא במערכת' });
    const today = isoDate(new Date());
    const oi = db.prepare(`
      SELECT oi.*, o.customer_id, o.id AS order_id, o.return_date, c.name AS customer_name, c.phone AS customer_phone
      FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN customers c ON c.id = o.customer_id
      WHERE oi.item_id = ? AND oi.status IN ('נמסר','החזרה מאוחרת') ORDER BY oi.id DESC LIMIT 1`).get(item.id);
    // החזרה מאוחרת: סומן ככזה, או חזר אחרי תאריך ההחזרה
    const isLate = !!oi && (oi.status === 'החזרה מאוחרת' || (oi.return_date && oi.return_date < today));
    db.transaction(() => {
      // שמלה שחוזרת תקינה חוזרת מיד למלאי (דרישת הלקוחה) — פגומה נשארת "לא תקין"
      const newItemStatus = damaged ? 'לא תקין' : 'זמין';
      db.prepare('UPDATE items SET status = ?, condition_note = ? WHERE id = ?')
        .run(newItemStatus, damaged ? (note || 'הוחזרה פגומה') : item.condition_note, item.id);
      if (oi) {
        db.prepare(`UPDATE order_items SET status = ?, returned_at = datetime('now','localtime') WHERE id = ?`)
          .run(damaged ? 'הוחזר פגום' : 'הוחזר', oi.id);
        const open = db.prepare(`SELECT COUNT(*) c FROM order_items WHERE order_id = ? AND status IN ('משוריין','נמסר','החזרה מאוחרת')`).get(oi.order_id).c;
        if (open === 0) db.prepare(`UPDATE orders SET status = 'הוחזרה' WHERE id = ?`).run(oi.order_id);
        if (damaged) {
          appendCustomerNote(oi.customer_id, `שמלה ${bc} הוחזרה פגומה/מוכתמת${note ? ' — ' + note : ''} (הזמנה ${oi.order_id})`);
          createAutoTask({
            title: `שמלה ${bc} חזרה פגומה מהזמנה ${oi.order_id} (${oi.customer_name}) — לבדוק תיקון/חיוב`,
            category: 'בקרת איכות השמלות',
            uniq_key: `damaged-${bc}-${oi.order_id}`,
          });
        }
        if (isLate) {
          // הודעה מיידית למוקדנית + הערה בכרטיס
          appendCustomerNote(oi.customer_id, `החזרה מאוחרת: שמלה ${bc} חזרה ב-${today} (הזמנה ${oi.order_id})`);
          db.prepare('INSERT INTO messages(from_user, body) VALUES (?,?)').run('מערכת ⏰',
            `החזרה מאוחרת: ${oi.customer_name} החזירה שמלה ${bc} (הזמנה ${oi.order_id}) באיחור`);
        }
      }
      if (manual) logManual(bc, oi?.order_id, 'החזרה', signature, req.user.name);
    })();
    audit(req.user.name, damaged ? 'return.damaged' : 'return.ok', 'item', item.id,
      { status: item.status }, { damaged, note, order: oi?.order_id, late: isLate, manual });
    events.emit('item.returned', { barcode: bc, damaged, late: isLate });
    res.json({
      ok: true, damaged, late: isLate,
      order_id: oi?.order_id || null,
      customer: oi?.customer_name || null,
      customer_phone: oi?.customer_phone || null,
      model: item.model_id, no_open_rental: !oi,
    });
  });

  // סיום סבב ברקודים — כל מה שלא נסרק מסומן "החזרה מאוחרת" (דרישת אפיון)
  r.post('/rounds/close', (req, res) => {
    const today = isoDate(new Date());
    const late = db.prepare(`
      SELECT oi.id AS oi_id, i.barcode, o.id AS order_id, o.customer_id, c.name AS customer_name, c.phone
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN items i ON i.id = oi.item_id
      JOIN customers c ON c.id = o.customer_id
      WHERE oi.status = 'נמסר' AND o.status = 'נמסרה' AND o.delivery_back = 0 AND o.return_date <= ?`).all(today);
    db.transaction(() => {
      for (const l of late) {
        db.prepare(`UPDATE order_items SET status = 'החזרה מאוחרת' WHERE id = ?`).run(l.oi_id);
        appendCustomerNote(l.customer_id, `החזרה מאוחרת: שמלה ${l.barcode} לא הוחזרה עד ${today} (הזמנה ${l.order_id})`);
        createAutoTask({
          title: `גביה/בירור: ${l.customer_name} (${l.phone || 'אין טלפון'}) לא החזירה שמלה ${l.barcode} — הזמנה ${l.order_id}`,
          category: 'בקרה',
          uniq_key: `late-${l.barcode}-${l.order_id}-${today}`,
        });
      }
      db.prepare('INSERT INTO return_rounds(round_date, closed_by, late_count) VALUES (?,?,?)')
        .run(today, req.user.name, late.length);
    })();
    audit(req.user.name, 'round.close', 'return_round', today, null, { late: late.length });
    res.json({ ok: true, late: late.map((l) => ({ barcode: l.barcode, customer: l.customer_name, order: l.order_id })) });
  });

  // ---------- מעקב משפחות שלא החזירו ----------
  // משפחות שקיבלו שמלות, עבר תאריך ההחזרה, ועדיין לא החזירו הכל (לא כולל משלוח חזור)
  r.get('/not-returned', (req, res) => {
    const today = isoDate(new Date());
    const rows = db.prepare(`
      SELECT o.id AS order_id, o.event_date, o.return_date,
             c.id AS customer_id, c.name AS customer_name, c.phone AS customer_phone,
             COUNT(oi.id) AS open_items,
             GROUP_CONCAT(m.code || CASE WHEN oi.size IS NOT NULL THEN '/' || oi.size ELSE '' END, ', ') AS models,
             f.id AS followup_id, f.status AS f_status, f.called AS f_called,
             f.outcome AS f_outcome, f.next_action AS f_next, f.updated_by AS f_by, f.updated_at AS f_at
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      JOIN order_items oi ON oi.order_id = o.id AND oi.status IN ('נמסר','החזרה מאוחרת')
      JOIN models m ON m.id = COALESCE(oi.model_id, (SELECT model_id FROM items WHERE items.id = oi.item_id))
      LEFT JOIN return_followups f ON f.order_id = o.id AND f.status != 'נסגר'
      WHERE o.status = 'נמסרה' AND o.return_date < ? AND o.delivery_back = 0
      GROUP BY o.id ORDER BY o.return_date`).all(today);
    res.json(rows);
  });

  // המשך טיפול פתוח — מה שהמשמרת הקודמת רשמה לטיפול (למשמרת הבאה)
  r.get('/followups', (req, res) => {
    const rows = db.prepare(`
      SELECT f.*, c.name AS customer_name, c.phone AS customer_phone, o.return_date
      FROM return_followups f
      JOIN orders o ON o.id = f.order_id
      LEFT JOIN customers c ON c.id = f.customer_id
      WHERE f.status != 'נסגר' AND f.next_action IS NOT NULL AND f.next_action != ''
      ORDER BY f.updated_at DESC`).all();
    res.json(rows);
  });

  // רישום/עדכון טיפול במשפחה (כובסת פותחת ביציאה, מוקדנית ממשיכה)
  r.post('/followups', (req, res) => {
    const { order_id, called, outcome, next_action, close } = req.body || {};
    const o = db.prepare('SELECT id, customer_id FROM orders WHERE id = ?').get(order_id);
    if (!o) return res.status(404).json({ error: 'הזמנה לא נמצאה' });
    const status = close ? 'נסגר' : 'בטיפול';
    db.prepare(`
      INSERT INTO return_followups(order_id, customer_id, status, called, outcome, next_action, created_by, updated_by, updated_at)
      VALUES (@oid, @cid, @st, @called, @outcome, @next, @by, @by, datetime('now','localtime'))
      ON CONFLICT(order_id) DO UPDATE SET
        status=@st, called=@called, outcome=@outcome, next_action=@next,
        updated_by=@by, updated_at=datetime('now','localtime')`)
      .run({ oid: o.id, cid: o.customer_id, st: status,
             called: called ? 1 : 0, outcome: outcome || null, next: next_action || null, by: req.user.name });
    audit(req.user.name, 'followup.save', 'order', o.id, null, { called: !!called, close: !!close });
    res.json({ ok: true });
  });

  // ---------- בדיקת מלאי (ספירה מול הרשום) ----------
  // הצוות סורקת את מה שנמצא פיזית; המערכת מחזירה: תואם / חסר / עודף.
  r.post('/stock-check', mustManager, (req, res) => {
    const { model_id, scanned } = req.body || {};
    const list = Array.isArray(scanned) ? scanned.map((b) => String(b || '').trim()).filter(Boolean) : [];
    const scannedSet = new Set(list);

    // מה אמור להיות על הסטנד: שמלות פעילות שאינן מושכרות/נגרעות
    const expected = db.prepare(`
      SELECT i.id, i.barcode, i.size, i.status, m.code AS model_code, m.name AS model_name
      FROM items i JOIN models m ON m.id = i.model_id
      WHERE i.active = 1 ${model_id ? 'AND i.model_id = ?' : ''}
      ORDER BY i.barcode`).all(...(model_id ? [model_id] : []));

    const found = [], missing = [], wrongStatus = [];
    for (const it of expected) {
      const onShelf = scannedSet.has(it.barcode);
      if (onShelf) {
        found.push(it);
        // נסרק בפועל אבל רשום כמושכר — אי-התאמה שדורשת בירור
        if (it.status === 'מושכר') wrongStatus.push({ ...it, issue: 'רשומה כמושכרת אבל נמצאת בגמ"ח' });
      } else if (!['מושכר', 'נגרע'].includes(it.status)) {
        // אמורה להיות כאן ולא נמצאה
        missing.push(it);
      }
    }
    // ברקודים שנסרקו ואינם שייכים לדגם שנבדק / לא קיימים במערכת
    const known = new Set(expected.map((e) => e.barcode));
    const extra = [];
    for (const bc of scannedSet) {
      if (known.has(bc)) continue;
      const other = db.prepare(`
        SELECT i.barcode, i.size, i.status, m.code AS model_code, m.name AS model_name
        FROM items i JOIN models m ON m.id = i.model_id WHERE i.barcode = ?`).get(bc);
      extra.push(other ? { ...other, issue: 'שייכת לדגם אחר' } : { barcode: bc, issue: 'לא קיימת במערכת' });
    }
    audit(req.user.name, 'stock.check', 'model', model_id || 'הכל', null,
      { scanned: list.length, found: found.length, missing: missing.length, extra: extra.length });
    res.json({
      summary: { expected: expected.length, scanned: list.length, found: found.length, missing: missing.length, extra: extra.length, conflicts: wrongStatus.length },
      found, missing, extra, wrongStatus,
    });
  });

  // ---------- דוח ברקודים שהוקלדו ידנית ----------
  r.get('/manual-barcodes', mustManager, (req, res) => {
    const date = req.query.date || isoDate(new Date());
    const rows = db.prepare(`
      SELECT mb.*, o.id AS oid, c.name AS customer_name
      FROM manual_barcodes mb
      LEFT JOIN orders o ON o.id = mb.order_id
      LEFT JOIN customers c ON c.id = o.customer_id
      WHERE date(mb.at) = ? ORDER BY mb.at DESC`).all(date);
    res.json({ date, rows });
  });

  // ---------- קופה ----------
  r.post('/transactions', (req, res) => {
    const { order_id, type, method, amount, note } = req.body || {};
    const err = firstError(
      vEnum(type, 'סוג פעולה', ['תשלום', 'החזר', 'דמי ביטול']),
      vEnum(method, 'אמצעי תשלום', PAY_METHODS),
      vAmount(amount, 'סכום', { min: 0.01, max: 50000 }),
      vText(note, 'הערה', { required: false, max: 300 }),
    );
    if (err) return res.status(400).json({ error: err });
    const o = order_id ? db.prepare('SELECT customer_id FROM orders WHERE id = ?').get(order_id) : null;
    if (order_id && !o) return res.status(404).json({ error: 'ההזמנה לא נמצאה' });
    const x = db.prepare(`INSERT INTO transactions(order_id, customer_id, type, method, amount, note, by_user)
                          VALUES (?,?,?,?,?,?,?)`)
      .run(order_id || null, o?.customer_id || null, type, method, +amount, note || null, req.user.name);
    audit(req.user.name, 'cash.' + type, 'transaction', x.lastInsertRowid, null, { order_id, amount, method });
    res.json({ id: x.lastInsertRowid });
  });

  r.get('/cash', mustManager, (req, res) => {
    const from = req.query.from || isoDate(new Date());
    const to = req.query.to || from;
    const rows = db.prepare(`
      SELECT date(at) AS day, type, method, SUM(amount) AS total, COUNT(*) AS cnt
      FROM transactions WHERE date(at) BETWEEN ? AND ? GROUP BY 1,2,3 ORDER BY day DESC`).all(from, to);
    const list = db.prepare(`
      SELECT t.*, c.name AS customer_name FROM transactions t
      LEFT JOIN customers c ON c.id = t.customer_id
      WHERE date(t.at) BETWEEN ? AND ? ORDER BY t.at DESC LIMIT 200`).all(from, to);
    const sum = (type, method) => rows.filter((x) => x.type === type && (!method || x.method === method))
      .reduce((s, x) => s + x.total, 0);
    const cash_in = sum('תשלום', 'מזומן') + sum('דמי ביטול', 'מזומן');
    const credit_in = sum('תשלום', 'אשראי') + sum('דמי ביטול', 'אשראי');
    // שוברי מתנה — נרשמים בנפרד ואינם כסף שנכנס לקופה
    const vouchers = round2(sum('תשלום', VOUCHER_METHOD) + sum('דמי ביטול', VOUCHER_METHOD) - sum('החזר', VOUCHER_METHOD));
    const refunds = sum('החזר');
    const cashRefunds = sum('החזר', 'מזומן') + sum('החזר', 'אשראי');
    res.json({
      from, to, list,
      summary: {
        cash_in, credit_in,
        vouchers,                 // סכום השוברים — מחוץ ליתרת הקופה
        refunds,
        balance: round2(cash_in + credit_in - cashRefunds), // מזומן+אשראי בלבד
      },
    });
  });

  // דוח ביטולים בפיצול נשים/ילדות (דרישת אפיון)
  r.get('/cancellations', mustManager, (req, res) => {
    const rows = db.prepare(`
      SELECT o.id, o.created_at AS registered_at, o.cancelled_at, c.name AS customer_name,
             GROUP_CONCAT(DISTINCT m.code) AS model_codes,
             MAX(m.category) AS category,
             COALESCE((SELECT SUM(amount) FROM transactions WHERE order_id = o.id AND type IN ('תשלום','דמי ביטול')), 0) AS charged,
             COALESCE((SELECT SUM(amount) FROM transactions WHERE order_id = o.id AND type = 'החזר'), 0) AS refunded
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      LEFT JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN items i ON i.id = oi.item_id
      LEFT JOIN models m ON m.id = COALESCE(oi.model_id, i.model_id)
      WHERE o.status = 'בוטלה'
      GROUP BY o.id ORDER BY o.cancelled_at DESC`).all();
    res.json({
      women: rows.filter((x) => x.category === 'נשים'),
      girls: rows.filter((x) => x.category === 'ילדות'),
      other: rows.filter((x) => x.category !== 'נשים' && x.category !== 'ילדות'),
    });
  });

  // מונים לקטגוריות החריגים במסך הראשי
  r.get('/exceptions/counts', (req, res) => {
    const today = isoDate(new Date());
    const c = (sql) => db.prepare(sql).get().c;
    res.json({
      not_taken: c(`SELECT COUNT(*) c FROM orders o WHERE o.status IN ('שריון','מוכנה') AND o.pickup_date <= '${today}'`),
      ready: c(`SELECT COUNT(*) c FROM orders o WHERE o.status = 'מוכנה'`),
      partial: c(`SELECT COUNT(*) c FROM orders o WHERE o.status IN ('שריון','מוכנה','נמסרה')
        AND EXISTS (SELECT 1 FROM order_items x WHERE x.order_id=o.id AND x.status IN ('מוכן','נמסר'))
        AND EXISTS (SELECT 1 FROM order_items x WHERE x.order_id=o.id AND x.status='משוריין')`),
      late: c(`SELECT COUNT(*) c FROM orders o WHERE o.status = 'נמסרה' AND o.return_date < '${today}' AND o.delivery_back = 0
        AND EXISTS (SELECT 1 FROM order_items x WHERE x.order_id=o.id AND x.status IN ('נמסר','החזרה מאוחרת'))`),
      returns: c(`SELECT COUNT(*) c FROM orders o WHERE ${RETURNS_WHERE}`),
      today: c(`SELECT COUNT(*) c FROM orders o WHERE (o.pickup_date = '${today}' OR o.return_date = '${today}') AND o.status IN ('שריון','מוכנה','נמסרה')`),
      drafts: c(`SELECT COUNT(*) c FROM orders o WHERE o.status = 'טיוטה'`),
    });
  });

  return r;
}
