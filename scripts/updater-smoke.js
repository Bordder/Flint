// Offline-safety smoke test for the auto-update path (not shipped).
// Proves three things about electron-updater as wired in main.js:
//   1. it loads and can run a check;
//   2. it reaches GitHub over the network from the MAIN process
//      (a nonexistent repo returns 404, which is handled, not crashed);
//   3. it does NOT travel through the renderer air-gap filter — so the
//      window that holds your notes stays fully sealed off from the network.
//   npx electron scripts/updater-smoke.js
'use strict';

const { app, session } = require('electron');
const { autoUpdater } = require('electron-updater');

app.on('ready', async () => {
  let failed = false;
  const log = (ok, m) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${m}`); if (!ok) failed = true; };

  // the exact air-gap filter main.js puts on the renderer session
  let blocked = 0;
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
    const u = d.url.toLowerCase();
    const local = u.startsWith('file:') || u.startsWith('data:') || u.startsWith('devtools:') || u.startsWith('blob:') || u.startsWith('chrome:');
    if (!local) blocked++;
    cb(local ? {} : { cancel: true });
  });

  autoUpdater.autoDownload = false;
  autoUpdater.forceDevUpdateConfig = true; // allow a check outside a packaged build
  autoUpdater.setFeedURL({ provider: 'github', owner: 'nonexistent-xyz-abc-12345', repo: 'nope' });

  let gotError = null;
  autoUpdater.on('error', (e) => { gotError = String((e && e.message) || e); });

  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    gotError = gotError || String((e && e.message) || e);
  }
  await new Promise((r) => setTimeout(r, 1500)); // let events settle

  log(!!gotError, `check produced a handled result, no crash: ${gotError ? gotError.slice(0, 70) : 'none'}`);
  log(/404|HttpError|status code/i.test(gotError || ''), 'updater reached GitHub (404 for the nonexistent test repo)');
  log(blocked === 0, `updater used its own path, not the renderer air-gap (renderer-blocked=${blocked})`);

  console.log(failed ? '\nUpdater smoke test FAILED.' : '\nUpdater smoke test passed.');
  app.exit(failed ? 1 : 0);
});
