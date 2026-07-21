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

// Electron's stdout does not reliably reach a redirected shell on Windows, so
// the result is also written here for anything running this unattended.
const LOG_PATH = path.join(os.tmpdir(), 'flint-pdf-smoke.log');
try { fs.unlinkSync(LOG_PATH); } catch { /* first run */ }
// Each PDF is rendered in its own throwaway window, so between them there are
// no windows open at all. Electron's default reaction to that is to quit, which
// silently killed the run part way with exit code 0 and no error. The app itself
// never hits this: it always has the journal window.
app.on('window-all-closed', () => { /* keep the test alive between renders */ });

app.on('ready', async () => {
  let failed = false;
  const lines = [];
  const log = (ok, msg) => {
    const line = `  ${ok ? 'ok  ' : 'FAIL'} ${msg}`;
    console.log(line); lines.push(line);
    if (!ok) failed = true;
  };

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

  // Mirrors renderPdf in main.js exactly: only the fixed-size head travels as a
  // data: URL (so its CSP is parsed and applies), and the body is injected.
  async function toPdf(markup) {
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try {
      const head = (markup.match(/<head[^>]*>([\s\S]*?)<\/head>/i) || [, ''])[1];
      const body = (markup.match(/<body[^>]*>([\s\S]*?)<\/body>/i) || [, ''])[1];
      const shell = `<!doctype html><html lang="en-GB"><head>${head}</head><body></body></html>`;
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(shell));
      await win.webContents.executeJavaScript(`document.body.innerHTML = ${JSON.stringify(body)}; true;`);
      return await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } });
    } finally {
      win.destroy();
      // Let the renderer process finish tearing down before the next window is
      // created, or the next loadURL races it and fails with a misleading
      // ERR_FAILED naming the new URL. Test-harness concern only: the app makes
      // one of these at a time, from a click.
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  try {
    const pdf = await toPdf(html);
    const outPath = path.join(root, 'out.pdf');
    fs.writeFileSync(outPath, pdf);

    const head = pdf.slice(0, 5).toString('latin1');
    log(head === '%PDF-', `output starts with %PDF- (got "${head}")`);
    log(pdf.length > 1000, `PDF is a sensible size (${pdf.length} bytes)`);
    log(blocked === 0, `no network requests attempted (blocked=${blocked})`);
    console.log('  PDF written to: ' + outPath);
  } catch (err) {
    log(false, 'printToPDF threw: ' + err.message);
  }

  // A long-tenured journal. Past roughly 2 MB of URL-encoded document the old
  // data: URL route failed outright with ERR_INVALID_URL, and it got worse the
  // longer someone kept writing, which is the wrong way round for a diary.
  try {
    const big = store.emptyData();
    const para = 'A full day of writing, several sentences long, repeated to build a realistic journal. ';
    for (let i = 0; i < 900; i++) {
      const d = new Date(2024, 0, 1 + i);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      big.entries[iso] = { note: para.repeat(6), updatedAt: 'x' };
    }
    const bigHtml = store.buildExportHtml(big, { questions: store.DEFAULT_QUESTIONS, knownTitles: {} });
    const mb = (bigHtml.length / 1048576).toFixed(2);
    const encodedMb = (encodeURIComponent(bigHtml).length / 1048576).toFixed(2);
    const pdf = await toPdf(bigHtml);
    log(pdf.slice(0, 5).toString('latin1') === '%PDF-', `a ${mb} MB document (${encodedMb} MB URL-encoded, past the old limit) still exports`);
    log(pdf.length > 10000, `and produces a real PDF (${pdf.length} bytes)`);
  } catch (err) {
    log(false, 'large journal export threw: ' + err.message);
  }

  const summary = failed ? '\nPDF smoke test FAILED.' : '\nPDF smoke test passed.';
  console.log(summary);
  try { fs.writeFileSync(LOG_PATH, lines.join('\n') + summary + '\n'); } catch { /* best effort */ }
  app.exit(failed ? 1 : 0);
});
