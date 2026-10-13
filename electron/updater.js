// מנגנון עדכונים אוטומטי — שני ערוצים:
// 1. תיקייה (מקומית/רשת/דרייב מסונכרן): מניחים בה GemachSystem-Setup-X.Y.Z.exe חדש
//    והאפליקציה מציעה להתקין בהפעלה הבאה.
// 2. כתובת http(s): שרת עדכונים סטנדרטי של electron-updater (latest.yml + exe + blockmap).
// מקור העדכון נקבע במסך "חיבורים" ונשמר ל-update-source.txt בתיקיית הנתונים.
import { app, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;

// השוואת גרסאות: 1.2.10 גדולה מ-1.2.9
function cmpVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

// חשוף לבדיקות: סריקת תיקייה ומציאת גרסת ההתקנה הגבוהה ביותר שחדשה מהנוכחית
export function findNewerSetup(dir, currentVersion) {
  if (!dir || !fs.existsSync(dir)) return null;
  let best = null;
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^GemachSystem-Setup-(\d+\.\d+\.\d+)\.exe$/i);
    if (!m) continue;
    if (cmpVersions(m[1], currentVersion) > 0 && (!best || cmpVersions(m[1], best.version) > 0)) {
      best = { version: m[1], file: path.join(dir, f) };
    }
  }
  return best;
}

// זיהוי אוטומטי של תיקיית העדכונים המשותפת — כדי שאף אחת לא תצטרך להדביק נתיב ידנית.
// אם התיקייה GemachUpdates מסונכרנת ב-OneDrive של המשתמשת, המערכת מוצאת אותה לבד.
function autoDetectSource() {
  const bases = [process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial]
    .filter(Boolean);
  for (const b of bases) {
    const p = path.join(b, 'GemachUpdates');
    if (fs.existsSync(p)) return p;
  }
  return '';
}

export function initUpdater(getWin) {
  if (!app.isPackaged) return; // בזמן פיתוח אין עדכונים

  const srcFile = path.join(app.getPath('userData'), 'update-source.txt');
  let source = fs.existsSync(srcFile) ? fs.readFileSync(srcFile, 'utf8').trim() : '';
  // אם לא הוגדר ידנית — מנסים לזהות את תיקיית העדכונים המשותפת אוטומטית
  if (!source) {
    source = autoDetectSource();
    if (source) { try { fs.writeFileSync(srcFile, source); } catch { /* לא קריטי */ } }
  }
  if (!source) return; // אין מקור עדכון בכלל — שקט מוחלט

  // בדיקה 6 שניות אחרי העלייה, כדי לא להאט את הפתיחה
  setTimeout(() => {
    Promise.resolve(
      /^https?:\/\//i.test(source) ? checkHttp(source) : checkFolder(source)
    ).catch((e) => console.error('בדיקת עדכון נכשלה:', e?.message || e));
  }, 6000);

  // ---------- ערוץ אינטרנט ----------
  function checkHttp(url) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true; // גם אם בחרו "אחר כך" — יותקן בסגירה
    autoUpdater.setFeedURL({ provider: 'generic', url });
    autoUpdater.on('error', (e) => console.error('עדכון אוטומטי:', e?.message || e));
    autoUpdater.on('update-downloaded', async (info) => {
      const { response } = await dialog.showMessageBox(getWin(), {
        type: 'info',
        title: 'עדכון מוכן להתקנה',
        message: `גרסה חדשה (${info.version}) ירדה ומוכנה`,
        detail: 'כל הנתונים נשמרים. ההתקנה אורכת פחות מדקה.',
        buttons: ['הפעלה מחדש והתקנה', 'בסגירה הבאה'],
        defaultId: 0, cancelId: 1, noLink: true,
      });
      if (response === 0) autoUpdater.quitAndInstall();
    });
    return autoUpdater.checkForUpdates();
  }

  // ---------- ערוץ תיקייה (דרייב משותף / רשת) ----------
  async function checkFolder(dir) {
    const found = findNewerSetup(dir, app.getVersion());
    if (!found) return;
    const { response } = await dialog.showMessageBox(getWin(), {
      type: 'info',
      title: 'עדכון גרסה זמין',
      message: `נמצאה גרסה חדשה של המערכת: ${found.version} (הנוכחית: ${app.getVersion()})`,
      detail: 'כל הנתונים נשמרים. המערכת תיסגר, אשף ההתקנה ירוץ, ובסיום היא תיפתח מעודכנת.',
      buttons: ['עדכון עכשיו', 'לא כרגע'],
      defaultId: 0, cancelId: 1, noLink: true,
    });
    if (response !== 0) return;
    spawn(found.file, [], { detached: true, stdio: 'ignore' }).unref();
    app.quit();
  }
}
