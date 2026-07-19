'use strict';

const {
  app, BrowserWindow, Menu, ipcMain, dialog, session, shell, clipboard, Notification, Tray, nativeImage
} = require('electron');
const path = require('path');
const url = require('url');
const fs = require('fs');
const https = require('https');
const store = require('./store');

// Auto-update lives ENTIRELY in the main process and uses its own Node HTTPS
// client, it is the one and only thing Flint does over the internet. The
// journal window (renderer) stays fully air-gapped by lockDownNetwork(), so
// the part of the app that touches your notes can never make a network call.
// The updater only ever DOWNLOADS (a version manifest + installer) from the
// configured GitHub releases; it has no way to send your entries anywhere.
let autoUpdater = null;
try {
  autoUpdater = require('electron-updater').autoUpdater;
} catch {
  autoUpdater = null; // not installed / dev: updates simply unavailable
}

// Dev vs installed. When run from source (`npm start` / the Testing launcher)
// app.isPackaged is false, this is the TESTING build. It uses a completely
// separate data folder so it can never read or write the real journal:
//   installed:  %APPDATA%\Flint\data
//   testing:    %APPDATA%\Flint-Dev\data
// In dev it also live-reloads the window whenever a renderer file changes.
const isDev = !app.isPackaged;
const appDataBase = app.getPath('appData');
const dataRoot = path.join(appDataBase, isDev ? 'Flint-Dev' : 'Flint');

app.setPath('userData', dataRoot);
const paths = store.init(dataRoot);

let win = null;
let allowClose = false;
let closing = false;
let tray = null;
let quitting = false;          // set when the user really means to quit (tray menu / update install)
let backgroundActive = false;  // true when "keep in the tray" is on
const startHidden = process.argv.includes('--hidden'); // login-item launches with this

// Only one copy of the app may run, two windows writing one file is how
// journals get corrupted.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show(); // it may be hidden in the tray, not just minimised
      win.focus();
    }
  });

  app.whenReady().then(() => {
    lockDownNetwork();
    // No native "File Edit View Help" menu bar, the app has its own in-window
    // top bar. Standard editing shortcuts (Ctrl+C/V/X/Z/A) still work inside the
    // text fields, and Ctrl+S to save is handled in the renderer.
    Menu.setApplicationMenu(null);
    createWindow();
    applyBackgroundMode();
    setupUpdates();
    setInterval(checkReminder, 60 * 1000);
    setTimeout(maybeBackup, 10 * 1000);
    setInterval(maybeBackup, 6 * 60 * 60 * 1000);
  });
}

// Runs the scheduled backup at most once a day, quietly. Like the reminder, a
// backup is a safety net and must never take the app down with it.
async function maybeBackup() {
  try {
    const cfg = await store.getBackupSettings();
    if (!cfg.enabled) return;
    if (cfg.lastRun) {
      const since = Date.now() - new Date(cfg.lastRun).getTime();
      if (Number.isFinite(since) && since < 24 * 60 * 60 * 1000) return;
    }
    await store.runScheduledBackup();
  } catch { /* a failed backup must not disturb the writing */ }
}

// ------------------------------------------------------------- reminder
//
// A local nudge to write, raised as an OS notification on this computer. It is
// off unless the user turns it on, fires at most once a day, only within the
// hour after the chosen time (so a late launch does not nag), and is skipped if
// today is already written. A reminder is a nicety, so nothing here may throw.

let reminderFiredOn = null;

async function todayAlreadyWritten() {
  try {
    const res = await store.loadData();
    if (!res.data) return false; // locked: we cannot tell, so a nudge is fair
    const entry = res.data.entries[todayISO()];
    if (!entry) return false;
    return Object.keys(entry).some((k) => k !== 'updatedAt' && String(entry[k] || '').trim());
  } catch {
    return false;
  }
}

async function checkReminder() {
  try {
    if (!Notification.isSupported()) return;
    const { enabled, time } = await store.getReminder();
    if (!enabled) return;
    const today = todayISO();
    if (reminderFiredOn === today) return;
    const now = new Date();
    const [h, m] = time.split(':').map(Number);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const target = h * 60 + m;
    if (nowMin < target || nowMin > target + 60) return;
    reminderFiredOn = today;
    if (await todayAlreadyWritten()) return;
    const notif = new Notification({ title: 'Flint', body: 'A quiet moment to write today?' });
    notif.on('click', () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } });
    notif.show();
  } catch { /* never let a reminder break the app */ }
}

// ------------------------------------------------------ tray / background
//
// Optional: keep Flint in the tray (and start it with Windows) so the daily
// reminder can reach the user even when the window is closed. Off by default;
// none of this runs unless the user turns it on in Settings.
function showWindow() {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); }
  else createWindow();
}
function ensureTray() {
  if (tray) return;
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.ico'));
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
    tray.setToolTip('Flint');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Flint', click: showWindow },
      { type: 'separator' },
      { label: 'Quit Flint', click: () => { quitting = true; if (win && !win.isDestroyed()) win.close(); else app.quit(); } }
    ]));
    tray.on('click', showWindow);
    tray.on('double-click', showWindow);
  } catch { /* a tray is a nicety; never let it break startup */ }
}
function destroyTray() {
  if (tray) { try { tray.destroy(); } catch { /* already gone */ } tray = null; }
}
async function applyBackgroundMode() {
  let on = false;
  try { on = await store.getRunInBackground(); } catch { on = false; }
  backgroundActive = on;
  if (on) ensureTray(); else destroyTray();
  try { app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] }); } catch { /* best effort */ }
  // Safety net: never sit hidden with no tray to reach (e.g. a stale --hidden
  // launch after background was turned off). If we are not in the tray, show.
  if (!on && win && !win.isDestroyed() && !win.isVisible()) win.show();
}

// ------------------------------------------------------------- auto-update
//
// "Notify, ask before installing": Flint quietly checks GitHub for a newer
// version a few seconds after launch (only if the user hasn't switched it off),
// tells the window if one exists, and does nothing else until the user clicks
// Download, then Install. Offline or any error = silently nothing.

let updateManualCheck = false; // was the in-flight check user-initiated?
let updateBusy = false;

function sendUpdate(status, info) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('update:status', { status, info: info || null, manual: updateManualCheck });
  }
}

function setupUpdates() {
  if (!autoUpdater) return;
  autoUpdater.autoDownload = false; // never download until the user asks
  autoUpdater.autoInstallOnAppQuit = false; // never install without a click
  autoUpdater.on('checking-for-update', () => sendUpdate('checking'));
  autoUpdater.on('update-available', (info) => { updateBusy = false; sendUpdate('available', { version: info && info.version }); });
  autoUpdater.on('update-not-available', () => { updateBusy = false; sendUpdate('none'); });
  autoUpdater.on('error', () => { updateBusy = false; sendUpdate('error'); }); // offline / 404 / anything: stay quiet
  autoUpdater.on('download-progress', (p) => sendUpdate('progress', { percent: Math.max(0, Math.min(100, Math.round((p && p.percent) || 0))) }));
  autoUpdater.on('update-downloaded', (info) => { updateBusy = false; sendUpdate('ready', { version: info && info.version }); });

  setTimeout(() => { runUpdateCheck(false); }, 4000);
}

async function runUpdateCheck(manual) {
  updateManualCheck = manual;
  if (!autoUpdater || !app.isPackaged) {
    if (manual) sendUpdate('unsupported'); // dev run or updater missing
    return;
  }
  if (updateBusy) return;
  let enabled = true;
  try { enabled = await store.getUpdateChecks(); } catch { enabled = true; }
  if (!enabled && !manual) return; // auto-check off; a manual check is always allowed
  updateBusy = true;
  try {
    await autoUpdater.checkForUpdates();
  } catch {
    updateBusy = false;
    sendUpdate('error');
  }
}

// The journal is offline by design. Belt and braces: even if some future
// dependency tried to make a request, every non-local URL is cancelled and
// every permission the page could ask for is refused. file: URLs are only
// allowed from the app's own folder, a file://host/share URL would be a
// network SMB fetch on Windows, so a blanket file: allowance is not enough.
const appBaseUrl = (url.pathToFileURL(path.join(__dirname, path.sep)).href).toLowerCase();

function isLocalAppUrl(u) {
  const low = u.toLowerCase();
  if (low.startsWith('devtools:') || low.startsWith('data:') || low.startsWith('blob:') || low.startsWith('chrome:')) {
    return true;
  }
  return low.startsWith(appBaseUrl);
}

function sealSession(ses) {
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback(isLocalAppUrl(details.url) ? {} : { cancel: true });
  });
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  // The request handler only covers permissions that are ASKED for; a synchronous
  // check would otherwise fall through to Electron's defaults.
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
}

// Both windows we create use the default session, so sealing it seals every
// page. This deliberately does NOT seal every session that gets created: the
// updater runs on its own session in the main process, and cancelling its
// requests would quietly break updates.
function lockDownNetwork() {
  sealSession(session.defaultSession);
}

function createWindow() {
  win = new BrowserWindow({
    width: 880, height: 940, minWidth: 380, minHeight: 520, backgroundColor: '#f7f2e9', show: false,
    frame: false, // Flint draws its own title bar (the top bar) and window buttons
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false // Electron's spellchecker downloads dictionaries; keep everything offline
    }
  });

  // Tell the renderer when the window is maximised so the button can show the
  // right icon. The controls themselves route back through the IPC handlers.
  const sendMaxState = () => { if (win && !win.isDestroyed()) win.webContents.send('window:max-state', win.isMaximized()); };
  win.on('maximize', sendMaxState);
  win.on('unmaximize', sendMaxState);

  win.once('ready-to-show', () => { if (!startHidden) win.show(); });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  if (isDev) {
    // Mark the window so the testing build is never mistaken for the real one,
    // and reload it whenever a renderer file changes, so it always shows the
    // latest edits without a manual rebuild. Renderer-only; main.js changes
    // still need a relaunch. Dev-only: never runs in the installed app.
    win.on('page-title-updated', (e) => { e.preventDefault(); win.setTitle('Flint (Testing)'); });
    let reloadTimer = null;
    for (const dir of [path.join(__dirname, 'renderer'), path.join(__dirname, 'shared')]) {
      try {
        fs.watch(dir, { recursive: true }, () => {
          clearTimeout(reloadTimer);
          reloadTimer = setTimeout(() => {
            if (win && !win.isDestroyed()) win.webContents.reloadIgnoringCache();
          }, 150);
        });
      } catch { /* watching is a convenience; ignore if unavailable */ }
    }
  }

  // Never let the window close over unsaved words without asking. The
  // renderer is asked for its live dirty state at close time (a pushed flag
  // could be stale for words typed in the final instant); no answer within
  // the timeout is treated as dirty, the safe direction.
  win.on('close', (e) => {
    if (allowClose) return;
    // "Keep in the tray" is on: closing the window just hides it (the words on
    // the page are kept in memory), so no save prompt and the app stays alive.
    if (backgroundActive && !quitting) { e.preventDefault(); win.hide(); return; }
    e.preventDefault();
    if (closing) return;
    closing = true;
    askRendererDirty()
      .then(async (isDirty) => {
        if (!isDirty) {
          closing = false;
          allowClose = true;
          win.close();
          return;
        }
        const { response } = await dialog.showMessageBox(win, {
          type: 'question', message: 'You have unsaved words on the page.', buttons: ['Save and close', 'Close without saving', 'Keep writing'], defaultId: 0, cancelId: 2, noLink: true
        });
        closing = false;
        // A resolved dialog spends any tray-quit intent; the real close below
        // uses allowClose, so quitting must not stay stuck (it would break
        // close-to-tray for the rest of the session).
        quitting = false;
        if (response === 0) {
          // The renderer saves, then tells us to close (or shows its own
          // error and cancels the close if the save fails).
          win.webContents.send('app:save-then-close');
        } else if (response === 1) {
          allowClose = true;
          win.close();
        }
      })
      .catch(() => {
        closing = false;
        quitting = false;
      });
  });

  win.on('closed', () => {
    win = null;
  });
}

function askRendererDirty() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const timer = setTimeout(() => finish(true), 700);
    ipcMain.once('app:dirty-reply', (_e, v) => {
      clearTimeout(timer);
      finish(Boolean(v));
    });
    win.webContents.send('app:query-dirty');
  });
}

// ------------------------------------------------------------------- IPC

ipcMain.handle('journal:load', async () => {
  try {
    const res = await store.loadData();
    return {
      ok: true, locked: Boolean(res.locked), data: res.data || null, warning: res.warning || null, paths: {
        dataDir: paths.dataDir, dataFile: paths.dataFile, backupsDir: paths.backupsDir, settingsFile: paths.settingsFile
      }
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('journal:save', async (_e, data, opts) => {
  try {
    const { backupWarning } = await store.saveData(data, opts);
    return { ok: true, backupWarning: backupWarning || null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

function todayISO() {
  const d = new Date();
  return [
    d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')
  ].join('-');
}

async function exportContext() {
  const { data } = await store.loadData();
  const [questions, titles] = await Promise.all([store.loadQuestions(), store.knownTitles()]);
  return { data, questions, knownTitles: titles };
}

ipcMain.handle('journal:export-file', async () => {
  try {
    const { data, questions, knownTitles } = await exportContext();
    const text = store.buildExportText(data, { questions, knownTitles });
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save journal as a text file', defaultPath: path.join(app.getPath('documents'), `flint-${todayISO()}.txt`), filters: [{ name: 'Text file', extensions: ['txt'] }]
    });
    if (canceled || !filePath) return { ok: true, canceled: true };
    const fs = require('fs').promises;
    await fs.writeFile(filePath, text, 'utf8');
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('journal:export-markdown', async () => {
  try {
    const { data, questions, knownTitles } = await exportContext();
    const md = store.buildExportMarkdown(data, { questions, knownTitles });
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save journal as Markdown', defaultPath: path.join(app.getPath('documents'), `flint-${todayISO()}.md`), filters: [{ name: 'Markdown file', extensions: ['md'] }]
    });
    if (canceled || !filePath) return { ok: true, canceled: true };
    await require('fs').promises.writeFile(filePath, md, 'utf8');
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('journal:export-json', async () => {
  try {
    const { data } = await exportContext();
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save journal as JSON', defaultPath: path.join(app.getPath('documents'), `flint-${todayISO()}.json`), filters: [{ name: 'JSON file', extensions: ['json'] }]
    });
    if (canceled || !filePath) return { ok: true, canceled: true };
    await require('fs').promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Import only ever adds days the journal does not already have, so a mistaken
// import can never overwrite something already written.
ipcMain.handle('journal:import-json', async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Import a Flint journal file', properties: ['openFile'], filters: [{ name: 'Flint journal (JSON)', extensions: ['json'] }]
    });
    if (canceled || !filePaths || !filePaths[0]) return { ok: true, canceled: true };
    const raw = await require('fs').promises.readFile(filePaths[0], 'utf8');
    let incoming = null;
    try { incoming = JSON.parse(raw); } catch { return { ok: false, error: 'That file is not readable JSON.' }; }
    if (!incoming || typeof incoming !== 'object' || !incoming.entries || typeof incoming.entries !== 'object' || Array.isArray(incoming.entries)) {
      return { ok: false, error: 'That does not look like a Flint journal file.' };
    }
    const current = await store.loadData();
    if (!current.data) return { ok: false, error: 'Your journal is locked, so nothing was imported.' };
    const { data, added, skipped } = store.mergeImported(current.data, incoming);
    if (added > 0) await store.saveData(data);
    return { ok: true, added, skipped };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('journal:export-pdf', async () => {
  try {
    const { data, questions, knownTitles } = await exportContext();
    const html = store.buildExportHtml(data, { questions, knownTitles });
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save journal as a PDF', defaultPath: path.join(app.getPath('documents'), `flint-${todayISO()}.pdf`), filters: [{ name: 'PDF file', extensions: ['pdf'] }]
    });
    if (canceled || !filePath) return { ok: true, canceled: true };
    const pdf = await renderPdf(html);
    await require('fs').promises.writeFile(filePath, pdf);
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Renders the export HTML to a PDF in a hidden window. The HTML is passed as a
// data: URL (allowed by the offline filter); nothing is fetched from anywhere.
async function renderPdf(html) {
  const pdfWin = new BrowserWindow({
    show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
  });
  // The same guards the main window has. This page is built from journal text,
  // so it gets no way to open a window or navigate anywhere either.
  pdfWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  pdfWin.webContents.on('will-navigate', (e) => e.preventDefault());
  try {
    await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    return await pdfWin.webContents.printToPDF({
      printBackground: true, pageSize: 'A4', margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } // inches
    });
  } finally {
    pdfWin.destroy();
  }
}

ipcMain.handle('journal:copy-all', async () => {
  try {
    const { data, questions, knownTitles } = await exportContext();
    const text = store.buildExportText(data, { questions, knownTitles });
    clipboard.writeText(text);
    const days = Object.keys(data.entries).length;
    return { ok: true, days };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// The discreet "Daily activities summary" (text and PDF variants).
ipcMain.handle('journal:export-activities', async () => {
  try {
    const { data, questions, knownTitles } = await exportContext();
    const text = store.buildActivityReport(data, { questions, knownTitles });
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save activities summary', defaultPath: path.join(app.getPath('documents'), `flint-activities-${todayISO()}.txt`), filters: [{ name: 'Text file', extensions: ['txt'] }]
    });
    if (canceled || !filePath) return { ok: true, canceled: true };
    await require('fs').promises.writeFile(filePath, text, 'utf8');
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('journal:export-activities-pdf', async () => {
  try {
    const { data, questions, knownTitles } = await exportContext();
    const html = store.buildActivityReportHtml(data, { questions, knownTitles });
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save activities summary as a PDF', defaultPath: path.join(app.getPath('documents'), `flint-activities-${todayISO()}.pdf`), filters: [{ name: 'PDF file', extensions: ['pdf'] }]
    });
    if (canceled || !filePath) return { ok: true, canceled: true };
    const pdf = await renderPdf(html);
    await require('fs').promises.writeFile(filePath, pdf);
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('questions:get', async () => {
  try {
    const [questions, titles] = await Promise.all([store.loadQuestions(), store.knownTitles()]);
    return { ok: true, questions, knownTitles: titles };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('questions:set', async (_e, list) => {
  try {
    const questions = await store.saveQuestions(list);
    return { ok: true, questions };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('templates:get', async () => {
  try {
    return { ok: true, templates: await store.loadTemplates() };
  } catch (err) {
    return { ok: false, templates: [], error: err.message };
  }
});

ipcMain.handle('templates:set', async (_e, list) => {
  try {
    return { ok: true, templates: await store.saveTemplates(list) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('activities:get', async () => {
  try {
    return { ok: true, activities: await store.loadActivities() };
  } catch (err) {
    return { ok: false, activities: [], error: err.message };
  }
});

ipcMain.handle('activities:set', async (_e, list) => {
  try {
    return { ok: true, activities: await store.saveActivities(list) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('theme:get', async () => {
  try {
    return { ok: true, theme: await store.getTheme() };
  } catch (err) {
    return { ok: false, theme: 'light', error: err.message };
  }
});

ipcMain.handle('theme:set', async (_e, theme) => {
  try {
    return { ok: true, theme: await store.setTheme(theme) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('accent:get', async () => {
  try {
    return { ok: true, accent: await store.getAccent() };
  } catch (err) {
    return { ok: false, accent: 'coral', error: err.message };
  }
});

ipcMain.handle('accent:set', async (_e, accent) => {
  try {
    return { ok: true, accent: await store.setAccent(accent) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('custom:get', async () => {
  try {
    const { custom, presets } = await store.getCustomTheme();
    return { ok: true, custom, presets };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('custom:set', async (_e, custom) => {
  try {
    return { ok: true, custom: await store.setCustomTheme(custom) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('theme-presets:set', async (_e, list) => {
  try {
    return { ok: true, presets: await store.setThemePresets(list) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Custom title-bar window controls. Close routes through the normal close, so
// the unsaved-words guard still runs.
ipcMain.handle('window:minimize', () => { if (win) win.minimize(); });
ipcMain.handle('window:maximize', () => { if (win) { if (win.isMaximized()) win.unmaximize(); else win.maximize(); } });
ipcMain.handle('window:close', () => { if (win) win.close(); });

ipcMain.handle('background:get', async () => {
  try { return { ok: true, enabled: await store.getRunInBackground() }; }
  catch (err) { return { ok: false, enabled: false, error: err.message }; }
});
ipcMain.handle('background:set', async (_e, on) => {
  try { const enabled = await store.setRunInBackground(on); await applyBackgroundMode(); return { ok: true, enabled }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('guided:get', async () => {
  try {
    return { ok: true, guided: await store.getGuided() };
  } catch (err) {
    return { ok: false, guided: false, error: err.message };
  }
});

ipcMain.handle('guided:set', async (_e, on) => {
  try {
    return { ok: true, guided: await store.setGuided(on) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('backup:get', async () => {
  try {
    return { ok: true, backup: await store.getBackupSettings() };
  } catch (err) {
    return { ok: false, backup: { enabled: false, folder: '', keep: 10, lastRun: '' }, error: err.message };
  }
});

ipcMain.handle('backup:set', async (_e, next) => {
  try {
    return { ok: true, backup: await store.setBackupSettings(next) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// The chosen folder is stored here, in main, and never round-tripped through
// the renderer. A path from the page could be a UNC share, which would turn a
// "local backup" into a copy of the journal sent over the network.
ipcMain.handle('backup:choose-folder', async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Choose a folder for backups', properties: ['openDirectory', 'createDirectory']
    });
    if (canceled || !filePaths || !filePaths[0]) return { ok: true, canceled: true };
    return await store.setBackupFolder(filePaths[0]);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('backup:run-now', async () => {
  try {
    return await store.runScheduledBackup();
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('reminder:get', async () => {
  try {
    return { ok: true, reminder: await store.getReminder() };
  } catch (err) {
    return { ok: false, reminder: { enabled: false, time: '20:00' }, error: err.message };
  }
});

ipcMain.handle('reminder:set', async (_e, next) => {
  try {
    reminderFiredOn = null; // a reminder just turned on may still fire today
    return { ok: true, reminder: await store.setReminder(next) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('daysoff:get', async () => {
  try {
    return { ok: true, days: await store.getDaysOff() };
  } catch (err) {
    return { ok: false, days: [], error: err.message };
  }
});

ipcMain.handle('daysoff:set', async (_e, list) => {
  try {
    return { ok: true, days: await store.setDaysOff(list) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('autolock:get', async () => {
  try {
    return { ok: true, minutes: await store.getAutoLockMinutes() };
  } catch (err) {
    return { ok: false, minutes: 15, error: err.message };
  }
});

ipcMain.handle('autolock:set', async (_e, n) => {
  try {
    return { ok: true, minutes: await store.setAutoLockMinutes(n) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('onboarding:get', async () => {
  try {
    return { ok: true, onboarded: await store.getOnboarded() };
  } catch (err) {
    return { ok: false, onboarded: false, error: err.message };
  }
});

ipcMain.handle('onboarding:done', async () => {
  try {
    await store.setOnboarded(true);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('startedon:get', async () => {
  try {
    return { ok: true, ...(await store.getStartedOn()) };
  } catch (err) {
    return { ok: false, startedOn: '', error: err.message };
  }
});

const PIN_PATTERN = /^\d{4,10}$/;

ipcMain.handle('pin:status', async () => {
  try {
    return {
      ok: true, set: await store.pinIsSet(), dataDir: paths.dataDir, settingsFile: paths.settingsFile
    };
  } catch (err) {
    return { ok: false, set: false, error: err.message };
  }
});

ipcMain.handle('pin:set', async (_e, pin) => {
  if (!PIN_PATTERN.test(String(pin))) {
    return { ok: false, error: 'The PIN must be 4 to 10 digits.' };
  }
  try {
    await store.setPin(String(pin));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('pin:verify', async (_e, pin) => {
  try {
    return { ok: true, valid: await store.verifyPin(String(pin)) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('pin:remove', async (_e, pin) => {
  try {
    const valid = await store.verifyPin(String(pin));
    if (!valid) return { ok: true, valid: false };
    await store.removePin();
    return { ok: true, valid: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------------------------------------------------------------- encryption
//
// Real at-rest encryption. The main process holds the data key in memory only
// while unlocked; it never crosses to the renderer and is never written out.
// The recovery code is returned to the renderer exactly once (on enable) so it
// can be shown to the user, and is never stored anywhere by Flint.

const ENC_PIN_MIN = 4;
const ENC_PIN_MAX = 64;

function validEncPin(pin) {
  const s = String(pin);
  return s.length >= ENC_PIN_MIN && s.length <= ENC_PIN_MAX;
}

// Each of these returns the store result directly (it already carries an `ok`
// flag and, where relevant, an `error` string or the one-time `recoveryCode`).

ipcMain.handle('security:status', async () => {
  try {
    const s = await store.securityStatus();
    return { ok: true, ...s, dataDir: paths.dataDir };
  } catch (err) {
    return { ok: false, encrypted: false, unlocked: true, windowPin: false, error: err.message };
  }
});

ipcMain.handle('security:unlock', async (_e, pin) => {
  try { return await store.unlock(String(pin)); }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('security:unlock-recovery', async (_e, code) => {
  try { return await store.unlockWithRecovery(String(code)); }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('security:lock', async () => {
  try { return store.lock(); }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('security:enable', async (_e, pin) => {
  if (!validEncPin(pin)) return { ok: false, error: `Choose a PIN of ${ENC_PIN_MIN} to ${ENC_PIN_MAX} characters.` };
  try { return await store.enableEncryption(String(pin)); }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('security:disable', async (_e, pin) => {
  try { return await store.disableEncryption(String(pin)); }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('security:change-pin', async (_e, currentPin, newPin) => {
  if (!validEncPin(newPin)) return { ok: false, error: `Choose a new PIN of ${ENC_PIN_MIN} to ${ENC_PIN_MAX} characters.` };
  try { return await store.changeEncryptionPin(String(currentPin), String(newPin)); }
  catch (err) { return { ok: false, error: err.message }; }
});

// After a recovery-code unlock the user picks a new PIN, and that rotation is
// what actually retires the forgotten PIN and the spent code.
ipcMain.handle('security:reset-after-recovery', async (_e, newPin) => {
  if (!validEncPin(newPin)) return { ok: false, error: `Choose a PIN of ${ENC_PIN_MIN} to ${ENC_PIN_MAX} characters.` };
  try { return await store.resetSecretsAfterRecovery(String(newPin)); }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('security:check-pin', async (_e, pin) => {
  try { return await store.checkEncryptionPin(String(pin)); }
  catch (err) { return { ok: false, valid: false, error: err.message }; }
});

// Copy a short string (the one-time recovery code) to the clipboard on request.
// It is already in the renderer; this just reaches the OS clipboard from main.
ipcMain.handle('app:copy-text', async (_e, text) => {
  clipboard.writeText(String(text == null ? '' : text));
  return { ok: true };
});

ipcMain.handle('app:open-data-folder', async () => {
  await shell.openPath(paths.dataDir);
  return { ok: true };
});

ipcMain.handle('app:reset-all', async () => {
  try {
    const res = await store.resetAll();
    if (res.ok) {
      // Reset wipes settings, so background mode is off again: drop the tray and
      // the start-with-Windows entry, then come back up as a fresh install.
      await applyBackgroundMode();
      if (win && !win.isDestroyed()) {
        setImmediate(() => { if (win && !win.isDestroyed()) win.webContents.reloadIgnoringCache(); });
      }
    }
    return res;
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Feedback goes straight to the developer over the internet from the MAIN
// process, not the renderer: the journal window is network-sealed by
// lockDownNetwork() and its CSP blocks fetch/XHR and form submissions, so the
// only way out is Node's own HTTPS client here. The endpoint is fixed in code;
// the renderer never supplies a URL. No journal data is ever included.
const FEEDBACK_ENDPOINT = 'https://formspree.io/f/mkodjaqq';

// POST a JSON body to urlStr and resolve { status, body }. Rejects on a
// transport error or a 15s timeout; it never sends anything but the object given.
function postJson(urlStr, obj) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const body = JSON.stringify(obj);
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST', headers: {
        'Content-Type': 'application/json', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('The feedback service did not respond in time.')));
    req.write(body);
    req.end();
  });
}

ipcMain.handle('feedback:send', async (_e, payload) => {
  try {
    const p = payload && typeof payload === 'object' ? payload : {};
    const text = String(p.text == null ? '' : p.text).slice(0, 4000);
    const name = String(p.name == null ? '' : p.name).slice(0, 60);
    if (!text.trim()) return { ok: false, error: 'Nothing to send.' };
    const { status } = await postJson(FEEDBACK_ENDPOINT, {
      message: text, name, _subject: 'Flint feedback from ' + name
    });
    if (status >= 200 && status < 300) return { ok: true };
    return { ok: false, error: 'The feedback service returned ' + status + '.' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('app:version', async () => ({
  ok: true, version: app.getVersion(), supported: Boolean(autoUpdater) && app.isPackaged
}));

ipcMain.handle('update:check', async () => {
  await runUpdateCheck(true);
  return { ok: true };
});

ipcMain.handle('update:download', async () => {
  if (!autoUpdater) return { ok: false };
  try {
    updateBusy = true;
    autoUpdater.downloadUpdate();
    return { ok: true };
  } catch {
    updateBusy = false;
    sendUpdate('error');
    return { ok: false };
  }
});

ipcMain.handle('update:install', async () => {
  if (!autoUpdater) return { ok: false };
  allowClose = true; // the user chose to install; don't re-prompt the close guard
  setImmediate(() => {
    try { autoUpdater.quitAndInstall(); } catch { /* nothing we can do */ }
  });
  return { ok: true };
});

ipcMain.handle('update:get-setting', async () => {
  try {
    return { ok: true, enabled: await store.getUpdateChecks() };
  } catch (err) {
    return { ok: false, enabled: true, error: err.message };
  }
});

ipcMain.handle('update:set-setting', async (_e, on) => {
  try {
    return { ok: true, enabled: await store.setUpdateChecks(on) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.on('app:close-now', () => {
  allowClose = true;
  if (win) win.close();
});

app.on('window-all-closed', () => {
  app.quit();
});
