// סנכרון מהגליונות של קמפיין "אוצרותינו" בימות המשיח.
// קריאה: ישירות מהגיליון הציבורי (CSV), בלי מפתחות.
// כתיבה (אופציונלי): דרך סקריפט Apps Script שהמנהלת מפרסמת בעצמה מהגיליון שלה, עם סיסמת אישור בתוכנה.
import { parse } from 'csv-parse/sync';
import { getAllCampaignSettings } from './db.js';

export const POINTS_SHEET_ID = '1h-Hj2Wam8UeW6Cn9zg-ovkOc5kf1_evXY9UgBRmmuVA';
export const HUBS_SHEET_ID = '1DZ4tcEuNA_ZcCEuOTDaDo5FK7EVypNsD-71_3yWX0sM';
// תשובות לטופס "תודה על תרומתך" — מוצרים שגויסו בפועל, ממולא על ידי המגייסות אחרי שעסק תרם
export const RECRUITED_PRODUCTS_SHEET_ID = '1qkuii5yPOC5kbQkxX3oxIK6FX37Ok2VbzVWQ-_OdR0o';
// לשונית ההזנה הידנית של נקודות. הסקריפט של המנהלת בגיליון קולט כל שורה חדשה
// ומזכה את המתנדבת, ולכן עמודת הנקודות היא האחרונה שממלאים.
export const MANUAL_POINTS_TAB = 'נקודות ידניות';
export const MANUAL_POINTS_COLS = {
  phone: 'טלפון',
  description: 'תיאור (על מה)',
  points: 'נקודות (אפשר מינוס להורדה) - למלא אחרון',
  status: 'סטטוס (אוטומטי, לא לגעת)',
};

let cache = { participants: [], transactions: [], hubs: [], kitRecipients: [], recruitedProducts: [], manualPoints: [], syncedAt: null, error: null };

// הטופס עצמו (לא רק הגיליון) — כותרת העמודה H ענקית כי התיאור של השאלה מוטמע בה, אז קוראים לפי מיקום ולא לפי שם
const RECRUITED_PRODUCTS_FIELDS = [
  'timestamp', 'recruiterName', 'recruiterPhone', 'businessName', 'businessPhone', 'businessEmail',
  'productDescription', 'productValue', 'pickup', 'validity', 'logoUrl', 'notes', 'filledBy',
];

async function fetchRecruitedProducts() {
  const url = `https://docs.google.com/spreadsheets/d/${RECRUITED_PRODUCTS_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('תגובות לטופס 1')}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`שליפת טופס גיוס המוצרים נכשלה (${res.status})`);
  const csvText = await res.text();
  const rows = parse(csvText, { columns: false, skip_empty_lines: false, relax_column_count: true });
  return rows
    .slice(1) // דילוג על שורת הכותרות
    .map((cols) => Object.fromEntries(RECRUITED_PRODUCTS_FIELDS.map((f, i) => [f, cols[i] ?? ''])))
    .filter((r) => Object.values(r).some((v) => String(v).trim() !== ''))
    .reverse(); // החדש ביותר קודם
}

export async function fetchSheetRows(spreadsheetId, sheetName) {
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`שליפת הגיליון "${sheetName}" נכשלה (${res.status})`);
  const csvText = await res.text();
  // לא מדלגים על שורות ריקות בשלב הפענוח — כדי שמספר השורה (__row) ישקף נכון את השורה האמיתית בגיליון
  const rows = parse(csvText, { columns: true, skip_empty_lines: false, relax_column_count: true });
  return rows
    .map((r, i) => ({ ...r, __row: i + 2 })) // שורה 1 = כותרות
    .filter((r) => Object.keys(r).some((k) => k !== '__row' && String(r[k] ?? '').trim() !== ''));
}

export async function syncCampaignSheets() {
  try {
    const [participants, transactions, hubs, kitRecipients, recruitedProducts, manualPoints] = await Promise.all([
      fetchSheetRows(POINTS_SHEET_ID, 'משתתפים'),
      fetchSheetRows(POINTS_SHEET_ID, 'תנועות'),
      fetchSheetRows(HUBS_SHEET_ID, 'מוקדים ומלאי'),
      fetchSheetRows(HUBS_SHEET_ID, 'מקבלי ערכות'),
      fetchRecruitedProducts(),
      fetchSheetRows(POINTS_SHEET_ID, MANUAL_POINTS_TAB),
    ]);
    transactions.reverse();
    kitRecipients.reverse();
    cache = { participants, transactions: transactions.slice(0, 100), hubs, kitRecipients, recruitedProducts, manualPoints, syncedAt: new Date().toISOString(), error: null };
  } catch (e) {
    cache = { ...cache, error: e.message, syncedAt: cache.syncedAt };
    console.error('סנכרון גליונות הקמפיין נכשל:', e.message);
  }
  return cache;
}

export function getCampaignSheetsCache() {
  return cache;
}

let syncTimer = null;
export function scheduleCampaignSheetsSync() {
  if (syncTimer) clearInterval(syncTimer);
  syncCampaignSheets();
  syncTimer = setInterval(syncCampaignSheets, 3 * 60 * 1000);
}

// כתיבה חזרה לגיליון — רק אם המנהלת חיברה סקריפט Apps Script וסיסמת אישור בהגדרות הקמפיין
export async function pushSheetUpdate({ spreadsheetId, sheetName, row, updates }) {
  const settings = getAllCampaignSettings();
  const url = settings.campaign_sheets_write_url;
  const secret = settings.campaign_sheets_write_secret;
  if (!url || !secret) throw new Error('סנכרון הכתיבה לטבלה לא מוגדר עדיין (חסר קישור סקריפט או סיסמה בהגדרות הקמפיין)');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret, spreadsheetId, sheetName, row, updates }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `הכתיבה לטבלה נכשלה (${res.status})`);
  return data;
}

export function checkSyncPassword(pw) {
  const settings = getAllCampaignSettings();
  const expected = settings.campaign_sync_admin_password;
  if (!expected) throw new Error('לא הוגדרה סיסמת אישור לסנכרון כתיבה בהגדרות הקמפיין');
  if (String(pw || '') !== String(expected)) throw new Error('סיסמת מנהל שגויה');
}
