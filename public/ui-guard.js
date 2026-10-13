/* =========================================================================
   ui-guard.js — שומר מסך נגד "תקיעות" של המערכת
   -------------------------------------------------------------------------
   הבעיה שהקובץ הזה פותר:
   המערכת בונה מודאלים בתור <div class="modal-back"> שהוא שכבה על כל המסך
   (position:fixed; inset:0; z-index:100). בזרימות מסוימות השכבה נשארת ב-DOM
   בלי תוכן — למשל ב-orderModal() שמוסיף את השכבה הריקה ל-body ורק אחר כך
   עושה await לשרת: אם הקריאה לשרת נכשלת, ה-innerHTML לעולם לא נכתב,
   ה-back.remove() לעולם לא רץ, ונשארת שכבה שקופה-למחצה שבולעת כל לחיצה.
   המסך נראה תקין לגמרי אבל "מת" — בדיוק התלונה של המשתמשת.

   הקובץ הזה הוא הגנה חיצונית בלבד — הוא לא נוגע בקוד הקיים.
   ========================================================================= */

(function () {
  'use strict';

  /* ---------- הגדרות ---------- */
  const TICK_MS        = 1500;   // כל כמה זמן בודקים את המסך
  const GRACE_MS       = 5000;   // כמה זמן נותנים לשכבה ריקה להתמלא לפני שמסירים
  const GRACE_ERROR_MS = 400;    // אחרי שגיאת JS — מנקים כמעט מיד
  const STUCK_MS       = 30000;  // שכבה בלי אינטראקציה כל כך הרבה זמן → מציעים שחרור
  const SNOOZE_MS      = 60000;  // אחרי שהמשתמשת סוגרת את ההצעה — לא מציקים שוב
  const COVER_RATIO    = 0.9;    // אלמנט שמכסה 90% מהמסך נחשב "חוסם"

  /* ---------- מעקב אחרי שכבות: מתי נולדו ומתי נגעו בהן ---------- */
  const birth    = new WeakMap();  // אלמנט → זמן הופעה ב-DOM
  const touched  = new WeakMap();  // אלמנט → זמן אינטראקציה אחרונה
  let snoozeUntil = 0;             // עד מתי לא להציג את כפתור החילוץ

  const now = () => Date.now();
  const backs = () => Array.from(document.querySelectorAll('.modal-back'));

  function markBirth(node) {
    if (node && node.nodeType === 1 && !birth.has(node)) birth.set(node, now());
  }
  function bornAt(node) {
    if (!birth.has(node)) birth.set(node, now());
    return birth.get(node);
  }

  /* -------------------------------------------------------------------------
     האם לשכבה יש תוכן אמיתי?
     זה הלב של ההגנה — רק שכבה שבאמת ריקה תוסר. מודאל פעיל שהמשתמשת
     עובדת בו כרגע לעולם לא ייחשב ריק.
     ------------------------------------------------------------------------- */
  const SELF_CONTENT = /^(INPUT|IMG|CANVAS|SVG|VIDEO|AUDIO|IFRAME|SELECT|TEXTAREA|BUTTON|HR|EMBED|OBJECT)$/;

  function hasRealContent(layer) {
    if (!layer.children.length) return false;              // <div class="modal-back"></div> — ריק לגמרי
    for (const child of layer.children) {
      if (child.children.length > 0) return true;          // יש בתוכו מבנה → מודאל אמיתי
      if ((child.textContent || '').trim()) return true;   // יש טקסט → תוכן
      if (SELF_CONTENT.test(child.tagName)) return true;   // שדה/תמונה בודדים נחשבים תוכן
    }
    return false;                                          // <div class="modal-back"><div class="modal"></div></div> — יתום
  }

  /* ---------- הודעה קטנה למשתמשת (עצמאית, בלי תלות בקוד המערכת) ---------- */
  function notice(text) {
    const host = document.getElementById('toast-host') || document.body;
    const n = document.createElement('div');
    n.setAttribute('data-ui-guard', 'notice');
    n.textContent = text;
    n.style.cssText =
      'background:#0b2b4d;color:#fff;font-family:Heebo,system-ui,sans-serif;font-size:.9rem;' +
      'padding:11px 16px;border-radius:11px;box-shadow:0 8px 24px rgba(7,26,48,.28);' +
      'border-inline-start:4px solid #34d399;margin-top:10px;max-width:340px;' +
      (host === document.body ? 'position:fixed;bottom:22px;inset-inline-start:22px;z-index:2147483000;' : '');
    host.append(n);
    setTimeout(() => n.remove(), 5000);
  }

  /* -------------------------------------------------------------------------
     1. ניקוי שכבות יתומות — הלב של התיקון
     ------------------------------------------------------------------------- */
  function sweepOrphans(grace) {
    const t = now();
    let removed = 0;
    for (const layer of backs()) {
      if (hasRealContent(layer)) continue;                     // מודאל תקין — לא נוגעים
      if (layer.contains(document.activeElement)) continue;    // המשתמשת מקלידה בתוכו — לא נוגעים
      if (t - bornAt(layer) < grace) continue;                 // עדיין בתוך חלון החסד (אולי נטען מהשרת)
      console.warn('[ui-guard] הוסרה שכבת מודאל יתומה שחסמה את המסך:', layer);
      layer.remove();
      removed++;
    }
    return removed;
  }

  /* -------------------------------------------------------------------------
     2. בדיקת שפיות: אלמנט קבוע שמכסה את המסך, חוסם לחיצות, ואין בו תוכן נראה
        (למשל שכבה של קוד אחר / שריד עיצובי) — מנטרלים לו את חסימת העכבר.
     ------------------------------------------------------------------------- */
  function neutralizeBlockers() {
    const vw = window.innerWidth, vh = window.innerHeight;
    // חלון ממוזער/עדיין לא מוכן — המידות לא אמינות, לא בודקים כלום
    if (vw < 200 || vh < 200) return;
    for (const node of Array.from(document.body.children)) {
      if (node.nodeType !== 1) continue;
      if (node.hasAttribute('data-ui-guard')) continue;        // אלמנטים שלנו
      if (node.dataset.uiGuardOff === '1') continue;           // כבר טופל
      const cs = getComputedStyle(node);
      if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
      if (cs.pointerEvents === 'none' || cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (parseFloat(cs.opacity) === 0) continue;
      const r = node.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;                             // בלי גודל → לא חוסם כלום
      if (r.width < vw * COVER_RATIO || r.height < vh * COVER_RATIO) continue;  // לא מכסה מסך → לא חשוד
      if (hasRealContent(node)) continue;                      // יש בו תוכן → שכבה לגיטימית
      if (node.contains(document.activeElement)) continue;
      if (now() - bornAt(node) < GRACE_MS) continue;
      node.dataset.uiGuardOff = '1';
      node.style.pointerEvents = 'none';
      console.warn('[ui-guard] נוטרלה חסימת עכבר של אלמנט שמכסה את המסך בלי תוכן:', node);
    }
  }

  /* -------------------------------------------------------------------------
     3. חילוץ ידני — מסיר את כל השכבות
     ------------------------------------------------------------------------- */
  function clearAll(reason) {
    const list = backs();
    list.forEach((l) => l.remove());
    document.querySelectorAll('[data-ui-guard-off="1"]').forEach((n) => {
      n.style.pointerEvents = 'none';
    });
    hideRescue();
    if (list.length) {
      console.warn('[ui-guard] שחרור ידני — הוסרו ' + list.length + ' שכבות (' + reason + ')');
      notice('המסך שוחרר ✓');
    }
    return list.length;
  }

  /* ---------- כפתור החילוץ "המסך נתקע?" ---------- */
  let rescueBtn = null;
  function showRescue() {
    if (rescueBtn) return;
    const wrap = document.createElement('div');
    wrap.setAttribute('data-ui-guard', 'rescue');
    wrap.style.cssText =
      'position:fixed;bottom:20px;inset-inline-end:20px;z-index:2147483600;' +
      'display:flex;align-items:center;gap:6px;font-family:Heebo,system-ui,sans-serif;';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'המסך נתקע? לחצי כאן לשחרור';
    btn.style.cssText =
      'font-family:inherit;font-size:.92rem;font-weight:700;cursor:pointer;' +
      'background:#0b2b4d;color:#fff;border:1px solid #fff;border-radius:999px;' +
      'padding:11px 18px;box-shadow:0 10px 30px rgba(7,26,48,.35);';
    btn.addEventListener('click', (e) => { e.stopPropagation(); clearAll('כפתור חילוץ'); });

    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '×';
    x.title = 'סגירת ההודעה';
    x.style.cssText =
      'font-family:inherit;font-size:1.1rem;line-height:1;cursor:pointer;background:#fff;color:#0b2b4d;' +
      'border:1px solid #0b2b4d;border-radius:999px;width:30px;height:30px;box-shadow:0 6px 18px rgba(7,26,48,.25);';
    x.addEventListener('click', (e) => { e.stopPropagation(); snoozeUntil = now() + SNOOZE_MS; hideRescue(); });

    wrap.append(btn, x);
    document.body.append(wrap);
    rescueBtn = wrap;
  }
  function hideRescue() {
    if (rescueBtn) { rescueBtn.remove(); rescueBtn = null; }
  }

  /* ---------- זיהוי שכבה "תקועה" (קיימת מזמן ואף אחד לא נגע בה) ---------- */
  function checkStuck() {
    const t = now();
    if (t < snoozeUntil) return hideRescue();
    const stuck = backs().some((l) => t - bornAt(l) > STUCK_MS && t - (touched.get(l) || bornAt(l)) > STUCK_MS);
    stuck ? showRescue() : hideRescue();
  }

  /* -------------------------------------------------------------------------
     מחזור הבדיקה הקבוע
     ------------------------------------------------------------------------- */
  function tick() {
    try {
      if (sweepOrphans(GRACE_MS)) notice('שוחרר מסך תקוע — אפשר להמשיך לעבוד');
      neutralizeBlockers();
      checkStuck();
    } catch (e) {
      console.error('[ui-guard] שגיאה פנימית בשומר המסך:', e);
    }
  }

  /* -------------------------------------------------------------------------
     מעקב אחרי שינויים ב-DOM — רושם מתי כל שכבה נולדה
     ------------------------------------------------------------------------- */
  const mo = new MutationObserver((records) => {
    for (const rec of records) {
      for (const node of rec.addedNodes) {
        if (node.nodeType !== 1) continue;
        markBirth(node);
        if (node.classList && node.classList.contains('modal-back')) {
          // שכבה חדשה נפתחה — ההצעה לחילוץ כבר לא רלוונטית
          hideRescue();
        }
      }
    }
  });

  /* -------------------------------------------------------------------------
     מאזינים גלובליים
     ------------------------------------------------------------------------- */
  function attachListeners() {
    // אינטראקציה בתוך שכבה = היא חיה, לא תקועה
    const mark = (e) => {
      const layer = e.target && e.target.closest && e.target.closest('.modal-back');
      if (layer) touched.set(layer, now());
    };
    document.addEventListener('pointerdown', mark, true);
    document.addEventListener('keydown', mark, true);
    document.addEventListener('input', mark, true);

    // Esc סוגר את המודאל העליון · Ctrl+Esc מנקה הכל
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (e.isComposing) return;
      if (e.ctrlKey || e.metaKey || e.shiftKey) {           // Ctrl+Esc — חילוץ מלא
        if (clearAll('Ctrl+Esc')) e.preventDefault();
        return;
      }
      const list = backs();
      if (!list.length) return;
      const top = list[list.length - 1];                    // האחרון ב-DOM הוא העליון
      // מודאל של הזמנה חדשה עם נתונים שהוקלדו — לא סוגרים בלי אישור
      if (top.dataset.guard === '1' && hasRealContent(top)) {
        if (!confirm('לסגור את החלון? הפרטים שהוקלדו לא יישמרו.')) return;
      }
      top.remove();
      e.preventDefault();
    }, true);

    // לחיצה כפולה על אזור ריק של השכבה (לא על המודאל עצמו) → ניקוי מלא
    document.addEventListener('dblclick', (e) => {
      if (!e.target || !e.target.classList || !e.target.classList.contains('modal-back')) return;
      clearAll('לחיצה כפולה על הרקע');
    }, true);

    // שגיאת JS לא מטופלת — בדיוק המצב שמשאיר מודאל חצי-בנוי תקוע.
    // לא מסתירים את השגיאה מהקונסול, רק מנקים ומודיעים.
    const onFailure = (label) => {
      setTimeout(() => {
        const removed = sweepOrphans(GRACE_ERROR_MS);
        if (removed) notice('משהו השתבש — המסך שוחרר. אפשר לנסות שוב.');
        console.warn('[ui-guard] ניקוי אחרי ' + label + ' · שכבות שהוסרו: ' + removed);
      }, GRACE_ERROR_MS + 100);
    };
    window.addEventListener('error', () => onFailure('שגיאת JS'));
    window.addEventListener('unhandledrejection', () => onFailure('Promise שנדחה'));
  }

  /* -------------------------------------------------------------------------
     הפעלה
     ------------------------------------------------------------------------- */
  function start() {
    backs().forEach(markBirth);
    mo.observe(document.body, { childList: true, subtree: true });
    attachListeners();
    setInterval(tick, TICK_MS);
    console.log('[ui-guard] שומר המסך פעיל — Esc לסגירת חלון · Ctrl+Esc לשחרור מלא');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  // נקודת כניסה ידנית לבדיקה/תמיכה מהקונסול
  window.__uiGuard = { clearAll, sweepOrphans, hasRealContent };
})();
