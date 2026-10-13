// מעטפת אפליקציה שולחנית: מריצה את שרת המערכת ופותחת חלון
import { app, BrowserWindow, shell, dialog } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initUpdater } from './updater.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3900;

// מופע יחיד — לחיצה נוספת על האייקון מחזירה את החלון הקיים
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;

  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  // הנתונים של כל התקנה נשמרים בתיקיית המשתמש (AppData) — שורדים עדכוני גרסה
  process.env.GEMACH_DATA_DIR = app.getPath('userData');
  process.env.PORT = String(PORT);

  const waitForServer = async (url, tries = 60) => {
    for (let i = 0; i < tries; i++) {
      try { const r = await fetch(url + '/api/context'); if (r.ok) return true; } catch { /* עדיין עולה */ }
      await new Promise((res) => setTimeout(res, 250));
    }
    return false;
  };

  app.whenReady().then(async () => {
    const url = `http://localhost:${PORT}`;

    // אם השרת כבר רץ על המחשב (עמדה נוספת/הפעלה כפולה) — פשוט מתחברים אליו
    let alive = false;
    try { alive = (await fetch(url + '/api/integration/health')).ok; } catch { /* לא רץ */ }
    if (!alive) {
      try {
        await import('../server.js'); // מדליק את השרת בתוך התהליך
      } catch (e) {
        dialog.showErrorBox('שגיאה בהפעלת המערכת', String(e?.stack || e));
        app.quit();
        return;
      }
      alive = await waitForServer(url);
    }

    win = new BrowserWindow({
      width: 1440,
      height: 920,
      minWidth: 900,
      minHeight: 600,
      autoHideMenuBar: true,
      title: 'מערכת הגמ"ח',
      icon: path.join(__dirname, '..', 'build', 'icon.ico'),
      backgroundColor: '#0b2a4a',
      show: false,
    });
    win.once('ready-to-show', () => { win.maximize(); win.show(); });

    if (alive) win.loadURL(url);
    else {
      dialog.showErrorBox('שגיאה', 'השרת הפנימי לא עלה. נסו להפעיל מחדש את התוכנה.');
      app.quit();
      return;
    }

    // בדיקת עדכוני גרסה (לפי המקור שהוגדר במסך "חיבורים")
    initUpdater(() => win);

    // קישורים חיצוניים נפתחים בדפדפן, לא בתוך האפליקציה
    win.webContents.setWindowOpenHandler(({ url: target }) => {
      if (!target.startsWith(url)) { shell.openExternal(target); return { action: 'deny' }; }
      return { action: 'allow' };
    });

    win.on('closed', () => { win = null; });
  });

  app.on('window-all-closed', () => app.quit());
}
