// ולידציות מרכזיות לכל שדות המערכת.
// כל פונקציה מחזירה מחרוזת שגיאה בעברית, או null אם תקין.

// ---------- טקסט ----------
export function vText(value, label, { required = true, min = 1, max = 200 } = {}) {
  const s = String(value ?? '').trim();
  if (!s) return required ? `${label} — שדה חובה` : null;
  if (s.length < min) return `${label} — קצר מדי (לפחות ${min} תווים)`;
  if (s.length > max) return `${label} — ארוך מדי (עד ${max} תווים)`;
  return null;
}

// ---------- תעודת זהות ישראלית (בדיקת ספרת ביקורת) ----------
export function vTz(value, { required = false } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) return required ? 'תעודת זהות — שדה חובה' : null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 5 || digits.length > 9) return 'תעודת זהות — יש להזין 9 ספרות';
  const id = digits.padStart(9, '0');
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let n = Number(id[i]) * ((i % 2) + 1);
    if (n > 9) n -= 9;
    sum += n;
  }
  if (sum % 10 !== 0) return 'תעודת זהות — מספר לא תקין (בדקי שוב את הספרות)';
  return null;
}

// ---------- טלפון ישראלי ----------
export function vPhone(value, { required = false, label = 'טלפון' } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) return required ? `${label} — שדה חובה` : null;
  const d = raw.replace(/\D/g, '');
  // נייד 05X (10 ספרות) / קווי 0X (9 ספרות) / *כוכבית
  if (!/^0\d{8,9}$/.test(d)) return `${label} — מספר לא תקין (למשל 0501234567 או 025551234)`;
  if (d.startsWith('05') && d.length !== 10) return `${label} — מספר נייד חייב 10 ספרות`;
  if (!d.startsWith('05') && d.length !== 9) return `${label} — מספר קווי חייב 9 ספרות`;
  return null;
}

// ---------- מייל ----------
export function vEmail(value, { required = false } = {}) {
  const s = String(value ?? '').trim();
  if (!s) return required ? 'כתובת מייל — שדה חובה' : null;
  if (!/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(s)) return 'כתובת מייל — פורמט לא תקין';
  return null;
}

// ---------- תאריך ----------
export function vDate(value, label, { required = true, minDate = null, maxDate = null, maxYearsAhead = 3 } = {}) {
  const s = String(value ?? '').trim();
  if (!s) return required ? `${label} — שדה חובה` : null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${label} — פורמט תאריך לא תקין`;
  const d = new Date(s + 'T12:00:00');
  if (isNaN(d.getTime())) return `${label} — תאריך לא קיים`;
  // JavaScript "גולש" בתאריכים לא קיימים (31.2 → 3.3) — מוודאים שהתאריך נשמר כמו שהוזן
  const [yy, mm, dd] = s.split('-').map(Number);
  if (d.getFullYear() !== yy || d.getMonth() + 1 !== mm || d.getDate() !== dd)
    return `${label} — תאריך לא קיים בלוח השנה`;
  const y = d.getFullYear();
  if (y < 2020 || y > new Date().getFullYear() + maxYearsAhead)
    return `${label} — תאריך לא סביר (${y})`;
  if (minDate && s < minDate) return `${label} — לא יכול להיות לפני ${minDate}`;
  if (maxDate && s > maxDate) return `${label} — לא יכול להיות אחרי ${maxDate}`;
  return null;
}

// ---------- סכום כספי ----------
export function vAmount(value, label, { required = true, min = 0, max = 100000, allowZero = false } = {}) {
  if (value === '' || value === null || value === undefined)
    return required ? `${label} — שדה חובה` : null;
  const n = Number(value);
  if (!Number.isFinite(n)) return `${label} — יש להזין מספר`;
  if (n < 0) return `${label} — לא יכול להיות שלילי`;
  if (!allowZero && n === 0 && required) return `${label} — חייב להיות גדול מאפס`;
  if (n < min) return `${label} — לא יכול להיות פחות מ-${min}`;
  if (n > max) return `${label} — סכום חריג (מעל ${max.toLocaleString('he-IL')} ₪). בדקי שוב`;
  if (Math.round(n * 100) !== n * 100) return `${label} — עד שתי ספרות אחרי הנקודה`;
  return null;
}

// ---------- ברקוד ----------
export function vBarcode(value, { required = true } = {}) {
  const s = String(value ?? '').trim();
  if (!s) return required ? 'ברקוד — שדה חובה' : null;
  if (s.length < 3) return 'ברקוד — קצר מדי';
  if (s.length > 30) return 'ברקוד — ארוך מדי';
  if (!/^[\w\-]+$/.test(s)) return 'ברקוד — מותרים ספרות, אותיות ומקף בלבד';
  return null;
}

// ---------- ערך מרשימה סגורה ----------
export function vEnum(value, label, allowed, { required = true } = {}) {
  const s = String(value ?? '').trim();
  if (!s) return required ? `${label} — יש לבחור ערך` : null;
  if (!allowed.includes(s)) return `${label} — ערך לא חוקי (${allowed.join(' / ')})`;
  return null;
}

// ---------- מריץ שרשרת ולידציות ----------
// מקבל מערך של תוצאות ומחזיר את השגיאה הראשונה, או null
export const firstError = (...errors) => errors.find((e) => e) || null;
