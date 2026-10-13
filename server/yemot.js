// חיבור למערכת ימות המשיח — שלוחה טלפונית ללקוחות
// בהגדרות השלוחה בימות המשיח מגדירים api_url שמצביע לכתובת /yemot של השרת.
import { YemotRouter } from 'yemot-router2';
import { db } from './db.js';
import { isoDate } from './hebrew.js';

const HEB_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

// ה-TTS של ימות המשיח לא מקבל את התווים . - " ' & | — נקודה הופכת לפסיק (הפסקה) והשאר נמחקים
const tts = (text) => String(text).replace(/\./g, ',').replace(/[\-"'&|]/g, ' ').replace(/\s+/g, ' ').trim();
const say = (text) => [{ type: 'text', data: tts(text) }];
const speakDate = (iso) => {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  return y ? `${d} ב${HEB_MONTHS[m - 1]}` : '';
};
// מספר הזמנה מוקרא ספרה-ספרה כדי שה-TTS יהגה ברור
const speakDigits = (n) => String(n).split('').join(' ');

function findCustomer(digits) {
  const clean = String(digits || '').replace(/[^\d]/g, '');
  if (!clean) return null;
  return db.prepare(`
    SELECT * FROM customers
    WHERE REPLACE(REPLACE(COALESCE(phone,''), '-', ''), ' ', '') LIKE ?
       OR tz = ?
    LIMIT 1`).get('%' + clean.slice(-9), clean);
}

function activeOrder(customerId) {
  return db.prepare(`
    SELECT o.*, (SELECT COUNT(*) FROM order_items x WHERE x.order_id = o.id AND x.status != 'בוטל') AS items
    FROM orders o WHERE o.customer_id = ? AND o.status IN ('שריון','נמסרה')
    ORDER BY o.event_date LIMIT 1`).get(customerId);
}

export function createYemotRouter() {
  const router = YemotRouter({
    printLog: false,
    timeout: 60000,
    // בלי זה — ניתוק שיחה באמצע מפיל את כל השרת
    uncaughtErrorHandler: (err, call) => {
      console.error('שגיאה בשלוחת ימות המשיח:', err?.message || err);
      try { call.hangup(); } catch { /* השיחה כבר נותקה */ }
    },
  });

  router.get('/', async (call) => {
    try {
      const choice = await call.read(
        say('שלום, הגעתן למערכת המידע של גמח השמלות. לבדיקת מצב הזמנה, הקישי 1. להשארת בקשה לחזרה מהמשרד, הקישי 2.'),
        'tap', { max_digits: 1, digits_allowed: [1, 2] });

      // ---------- 1: מצב הזמנה ----------
      if (choice === '1') {
        // ניסיון זיהוי לפי מספר המתקשרת, ואם לא — לפי ת"ז
        let customer = findCustomer(call.phone);
        if (!customer) {
          const tz = await call.read(
            say('לא זיהינו את המספר ממנו התקשרת. הקישי מספר תעודת זהות ולסיום סולמית.'),
            'tap', { max_digits: 9 });
          customer = findCustomer(tz);
        }
        if (!customer) {
          return call.id_list_message(say('לא נמצאה לקוחה במערכת. ניתן לפנות לגמח בשעות הפעילות. להתראות.'));
        }
        const order = activeOrder(customer.id);
        if (!order) {
          return call.id_list_message(say(`שלום ${customer.name}. לא נמצאה הזמנה פעילה על שמך. להתראות.`));
        }
        const status = order.status === 'שריון'
          ? `ההזמנה משוריינת. איסוף בתאריך ${speakDate(order.pickup_date)}`
          : `השמלות אצלך. החזרה עד תאריך ${speakDate(order.return_date)}`;
        return call.id_list_message(say(
          `שלום ${customer.name}. הזמנה מספר ${speakDigits(order.id)}, לאירוע בתאריך ${speakDate(order.event_date)}, ${order.items} שמלות. ${status}. להתראות.`));
      }

      // ---------- 2: בקשת חזרה ----------
      const customer = findCustomer(call.phone);
      db.prepare('INSERT INTO messages(from_user, body) VALUES (?,?)').run(
        'ימות המשיח ☎️',
        `בקשת חזרה טלפונית מ${customer ? customer.name : 'מספר לא מזוהה'} — ${call.phone || 'חסוי'}`
      );
      return call.id_list_message(say('הבקשה נרשמה. ניצור איתך קשר בשעות הפעילות. תודה ולהתראות.'));
    } catch (err) {
      // ניתוק/תקלה באמצע שיחה לא מפילים את המערכת
      if (!['ExitError', 'HangupError', 'TimeoutError'].includes(err?.name)) {
        console.error('שגיאה בשלוחת ימות:', err?.message || err);
        try { return call.id_list_message(say('אירעה תקלה, נסי שוב מאוחר יותר. להתראות.')); } catch { /* נותק */ }
      }
    }
  });

  return router;
}
