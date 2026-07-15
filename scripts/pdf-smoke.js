// Offline smoke test for the real PDF pipeline (not shipped; not in build.files).
// Runs the exact buildExportHtml + printToPDF path main.js uses, with the
// network locked down, and checks the result is a valid PDF.
//   npx electron scripts/pdf-smoke.js
'use strict';

const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../store');

app.on('ready', async () => {
  let failed = false;
  const log = (ok, msg) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failed = true; };

  // same offline lockdown as the app: cancel every non-local request
  let blocked = 0;
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    const u = details.url.toLowerCase();
    const local = u.startsWith('data:') || u.startsWith('devtools:') || u.startsWith('blob:') || u.startsWith('chrome:') || u.startsWith('file:');
    if (!local) blocked++;
    cb(local ? {} : { cancel: true });
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-pdf-'));
  store.init(root);

  const data = store.emptyData();
  data.entries['2026-01-15'] = { walking: 'Two rests on the way to the shop.', __day: 'hard', __tags: ['knee', 'a & b'], updatedAt: 'x' };
  data.entries['2026-03-02'] = { food: 'Bread & butter <ok>. Line one.\nLine two.', updatedAt: 'x' };

  const html = store.buildExportHtml(data, { questions: store.DEFAULT_QUESTIONS, knownTitles: {}, now: new Date('2026-07-16T10:00:00') });

  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } });
    const outPath = path.join(root, 'out.pdf');
    fs.writeFileSync(outPath, pdf);

    const head = pdf.slice(0, 5).toString('latin1');
    log(head === '%PDF-', `output starts with %PDF- (got "${head}")`);
    log(pdf.length > 1000, `PDF is a sensible size (${pdf.length} bytes)`);
    log(blocked === 0, `no network requests attempted (blocked=${blocked})`);
    console.log('  PDF written to: ' + outPath);
  } catch (err) {
    log(false, 'printToPDF threw: ' + err.message);
  } finally {
    win.destroy();
  }

  console.log(failed ? '\nPDF smoke test FAILED.' : '\nPDF smoke test passed.');
  app.exit(failed ? 1 : 0);
});
