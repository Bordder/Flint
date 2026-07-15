'use strict';

const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  dialog,
  session,
  shell,
  clipboard
} = require('electron');
const path = require('path');
const url = require('url');
const fs = require('fs');
const store = require('./store');

// Auto-update lives ENTIRELY in the main process and uses its own Node HTTPS
// client — it is the one and only thing Flint does over the internet. The
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

// One stable folder for everything, identical whether the app runs from
// source (`npm start`) or from the installed copy:
//   %APPDATA%\Flint            (Chromium's own working files)
//   %APPDATA%\Flint\data       (the journal itself — entries, backups, PIN)
const appDataBase = app.getPath('appData');
const dataRoot = path.join(appDataBase, 'Flint');

// The app used to be called "Journal". If this computer has data from that
// name but no Flint data yet, bring it across so nothing is lost. Best-effort
// and one-time: the old folder is copied (not moved), so it also stays as a
// safety copy. Everything else about the app is unchanged.
migrateFromOldName(appDataBase);
app.setPath('userData', dataRoot);
const paths = store.init(dataRoot);

function migrateFromOldName(base) {
  try {
    const oldData = path.join(base, 'Journal', 'data');
    const newData = path.join(base, 'Flint', 'data');
    if (fs.existsSync(newData)) return; // Flint already has data — never overwrite it
    if (!fs.existsSync(oldData)) return; // nothing from the old name to bring over
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.cpSync(oldData, newData, { recursive: true });
  } catch {
    // If the copy fails, the app still starts (just without the old entries
    // auto-imported); the old folder remains untouched for a manual copy.
  }
}

let win = null;
let allowClose = false;
let closing = false;

// Only one copy of the app may run — two windows writing one file is how
// journals get corrupted.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    lockDownNetwork();
    buildMenu();
    createWindow();
    setupUpdates();
  });
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
// allowed from the app's own folder — a file://host/share URL would be a
// network SMB fetch on Windows, so a blanket file: allowance is not enough.
const appBaseUrl = (url.pathToFileURL(path.join(__dirname, path.sep)).href).toLowerCase();

function isLocalAppUrl(u) {
  const low = u.toLowerCase();
  if (low.startsWith('devtools:') || low.startsWith('data:') || low.startsWith('blob:') || low.startsWith('chrome:')) {
    return true;
  }
  return low.startsWith(appBaseUrl);
}

function lockDownNetwork() {
  const ses = session.defaultSession;
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback(isLocalAppUrl(details.url) ? {} : { cancel: true });
  });
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
}

function createWindow() {
  win = new BrowserWindow({
    width: 880,
    height: 940,
    minWidth: 380,
    minHeight: 520,
    backgroundColor: '#f7f2e9',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false // Electron's spellchecker downloads dictionaries; keep everything offline
    }
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  // Never let the window close over unsaved words without asking. The
  // renderer is asked for its live dirty state at close time (a pushed flag
  // could be stale for words typed in the final instant); no answer within
  // the timeout is treated as dirty — the safe direction.
  win.on('close', (e) => {
    if (allowClose) return;
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
          type: 'question',
          message: 'You have unsaved words on the page.',
          buttons: ['Save and close', 'Close without saving', 'Keep writing'],
          defaultId: 0,
          cancelId: 2,
          noLink: true
        });
        closing = false;
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

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Save this day',
          accelerator: 'CmdOrCtrl+S',
          click: () => win && win.webContents.send('menu', 'save')
        },
        { type: 'separator' },
        {
          label: 'Export to text file…',
          click: () => win && win.webContents.send('menu', 'export')
        },
        {
          label: 'Export to PDF…',
          click: () => win && win.webContents.send('menu', 'export-pdf')
        },
        { type: 'separator' },
        { role: 'quit', label: 'Quit Flint' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'zoomIn', label: 'Larger text' },
        { role: 'zoomOut', label: 'Smaller text' },
        { role: 'resetZoom', label: 'Normal text size' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Where is my data?',
          click: () => shell.openPath(paths.dataDir)
        },
        {
          label: 'About Flint',
          click: () => {
            dialog.showMessageBox(win, {
              type: 'info',
              message: `Flint ${app.getVersion()}`,
              detail:
                'A private daily journal.\n\n' +
                `Your words are stored only on this computer, at:\n${paths.dataFile}\n\n` +
                `Backups of your last ${store.BACKUPS_TO_KEEP} saves are kept in:\n${paths.backupsDir}\n\n` +
                'Your notes never leave this computer. The only thing Flint does ' +
                'online is check for a new version — it downloads updates but never ' +
                'sends your entries anywhere. You can switch that off in Settings.',
              buttons: ['Close'],
              noLink: true
            });
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ------------------------------------------------------------------- IPC

ipcMain.handle('journal:load', async () => {
  try {
    const { data, warning } = await store.loadData();
    return {
      ok: true,
      data,
      warning: warning || null,
      paths: {
        dataDir: paths.dataDir,
        dataFile: paths.dataFile,
        backupsDir: paths.backupsDir,
        settingsFile: paths.settingsFile
      }
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('journal:save', async (_e, data) => {
  try {
    const { backupWarning } = await store.saveData(data);
    return { ok: true, backupWarning: backupWarning || null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

function todayISO() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')
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
      title: 'Save journal as a text file',
      defaultPath: path.join(app.getPath('documents'), `flint-${todayISO()}.txt`),
      filters: [{ name: 'Text file', extensions: ['txt'] }]
    });
    if (canceled || !filePath) return { ok: true, canceled: true };
    const fs = require('fs').promises;
    await fs.writeFile(filePath, text, 'utf8');
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('journal:export-pdf', async () => {
  try {
    const { data, questions, knownTitles } = await exportContext();
    const html = store.buildExportHtml(data, { questions, knownTitles });
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save journal as a PDF',
      defaultPath: path.join(app.getPath('documents'), `flint-${todayISO()}.pdf`),
      filters: [{ name: 'PDF file', extensions: ['pdf'] }]
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
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
  });
  try {
    await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    return await pdfWin.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } // inches
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

const PIN_PATTERN = /^\d{4,10}$/;

ipcMain.handle('pin:status', async () => {
  try {
    return {
      ok: true,
      set: await store.pinIsSet(),
      dataDir: paths.dataDir,
      settingsFile: paths.settingsFile
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

ipcMain.handle('app:open-data-folder', async () => {
  await shell.openPath(paths.dataDir);
  return { ok: true };
});

ipcMain.handle('app:version', async () => ({
  ok: true,
  version: app.getVersion(),
  supported: Boolean(autoUpdater) && app.isPackaged
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
