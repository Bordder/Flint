// Smoke test for the ELECTRON BEHAVIOURS main.js relies on (not shipped).
//
// Read this before trusting it: this script does NOT require main.js and cannot
// verify main.js. It was previously worded as though it did, and passed 14/14
// with main.js deleted from the tree. What it actually checks is that the
// platform behaves the way main.js assumes: that a show:false window reports its
// page as visible until hidden, that hide and show fire and minimise does not,
// that a tray icon can be built from the shipped .ico, and that powerMonitor
// exists. If one of these ever changes in a future Electron, main.js is wrong
// and this is where you find out.
//
// To verify main.js itself, launch it: `electron . --hidden` against Flint-Dev
// and assert from outside that no window is visible.
//   npx electron scripts/tray-smoke.js
//
// It never writes the login item and never touches the real journal: it only
// reads startup settings, and any window it makes is destroyed at the end.
'use strict';

const path = require('path');
const { app, BrowserWindow, Tray, Menu, nativeImage, powerMonitor } = require('electron');
const store = require('../store');

const results = [];
const log = (ok, m, extra) => { results.push(ok); console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${m}${extra ? '  ' + extra : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('ready', async () => {
  const dataRoot = path.join(app.getPath('appData'), 'Flint-Dev');
  app.setPath('userData', dataRoot);
  store.init(dataRoot);

  console.log('\n  tray / background smoke\n');

  // 1. The synchronous startup read, which runs before app.whenReady in main.js
  // and therefore cannot use the async settings API.
  try {
    const flags = store.readStartupFlagsSync();
    log(typeof flags.hardwareAcceleration === 'boolean', 'readStartupFlagsSync returns a usable flag', `hardwareAcceleration=${flags.hardwareAcceleration}`);
  } catch (err) {
    log(false, 'readStartupFlagsSync threw', err.message);
  }

  // 2. A real tray icon, with the real .ico, and a menu that includes the
  // "stop keeping Flint in the tray" escape hatch.
  let tray = null;
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.ico'));
    log(!img.isEmpty(), 'the shipped icon.ico loads as a native image');
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
    tray.setToolTip('Flint');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Flint', click: () => {} },
      { label: 'Stop keeping Flint in the tray', click: () => {} },
      { type: 'separator' },
      { label: 'Quit Flint', click: () => {} }
    ]));
    log(true, 'a tray icon can be created and given a context menu');
  } catch (err) {
    log(false, 'tray creation threw', err.message);
  }

  // 3. The claim behind the biggest fix: a window made with show:false reports
  // its PAGE as visible until it is explicitly hidden, so a --hidden launch was
  // running unthrottled. Prove both halves.
  const win = new BrowserWindow({ show: false, width: 500, height: 400 });
  await win.loadURL('about:blank');

  const beforeHide = await win.webContents.executeJavaScript('document.visibilityState');
  log(win.isVisible() === false, 'a show:false window is not visible to the OS');
  log(beforeHide === 'visible', 'a show:false window still reports visibilityState=visible, so main.js must hide it explicitly', `got "${beforeHide}"`);

  // the fix: hide it explicitly on the startHidden branch
  win.hide();
  await wait(300);
  const afterHide = await win.webContents.executeJavaScript('document.visibilityState');
  log(afterHide === 'hidden', 'hiding a window DOES mark its page hidden, which is what main.js relies on', `got "${afterHide}"`);

  // 4. hide / show events fire, which is what drives the away counter. These
  // must be distinguishable from minimise, which is why main listens to these
  // rather than to visibilitychange.
  let hideFired = 0, showFired = 0;
  win.on('hide', () => { hideFired++; });
  win.on('show', () => { showFired++; });
  win.show();
  await wait(250);
  win.hide();
  await wait(250);
  log(showFired >= 1, 'win.on("show") fires when the window comes back', `count=${showFired}`);
  log(hideFired >= 1, 'win.on("hide") fires when it goes away', `count=${hideFired}`);

  // 5. A minimise must NOT look like a hide, or every minimise would start the
  // away timer.
  const hidesBeforeMinimise = hideFired;
  win.show();
  await wait(200);
  win.minimize();
  await wait(300);
  log(hideFired === hidesBeforeMinimise, 'minimising does not fire hide, so it is not counted as being away');
  win.restore();
  await wait(200);

  // 6. powerMonitor, which carries the lock-on-sleep security hook.
  try {
    let registered = 0;
    for (const ev of ['lock-screen', 'suspend']) { powerMonitor.on(ev, () => {}); registered++; }
    log(registered === 2, 'powerMonitor accepts lock-screen and suspend listeners');
    log(typeof powerMonitor.getSystemIdleTime === 'function', 'powerMonitor is the real module, not a stub');
  } catch (err) {
    log(false, 'powerMonitor registration threw', err.message);
  }

  // 7. Login item settings: READ ONLY. Writing here would edit the real
  // machine's startup registry, which a smoke test has no business doing.
  try {
    const li = app.getLoginItemSettings();
    log(typeof li.openAtLogin === 'boolean', 'login item settings are readable without writing', `openAtLogin=${li.openAtLogin}`);
  } catch (err) {
    log(false, 'getLoginItemSettings threw', err.message);
  }

  // 8. The dev build must be isolated from the installed app's data.
  // Deliberately NOT assertions: this script SET userData itself 90 lines ago,
  // and !app.isPackaged is structurally always true under `electron scripts/...`.
  // Asserting either proved nothing about main.js while reading as though it did.
  console.log(`  note  userData is ${app.getPath('userData')} (set by this script, not by main.js)`);
  console.log(`  note  app.isPackaged=${app.isPackaged} (always false when run this way)`);

  if (tray) { try { tray.destroy(); } catch { /* already gone */ } }
  win.destroy();

  const failed = results.filter((r) => !r).length;
  console.log(`\n  ${results.length - failed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}\n`);
  app.exit(failed ? 1 : 0);
});
