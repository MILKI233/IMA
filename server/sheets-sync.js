// סנכרון קריאה-בלבד מהגליונות של קמפיין "אוצרותינו" בימות המשיח — לעולם לא כותבים חזרה לטבלאות.
// הגיליונות פתוחים לצפייה ציבורית, ולכן אפשר למשוך אותם בבקשת GET רגילה בלי מפתחות/הרשאות.
import { parse } from 'csv-parse/sync';

const POINTS_SHEET_ID = '1h-Hj2Wam8UeW6Cn9zg-ovkOc5kf1_evXY9UgBRmmuVA';
const HUBS_SHEET_ID = '1DZ4tcEuNA_ZcCEuOTDaDo5FK7EVypNsD-71_3yWX0sM';

let cache = { participants: [], transactions: [], hubs: [], syncedAt: null, error: null };

async function fetchSheetRows(spreadsheetId, sheetName) {
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`שליפת הגיליון "${sheetName}" נכשלה (${res.status})`);
  const csvText = await res.text();
  const rows = parse(csvText, { columns: true, skip_empty_lines: true, relax_column_count: true });
  return rows;
}

export async function syncCampaignSheets() {
  try {
    const [participants, transactions, hubs] = await Promise.all([
      fetchSheetRows(POINTS_SHEET_ID, 'משתתפים'),
      fetchSheetRows(POINTS_SHEET_ID, 'תנועות'),
      fetchSheetRows(HUBS_SHEET_ID, 'מוקדים ומלאי'),
    ]);
    // התנועות האחרונות קודם — נוח יותר לתצוגה
    transactions.reverse();
    cache = { participants, transactions: transactions.slice(0, 100), hubs, syncedAt: new Date().toISOString(), error: null };
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
  syncCampaignSheets(); // סנכרון ראשון מיידי עם עליית השרת
  syncTimer = setInterval(syncCampaignSheets, 3 * 60 * 1000); // כל 3 דקות
}
