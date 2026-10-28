// נעילת המסך אחרי שעה בלי פעילות.
// המטרה כפולה: שאף אחת לא תמצא מערכת פתוחה על מחשב שהושאר, ושהשעות
// ייסגרו גם כשפשוט סוגרים את הדפדפן בלי ללחוץ יציאה.
(function sessionLock() {
    const IDLE_MS = 60 * 60 * 1000;      // שעה
    const KEY = 'gemach_last_activity';
    const CHECK_MS = 30 * 1000;

    const now = () => Date.now();
    const lastSeen = () => Number(localStorage.getItem(KEY) || 0);
    const stamp = () => localStorage.setItem(KEY, String(now()));

    function loggedIn() {
        try { return !!JSON.parse(localStorage.getItem('gemach_user') || 'null'); } catch { return false; }
    }

    async function lock() {
        const user = JSON.parse(localStorage.getItem('gemach_user') || 'null');
        // סוגרים את המשמרת בשרת לפני שמנקים — אחרת השעות ימשיכו לרוץ.
        // גם אם השליחה נכשלה, השרת סוגר לבד אחרי שעה בלי פעילות.
        if (user) {
            try {
                await fetch('/api/logout', { method: 'POST', headers: { 'x-user-id': String(user.id) } });
            } catch { /* אין רשת — הסגירה תיעשה בשרת */ }
        }
        localStorage.removeItem('gemach_user');
        localStorage.removeItem(KEY);
        sessionStorage.setItem('gemach_locked', '1');
        location.reload();
    }

    function check() {
        if (!loggedIn()) return;
        if (!lastSeen()) { stamp(); return; }
        if (now() - lastSeen() > IDLE_MS) lock();
    }

    // כל פעולה אמיתית של המשתמשת מאריכה את הזמן. scroll ו-mousemove לא
    // נספרים בכוונה: עכבר שזז מעצמו או דף שנגלל לא אומרים שמישהי כאן.
    let pending = false;
    function activity() {
        if (pending) return;
        pending = true;
        setTimeout(() => { pending = false; if (loggedIn()) stamp(); }, 1000);
    }
    for (const evt of ['click', 'keydown', 'input', 'change', 'submit', 'touchstart']) {
        document.addEventListener(evt, activity, true);
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });

    if (loggedIn() && !lastSeen()) stamp();
    check();
    setInterval(check, CHECK_MS);

    // הודעה במסך הכניסה, כדי שלא ייראה כאילו המערכת "זרקה" בלי סיבה
    if (sessionStorage.getItem('gemach_locked')) {
        sessionStorage.removeItem('gemach_locked');
        document.addEventListener('DOMContentLoaded', () => {
            const box = document.getElementById('login-error') || document.getElementById('shareError');
            if (box) box.textContent = 'המערכת ננעלה אחרי שעה בלי פעילות. יש להיכנס שוב עם הקוד האישי.';
        });
    }
})();
