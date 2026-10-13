import { HDate, Sedra, Locale, HebrewCalendar, gematriya, flags } from '@hebcal/core';

// יום שהגמ"ח סגור: שבת או יום טוב (שאסור בו במלאכה)
export function isRestDay(d) {
  if (d.getDay() === 6) return true; // שבת
  const evs = HebrewCalendar.getHolidaysOnDate(new HDate(d), true) || [];
  return evs.some((e) => (e.getFlags() & flags.CHAG) || (e.getFlags() & flags.YOM_TOV_ENDS));
}

// איסוף: יומיים לפני האירוע, אבל אם נופל בשבת/יו"ט — מקדימים ליום פתוח
export function pickupDate(eventDate, daysBefore = 2) {
  const d = new Date(eventDate);
  d.setDate(d.getDate() - daysBefore);
  let guard = 0;
  while (isRestDay(d) && guard++ < 14) d.setDate(d.getDate() - 1);
  return d;
}

// החזרה: יום אחרי האירוע, אבל אם נופל בשבת/יו"ט — דוחים ליום פתוח
export function returnDate(eventDate, daysAfter = 1) {
  const d = new Date(eventDate);
  d.setDate(d.getDate() + daysAfter);
  let guard = 0;
  while (isRestDay(d) && guard++ < 14) d.setDate(d.getDate() + 1);
  return d;
}

const stripNikud = (s) => s.replace(/[֑-ׇ]/g, '');

export function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function upcomingSaturday(d) {
  const sat = new Date(d);
  sat.setDate(sat.getDate() + ((6 - sat.getDay() + 7) % 7));
  return sat;
}

const heb = (s) => stripNikud(Locale.gettext(s, 'he') || s);

// מידע יומי לתא בלוח השנה: יום עברי, חג, פרשה (בשבת)
export function dayInfo(d) {
  const hd = new HDate(d);
  let parsha = null;
  if (d.getDay() === 6) {
    const lk = new Sedra(hd.getFullYear(), true).lookup(hd);
    parsha = lk.parsha.map(heb).join('־');
  }
  const evs = HebrewCalendar.getHolidaysOnDate(hd, true) || [];
  return {
    hebDay: gematriya(hd.getDate()) + (hd.getDate() === 1 ? ' ' + heb(hd.getMonthName()) : ''),
    holiday: evs.length ? stripNikud(evs[0].render('he')) : null,
    parsha,
  };
}

// כותרת חודש עברית לטווח (למשל "תמוז–אב תשפ״ו")
export function hebMonthTitle(start, end) {
  const h1 = new HDate(start), h2 = new HDate(end);
  const m1 = heb(h1.getMonthName()), m2 = heb(h2.getMonthName());
  const year = stripNikud(h2.renderGematriya()).split(' ').pop(); // למשל: תשפ״ו
  return (m1 === m2 ? m1 : `${m1}–${m2}`) + ' ' + year;
}

// כל המפתחות התקופתיים לתאריך נתון + מידע תצוגה עברי
export function hebInfo(d = new Date()) {
  const hd = new HDate(d);
  const sedra = new Sedra(hd.getFullYear(), true); // מנהג ארץ ישראל
  const lk = sedra.lookup(hd);
  const parsha = lk.parsha.map((x) => stripNikud(Locale.gettext(x, 'he') || x)).join('־');

  const sat = upcomingSaturday(d);
  const satDayNum = Math.floor(sat.getTime() / 86400000);
  const r = satDayNum % 14;
  const blockEndSat = new Date(sat);
  if (r < 7) blockEndSat.setDate(blockEndSat.getDate() + 7);

  const friday = new Date(sat);
  friday.setDate(friday.getDate() - 1);
  const bwFriday = new Date(blockEndSat);
  bwFriday.setDate(bwFriday.getDate() - 1);

  // סוף חודש עברי
  const monthEnd = new HDate(hd.daysInMonth(), hd.getMonth(), hd.getFullYear()).greg();
  // סוף רבעון אזרחי
  const q = Math.floor(d.getMonth() / 3);
  const quarterEnd = new Date(d.getFullYear(), q * 3 + 3, 0);

  return {
    hdateStr: stripNikud(hd.renderGematriya()),
    parsha,
    isShabbatWeekday: d.getDay() >= 0 && d.getDay() <= 4, // א'-ה'
    keys: {
      daily: `d-${isoDate(d)}`,
      weekly: `w-${isoDate(sat)}`,
      biweekly: `bw-${Math.floor(satDayNum / 14)}`,
      monthly: `m-${hd.getFullYear()}-${hd.getMonth()}`,
      quarterly: `q-${d.getFullYear()}-Q${q + 1}`,
    },
    dues: {
      daily: isoDate(d),
      weekly: isoDate(friday),
      biweekly: isoDate(bwFriday),
      monthly: isoDate(monthEnd),
      quarterly: isoDate(quarterEnd),
    },
    labels: {
      daily: `יום ${'אבגדהוש'[d.getDay()]}׳`,
      weekly: `שבוע פרשת ${parsha}`,
      biweekly: 'דו־שבועי',
      monthly: `חודש ${stripNikud(Locale.gettext(hd.getMonthName(), 'he') || hd.getMonthName())}`,
      quarterly: `רבעון ${q + 1} ${d.getFullYear()}`,
    },
  };
}
