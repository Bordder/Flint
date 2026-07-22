// Plain-Node tests for the data layer. Run with: npm test
// They use a throwaway temp folder and never touch real journal data.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require("path");
const fsp = fs.promises;

const store = require('../store');
const prompts = require('../shared/prompts');

// Every throwaway data root this run creates, swept once at the very end.
//
// Deliberately NOT per test. The suite is ordered, and several roots outlive
// the test that made them: the shared root at the top of main() carries a
// backup ring written by one test and read back by another, and the crypto
// block's root is created outside any test and threaded through the eighteen
// that follow it. A tidy-looking rmSync in each finally breaks both.
//
// Left unswept, one run leaked 32 directories. Across a day of development and
// the mutation harness, which re-runs the whole suite once per mutant, that had
// reached 1,587 roots and 232 MB. Nothing in them is real journal data (every
// root is a fresh mkdtemp that the tests populate with fixtures), but folders
// full of journal-shaped JSON should not pile up on anyone's disk.
const tempRoots = [];
function tempRoot(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

// An exit hook rather than a finally: the suite ends via process.exit() on both
// the passing and failing paths, and an early throw lands in main().catch,
// which exits too. Only an exit hook covers all three.
process.on('exit', () => {
  for (const dir of tempRoots) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
    catch { /* a leftover temp folder must never be what fails the run */ }
  }
});

async function main() {
  const root = tempRoot('journal-test-');
  const P = store.init(root);
  let failures = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  ok    ${name}`);
    } catch (err) {
      failures++;
      console.error(`  FAIL  ${name}`);
      console.error('        ' + (err && err.message));
    }
  }

  await test('fresh start loads empty data', async () => {
    const { data, warning } = await store.loadData();
    assert.deepStrictEqual(data, { version: 1, entries: {} });
    assert.strictEqual(warning, undefined);
  });

  await test('save then load round-trips', async () => {
    const data = store.emptyData();
    data.entries['2026-07-14'] = { food: 'Made toast, needed a rest after.', updatedAt: 'x' };
    await store.saveData(data);
    const { data: loaded } = await store.loadData();
    assert.deepStrictEqual(loaded, data);
    assert.ok(fs.existsSync(P.dataFile), 'entries.json exists');
  });

  await test('every save writes a backup, pruned to the newest 30', async () => {
    const data = store.emptyData();
    for (let i = 0; i < 35; i++) {
      data.entries['2026-01-01'] = { other: `save number ${i}` };
      await store.saveData(data);
    }
    const backups = fs
      .readdirSync(P.backupsDir)
      .filter((n) => /^entries-.*\.json$/.test(n))
      .sort();
    assert.ok(backups.length <= store.BACKUPS_TO_KEEP, `kept ${backups.length}`);
    assert.ok(backups.length >= 25, 'a healthy number of backups exist');
    const newest = JSON.parse(
      fs.readFileSync(path.join(P.backupsDir, backups[backups.length - 1]), 'utf8')
    );
    assert.strictEqual(newest.entries['2026-01-01'].other, 'save number 34');
  });

  await test('autosave (backup:false) updates the main file but writes no backup', async () => {
    // Its own root so the extra saves never disturb the shared backup ring that
    // later ordering-sensitive tests (corruption recovery) rely on.
    const rootA = tempRoot('journal-autosave-');
    const PA = store.init(rootA);
    try {
      const data = store.emptyData();
      data.entries['2026-02-02'] = { note: 'checkpoint' };
      await store.saveData(data); // a real save, one backup
      const countBackups = () =>
        fs.readdirSync(PA.backupsDir).filter((n) => /^entries-.*\.json$/.test(n)).length;
      const before = countBackups();
      // Many autosave ticks must not add a single backup...
      for (let i = 0; i < 20; i++) {
        data.entries['2026-02-02'] = { note: `tick ${i}` };
        await store.saveData(data, { backup: false });
      }
      assert.strictEqual(countBackups(), before, 'no backups added by autosave ticks');
      // ...yet every word is on disk in the main file.
      const loaded = await store.loadData();
      assert.strictEqual(loaded.data.entries['2026-02-02'].note, 'tick 19');
    } finally {
      store.init(root); // restore the shared root for later tests
    }
  });

  await test('no .tmp file is left behind after saving', async () => {
    assert.ok(!fs.existsSync(P.dataFile + '.tmp'));
  });

  await test('a corrupted main file is set aside and the newest backup is loaded', async () => {
    fs.writeFileSync(P.dataFile, '{ this is not json', 'utf8');
    const { data, warning } = await store.loadData();
    assert.ok(warning, 'a warning is reported');
    assert.match(warning, /backup/i);
    assert.strictEqual(data.entries['2026-01-01'].other, 'save number 34');
    const corrupt = fs.readdirSync(P.dataDir).filter((n) => n.includes('.corrupt-'));
    assert.strictEqual(corrupt.length, 1, 'the bad file was kept');
  });

  await test('corruption with no backups starts empty but keeps the bad file', async () => {
    const root2 = tempRoot('journal-test2-');
    const P2 = store.init(root2);
    let result;
    try {
      fs.writeFileSync(P2.dataFile, 'garbage', 'utf8');
      result = await store.loadData();
    } finally {
      store.init(root); // always switch back so later tests use the main root
    }
    assert.deepStrictEqual(result.data.entries, {});
    assert.match(result.warning, /kept, unchanged/);
    const corrupt = fs.readdirSync(P2.dataDir).filter((n) => n.includes('.corrupt-'));
    assert.strictEqual(corrupt.length, 1, 'the bad file was set aside');
  });

  await test('saveData refuses non-journal shapes', async () => {
    // Matched on message: a bare assert.rejects also passes when the rejection is
    // an incidental TypeError from a bug in the validator itself.
    await assert.rejects(() => store.saveData(null), /does not look like journal data/i);
    await assert.rejects(() => store.saveData({ entries: [] }), /does not look like journal data/i);
  });

  await test('concurrent saves are serialised, last one wins, file stays valid', async () => {
    const jobs = [];
    for (let i = 0; i < 20; i++) {
      const data = store.emptyData();
      data.entries['2026-05-05'] = { other: `racer ${i}` };
      jobs.push(store.saveData(data)); // deliberately NOT awaited one by one
    }
    await Promise.all(jobs);
    const { data: loaded, warning } = await store.loadData();
    assert.strictEqual(warning, undefined, 'file readable after racing saves');
    assert.strictEqual(loaded.entries['2026-05-05'].other, 'racer 19');
    assert.ok(!fs.existsSync(P.dataFile + '.tmp'), 'no temp file left behind');
  });

  const heading = (iso) =>
    new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });

  await test('export is a dated timeline, oldest first, filled boxes only', async () => {
    const data = store.emptyData();
    data.entries['2026-03-02'] = { food: 'Soup with help from Mum.', out: '', updatedAt: 'x' };
    data.entries['2026-01-15'] = { walking: 'Two rests on the way to the shop.', updatedAt: 'x' };
    data.entries['2026-02-01'] = { other: '   ' }; // effectively empty: excluded
    const qs = [
      { key: 'food', title: 'Food and cooking', hint: '' },
      { key: 'walking', title: 'Walking and standing', hint: '' },
      { key: 'out', title: 'Going out', hint: '' }
    ];
    const text = store.buildExportText(data, {
      questions: qs, now: new Date('2026-07-15T14:00:00')
    });

    assert.match(text, /FLINT JOURNAL/);
    assert.match(text, /2 days recorded/);
    const jan = text.indexOf(heading('2026-01-15'));
    const mar = text.indexOf(heading('2026-03-02'));
    assert.ok(jan !== -1 && mar !== -1, 'both days present');
    assert.ok(jan < mar, 'oldest first');
    assert.ok(!text.includes('1 February'), 'blank day excluded');
    assert.match(text, /Walking and standing/);
    assert.match(text, /Food and cooking/);
    assert.ok(!text.includes('Going out'), 'empty boxes excluded');
    assert.ok(text.includes('\r\n'), 'Notepad-friendly line endings');
  });

  await test('export includes the day marker and tags', async () => {
    const data = store.emptyData();
    data.entries['2026-04-10'] = {
      food: 'Managed a sandwich.', __day: 'hard', __tags: ['migraine', 'work'], updatedAt: 'x'
    };
    const text = store.buildExportText(data, { questions: store.DEFAULT_QUESTIONS });
    assert.match(text, /Overall: Bad day/);
    assert.match(text, /Tags: migraine, work/);
  });

  await test('named feelings export and count as content', async () => {
    const data = store.emptyData();
    data.entries['2026-04-20'] = { __feelings: ['calm', 'hopeful'], updatedAt: 'x' };
    const text = store.buildExportText(data, { questions: store.DEFAULT_QUESTIONS });
    assert.match(text, /1 day recorded/, 'a feelings-only day still exports');
    assert.match(text, /Feelings: calm, hopeful/);
    const md = store.buildExportMarkdown(data, { questions: store.DEFAULT_QUESTIONS });
    assert.match(md, /\*\*Feelings:\*\* calm, hopeful/);
  });

  await test('trajectory and activities export and count as content', async () => {
    const data = store.emptyData();
    data.entries['2026-05-01'] = { __trend: 'down', __activities: ['Rest', 'Walk'], updatedAt: 'x' };
    const text = store.buildExportText(data, { questions: store.DEFAULT_QUESTIONS });
    assert.match(text, /1 day recorded/, 'a trajectory/activities-only day still exports');
    assert.match(text, /Compared with usual: Harder than usual/);
    assert.match(text, /Activities: Rest, Walk/);
    const md = store.buildExportMarkdown(data, { questions: store.DEFAULT_QUESTIONS });
    assert.match(md, /\*\*Compared with usual:\*\* Harder than usual/);
    assert.match(md, /\*\*Activities:\*\* Rest, Walk/);
  });

  await test('activities summary report is structured and stays discreet', async () => {
    const data = store.emptyData();
    data.entries['2026-05-02'] = { note: 'A quieter day.', __day: 'mixed', __trend: 'up', __activities: ['Rest'], updatedAt: 'x' };
    const rep = store.buildActivityReport(data, { questions: store.DEFAULT_QUESTIONS });
    assert.match(rep, /DAILY ACTIVITIES SUMMARY/);
    assert.match(rep, /everyday activities this record covers/i);
    assert.match(rep, /Preparing food/, 'lists the everyday activity areas');
    assert.match(rep, /Overall: Mixed day/);
    assert.match(rep, /Compared with usual: Easier than usual/);
    assert.match(rep, /Activities: Rest/);
    assert.doesNotMatch(rep, /\b(PIP|DWP|benefit|assessment|disability|medical)\b/i, 'the report never labels itself');
    const html = store.buildActivityReportHtml(data, { questions: store.DEFAULT_QUESTIONS });
    assert.match(html, /Daily activities summary/);
    assert.match(html, /Preparing food/);
    assert.doesNotMatch(html, /\b(PIP|DWP|benefit|assessment|disability|medical)\b/i);
  });

  // H3. This export is the one offered "to show someone who is helping you", and
  // it used to carry the entire diary inside it. Its contents must match its own
  // header, or a user hands an assessor far more than they meant to.
  await test('H3: the activities summary carries no diary writing unless asked', async () => {
    const data = store.emptyData();
    data.entries['2026-05-02'] = {
      note: 'PRIVATE-DIARY-CANARY, the sort of thing nobody means to hand over.',
      food: 'ANSWER-CANARY in a guided prompt.',
      __day: 'mixed', __activities: ['Rest'], __tags: ['migraine'], updatedAt: 'x'
    };
    const qs = [{ key: 'food', title: 'Food and cooking', hint: '' }];

    const rep = store.buildActivityReport(data, { questions: qs });
    assert.match(rep, /Activities: Rest/, 'the activities themselves are still reported');
    assert.match(rep, /Tags: migraine/, 'and the tags');
    assert.doesNotMatch(rep, /PRIVATE-DIARY-CANARY/, 'the free-text note is not in the summary');
    assert.doesNotMatch(rep, /ANSWER-CANARY/, 'guided prompt answers are not either');
    assert.match(rep, /does NOT include the diary writing/i, 'and it says so plainly');

    const html = store.buildActivityReportHtml(data, { questions: qs });
    assert.doesNotMatch(html, /PRIVATE-DIARY-CANARY/, 'same for the PDF source');
    assert.doesNotMatch(html, /ANSWER-CANARY/);

    // opt in and the writing comes back, so nothing is lost, only defaulted
    const full = store.buildActivityReport(data, { questions: qs, includeWriting: true });
    assert.match(full, /PRIVATE-DIARY-CANARY/, 'still available when explicitly requested');
    assert.match(full, /ANSWER-CANARY/);

    // the full journal export is unaffected: it is meant to contain everything
    const journal = store.buildExportText(data, { questions: qs });
    assert.match(journal, /PRIVATE-DIARY-CANARY/, 'Save journal still exports the writing');
  });

  // H4. Without a <title>, Chromium falls back to the document URL when writing
  // the PDF /Title, and these are rendered from a data: URL, so the metadata
  // held thousands of characters of diary text: invisible on screen, readable
  // in File > Properties and the Windows search index.
  await test('H4: PDF source documents carry a real title, so no text leaks to metadata', async () => {
    const data = store.emptyData();
    data.entries['2026-05-02'] = { note: 'TITLE-LEAK-CANARY', updatedAt: 'x' };
    for (const html of [
      store.buildExportHtml(data, { questions: store.DEFAULT_QUESTIONS }),
      store.buildActivityReportHtml(data, { questions: store.DEFAULT_QUESTIONS, includeWriting: true })
    ]) {
      const m = html.match(/<title>([^<]*)<\/title>/);
      assert.ok(m, 'the document declares a title');
      assert.ok(m[1].trim().length > 0, 'and it is not empty');
      assert.doesNotMatch(m[1], /TITLE-LEAK-CANARY/, 'the title carries no entry text');
      assert.ok(m[1].length < 80, `the title is a label, not a document (${m[1].length} chars)`);
    }
  });

  await test('a day with only a marker or only tags still exports', async () => {
    const data = store.emptyData();
    data.entries['2026-04-11'] = { __day: 'good', updatedAt: 'x' };
    data.entries['2026-04-12'] = { __tags: ['holiday'], updatedAt: 'x' };
    const text = store.buildExportText(data, { questions: store.DEFAULT_QUESTIONS });
    assert.match(text, /2 days recorded/);
    assert.match(text, /Good day/);
    assert.match(text, /Tags: holiday/);
  });

  await test('answers to a removed prompt are still exported (never lost)', async () => {
    const data = store.emptyData();
    // "mood" is not one of the current questions, it is an orphaned answer
    data.entries['2026-04-13'] = { mood: 'Low but steady.', updatedAt: 'x' };
    const text = store.buildExportText(data, {
      questions: store.DEFAULT_QUESTIONS, knownTitles: { mood: 'Mood' }
    });
    assert.match(text, /Mood/);
    assert.match(text, /Low but steady\./);
  });

  await test('buildExportHtml escapes content and includes marker + tags', async () => {
    const data = store.emptyData();
    data.entries['2026-04-14'] = {
      food: 'Bread & butter <ok>', __day: 'mixed', __tags: ['a & b'], updatedAt: 'x'
    };
    const html = store.buildExportHtml(data, { questions: store.DEFAULT_QUESTIONS });
    assert.match(html, /Bread &amp; butter &lt;ok&gt;/);
    assert.match(html, /Mixed day/);
    assert.ok(!html.includes('<ok>'), 'raw angle brackets are escaped');
  });

  await test('markdown export has headings, meta and prompt sections', async () => {
    const data = store.emptyData();
    data.entries['2026-05-01'] = { note: 'A markdown day.', __day: 'good', __tags: ['a & b'], food: 'Soup.', updatedAt: 'x' };
    const md = store.buildExportMarkdown(data, { questions: [{ key: 'food', title: 'Food', hint: '' }] });
    assert.match(md, /^# Flint journal/m);
    assert.ok(md.includes('## ' + heading('2026-05-01')), 'day heading present');
    assert.match(md, /\*\*Overall:\*\* Good day/);
    assert.match(md, /\*\*Tags:\*\* a & b/);
    assert.match(md, /A markdown day\./);
    assert.match(md, /^### Food/m);
    assert.match(md, /Soup\./);
  });

  await test('import merges new days and never overwrites existing ones', async () => {
    const current = store.emptyData();
    current.entries['2026-06-01'] = { note: 'mine, keep this' };
    const incoming = {
      version: 1, entries: {
        '2026-06-01': { note: 'theirs, must not win' },
        '2026-06-02': { note: 'a genuinely new day' },
        'not-a-date': { note: 'ignored' }
      }
    };
    const { data, added, skipped } = store.mergeImported(current, incoming);
    assert.strictEqual(added, 1, 'only the new day is added');
    assert.strictEqual(skipped, 1, 'the clashing day is skipped');
    assert.strictEqual(data.entries['2026-06-01'].note, 'mine, keep this', 'an existing day is never overwritten');
    assert.strictEqual(data.entries['2026-06-02'].note, 'a genuinely new day');
    assert.ok(!data.entries['not-a-date'], 'a key that is not a date is ignored');
  });

  await test('prompts default, then save + normalise (dedupe keys, drop blank, keep titles)', async () => {
    // The getters answer {ok, questions, defaulted} now, so that "we could not
    // read your prompts" can never arrive looking like "you have none".
    const def = await store.loadQuestions();
    assert.strictEqual(def.ok, true, 'readable');
    assert.strictEqual(def.defaulted, true, 'and marked as the built-in set');
    assert.ok(def.questions.length >= 1 && def.questions[0].key, 'defaults load when none saved');

    const saved = await store.saveQuestions([
      { key: 'work', title: 'Work', hint: 'How was work?' }, { key: 'work', title: 'Duplicate key', hint: '' }, // clashing key gets regenerated
      { title: '   ', hint: 'blank title dropped' }, { title: 'Gratitude' } // no key -> generated
    ]);
    assert.strictEqual(saved.length, 3, 'blank-title prompt dropped');
    const keys = saved.map((q) => q.key);
    assert.strictEqual(new Set(keys).size, keys.length, 'keys are unique');
    assert.ok(keys.every((k) => k && !k.startsWith('__') && k !== 'updatedAt'), 'no reserved keys');

    const reloaded = await store.loadQuestions();
    assert.strictEqual(reloaded.defaulted, false, 'no longer the built-in set');
    assert.deepStrictEqual(reloaded.questions, saved, 'saved prompts persist');

    const titles = await store.knownTitles();
    assert.strictEqual(titles.ok, true);
    assert.strictEqual(titles.titles.work, 'Work', 'known titles recorded for later orphan labelling');
  });

  await test('saveQuestions refuses an all-blank list', async () => {
    await assert.rejects(() => store.saveQuestions([{ title: '  ' }]), /at least one/i);
    await assert.rejects(() => store.saveQuestions([]), /at least one/i);
  });

  await test('removing a default prompt still labels its old answers by title', async () => {
    // save a set that does NOT include the default "challenge" prompt
    await store.saveQuestions([{ key: 'highlight', title: 'A good moment' }]);
    const titles = (await store.knownTitles()).titles;
    assert.strictEqual(titles.challenge, 'Something hard', 'default title still resolvable');

    const data = store.emptyData();
    data.entries['2026-08-01'] = { challenge: 'A rough afternoon, but I got through it.', updatedAt: 'x' };
    const questions = (await store.loadQuestions()).questions;
    const text = store.buildExportText(data, { questions, knownTitles: titles });
    assert.match(text, /Something hard/);
    assert.match(text, /rough afternoon/);
  });

  await test('theme get/set persists (light / dark / system)', async () => {
    assert.strictEqual(await store.getTheme(), 'light', 'defaults to light');
    assert.strictEqual(await store.setTheme('dark'), 'dark');
    assert.strictEqual(await store.getTheme(), 'dark');
    assert.strictEqual(await store.setTheme('system'), 'system', 'system is accepted');
    assert.strictEqual(await store.getTheme(), 'system');
    assert.strictEqual(await store.setTheme('nonsense'), 'light', 'unknown value falls back to light');
  });

  await test('theme accepts the preset palettes and the custom key', async () => {
    for (const t of ['sepia', 'nord', 'true-black', 'custom']) {
      assert.strictEqual(await store.setTheme(t), t, `${t} is accepted`);
    }
    assert.strictEqual(await store.setTheme('soft-night'), 'light', 'a removed theme falls back to light');
    assert.strictEqual(await store.setTheme('light'), 'light');
  });

  await test('custom theme + presets validate and persist', async () => {
    const saved = await store.setCustomTheme({ base: 'dark', primary: '#ff8800', accent: 'nope', junk: 1 });
    assert.deepStrictEqual(saved, { base: 'dark', primary: '#ff8800', accent: '#bb9af7' }, 'bad hex falls back, junk dropped');
    const presets = await store.setThemePresets([
      { name: '  Sunset ', base: 'dark', primary: '#ff0000', accent: '#00ff00' },
      { name: '', base: 'x', primary: 'y', accent: 'z' }
    ]);
    assert.strictEqual(presets.length, 1, 'nameless preset dropped');
    assert.strictEqual(presets[0].name, 'Sunset');
    const got = await store.getCustomTheme();
    assert.strictEqual(got.custom.primary, '#ff8800');
    assert.strictEqual(got.presets.length, 1);
  });

  await test('run-in-background defaults off, then persists', async () => {
    assert.strictEqual(await store.getRunInBackground(), false, 'off by default');
    assert.strictEqual(await store.setRunInBackground(true), true);
    assert.strictEqual(await store.getRunInBackground(), true);
    assert.strictEqual(await store.setRunInBackground(false), false);
  });

  // The upgrade risk in splitting the tray toggle: anyone already running in the
  // background had a startup entry too. If the fallback breaks, they lose it in
  // silence and their reminders stop after the next reboot.
  await test('start-with-Windows falls back to the old combined setting, then splits cleanly', async () => {
    const tmpRoot = tempRoot('flint-startup-');
    const guardRoot = tempRoot('flint-guard-');
    const upgradeRoot = tempRoot('flint-upgrade-');
    try {
      store.init(tmpRoot);
      assert.strictEqual(await store.getStartWithWindows(), false, 'a brand new install starts off');

      // H2, and this needs its OWN root. Reading getStartWithWindows even once
      // materialises the key onto disk, after which setRunInBackground's guard
      // (`if (s.startWithWindows === undefined)`) is unreachable and this
      // assertion passes no matter what the guard does. Start from settings
      // that have never been read, exactly as a real user's would be.
      const PG2 = store.init(guardRoot);
      fs.writeFileSync(PG2.settingsFile, JSON.stringify({ onboarded: true }), 'utf8');
      assert.strictEqual(await store.setRunInBackground(true), true);
      const pinned = JSON.parse(fs.readFileSync(PG2.settingsFile, 'utf8'));
      assert.strictEqual(
        pinned.startWithWindows, false,
        'turning the tray on pins startup to false ON DISK rather than leaving it to be inferred'
      );
      assert.strictEqual(
        await store.getStartWithWindows(), false,
        'turning the tray on does not turn start-with-Windows on'
      );

      // once answered explicitly, the two are independent in both directions
      store.init(tmpRoot);
      assert.strictEqual(await store.setStartWithWindows(true), true);
      assert.strictEqual(await store.setRunInBackground(false), false);
      assert.strictEqual(await store.getStartWithWindows(), true, 'turning the tray off does not turn startup off');

      // A REAL upgrade: settings.json written by an older version, holding only
      // the old combined key. Those users had a startup entry and must keep it.
      const PU = store.init(upgradeRoot);
      fs.writeFileSync(PU.settingsFile, JSON.stringify({ runInBackground: true, onboarded: true }), 'utf8');
      assert.strictEqual(await store.getStartWithWindows(), true, 'existing tray users keep starting with Windows');
      // and the answer is written down, so the fallback is never consulted again
      const after = JSON.parse(fs.readFileSync(PU.settingsFile, 'utf8'));
      assert.strictEqual(after.startWithWindows, true, 'the inherited answer is materialised on disk');
      assert.strictEqual(await store.setRunInBackground(false), false);
      assert.strictEqual(await store.getStartWithWindows(), true, 'and is not re-derived afterwards');
    } finally {
      store.init(root); // always switch back so later tests use the main root
    }
  });

  await test('tray question and notice are one-shot flags, off by default', async () => {
    assert.strictEqual(await store.getTrayAsked(), false);
    assert.strictEqual(await store.setTrayAsked(true), true);
    assert.strictEqual(await store.getTrayAsked(), true);
    assert.strictEqual(await store.getTrayNoticeShown(), false);
    assert.strictEqual(await store.setTrayNoticeShown(true), true);
  });

  await test('hardware acceleration defaults on and is readable synchronously', async () => {
    const tmpRoot = tempRoot('flint-hwaccel-');
    try {
      store.init(tmpRoot);
      assert.strictEqual(await store.getHardwareAcceleration(), true, 'on unless turned off');
      assert.strictEqual(store.readStartupFlagsSync().hardwareAcceleration, true, 'sync read agrees before app ready');
      assert.strictEqual(await store.setHardwareAcceleration(false), false);
      assert.strictEqual(store.readStartupFlagsSync().hardwareAcceleration, false, 'sync read sees the saved value');
      store.init(path.join(tmpRoot, 'nope'));
      assert.strictEqual(store.readStartupFlagsSync().hardwareAcceleration, true, 'an unreadable settings file defaults to on');
    } finally {
      store.init(root); // always switch back so later tests use the main root
    }
  });

  await test('autosave interval defaults to 30s, persists, and clamps junk', async () => {
    assert.strictEqual(await store.getAutosaveSeconds(), 30, 'defaults to 30 seconds');
    assert.strictEqual(await store.setAutosaveSeconds(5), 5);
    assert.strictEqual(await store.getAutosaveSeconds(), 5, 'persists a whitelisted value');
    assert.strictEqual(await store.setAutosaveSeconds(3600), 3600, 'accepts the longest interval (1 hour)');
    assert.strictEqual(await store.setAutosaveSeconds(0), 30, 'a zero/absurd interval falls back to 30');
    assert.strictEqual(await store.setAutosaveSeconds(999), 30, 'an off-list value falls back to 30');
  });

  await test('activities default, then save + normalise (trim, dedupe, drop blank)', async () => {
    const def = await store.loadActivities();
    assert.ok(def.ok && Array.isArray(def.activities) && def.activities.length > 0, 'has a default set');
    const saved = await store.saveActivities(['  Rest  ', 'Rest', 'Walk', '', '   ']);
    assert.deepStrictEqual(saved, ['Rest', 'Walk'], 'trims, dedupes case-insensitively, drops blanks');
    assert.deepStrictEqual((await store.loadActivities()).activities, ['Rest', 'Walk']);
    await assert.rejects(() => store.saveActivities(['', '  ']), /at least one activity/i);
  });

  await test('onboarding flag defaults false, then persists', async () => {
    assert.strictEqual(await store.getOnboarded(), false, 'off until completed');
    assert.strictEqual(await store.setOnboarded(true), true);
    assert.strictEqual(await store.getOnboarded(), true);
  });

  await test('update-check setting defaults on, then persists off/on', async () => {
    assert.strictEqual(await store.getUpdateChecks(), true, 'on by default');
    assert.strictEqual(await store.setUpdateChecks(false), false);
    assert.strictEqual(await store.getUpdateChecks(), false);
    assert.strictEqual(await store.setUpdateChecks(true), true);
    assert.strictEqual(await store.getUpdateChecks(), true);
  });

  await test('PIN set, verify, remove', async () => {
    assert.strictEqual(await store.pinIsSet(), false);
    await store.setPin('2468');
    assert.strictEqual(await store.pinIsSet(), true);
    assert.strictEqual(await store.verifyPin('2468'), true);
    assert.strictEqual(await store.verifyPin('1111'), false);
    await store.removePin();
    assert.strictEqual(await store.pinIsSet(), false);
    assert.strictEqual(await store.verifyPin('2468'), false);
  });

  await test('removing the PIN file never touches entries', async () => {
    const data = store.emptyData();
    data.entries['2026-06-01'] = { other: 'still here after PIN removal' };
    await store.saveData(data);
    await store.setPin('9999');
    fs.unlinkSync(P.settingsFile);
    assert.strictEqual(await store.pinIsSet(), false);
    const { data: loaded } = await store.loadData();
    assert.strictEqual(loaded.entries['2026-06-01'].other, 'still here after PIN removal');
  });

  // C1. The worst bug found in the audit: enabling encryption straight after a
  // quarantined load sealed a vault around NOTHING, then deleted the plaintext
  // backups and the quarantined original, and reported success.
  await test('C1: encryption refuses to seal an empty journal while copies still exist', async () => {
    const tmpRoot = tempRoot('flint-c1-');
    const PX = store.init(tmpRoot);
    try {
      // a real journal with real writing, plus the backup that save() makes
      const data = store.emptyData();
      data.entries['2026-03-01'] = { note: 'Words that must not be destroyed.', updatedAt: 'x' };
      await store.saveData(data);
      await store.saveData(data); // a second save guarantees a backup file

      // corrupt the main file, then load: this quarantines it and recovers a backup
      fs.writeFileSync(PX.dataFile, '{ this is not json', 'utf8');
      const recovered = await store.loadData();
      assert.ok(recovered.warning, 'the load warns that it fell back to a backup');
      assert.strictEqual(Object.keys(recovered.data.entries).length, 1, 'the backup still holds the day');
      assert.ok(!fs.existsSync(PX.dataFile), 'the unreadable file was renamed aside, so entries.json is now absent');
      const quarantined = fs.readdirSync(PX.dataDir).filter((n) => n.includes('.corrupt-'));
      assert.strictEqual(quarantined.length, 1, 'the original was set aside, not deleted');

      // the user now turns on encryption, before saving. This must refuse.
      const res = await store.enableEncryption('9182');
      assert.strictEqual(res.ok, false, 'encryption is refused rather than sealing an empty journal');
      assert.ok(!res.recoveryCode, 'no recovery code is handed out for a refused operation');

      // and, crucially, nothing was destroyed
      assert.strictEqual(
        fs.readdirSync(PX.dataDir).filter((n) => n.includes('.corrupt-')).length, 1,
        'the quarantined original is still there'
      );
      const backups = fs.readdirSync(PX.backupsDir).filter((n) => /^entries-.*\.json$/.test(n));
      assert.ok(backups.length >= 1, 'the readable backups were not purged');
      const stillThere = JSON.parse(fs.readFileSync(path.join(PX.backupsDir, backups[0]), 'utf8'));
      assert.strictEqual(stillThere.entries['2026-03-01'].note, 'Words that must not be destroyed.');
    } finally {
      store.init(root);
    }
  });

  await test('C1: a genuinely fresh install can still turn encryption on', async () => {
    const tmpRoot = tempRoot('flint-c1b-');
    store.init(tmpRoot);
    try {
      const res = await store.enableEncryption('4471');
      assert.strictEqual(res.ok, true, 'an empty data folder with no copies is allowed');
      assert.ok(res.recoveryCode, 'a recovery code is issued');
    } finally {
      store.lock();
      store.init(root);
    }
  });

  // ----------------------------------------------------------- encryption
  // These run last and in their own root, because turning encryption on
  // changes module-level session state (the in-memory data key).

  const secret = 'A quiet note only I should be able to read.';
  let recoveryCode = null;
  let mediaId = null;
  const photoBytes = Buffer.from('89504e470d0a1a0a' + 'ab'.repeat(96), 'hex'); // a stand-in PNG

  const cryptoRoot = tempRoot('flint-crypto-');
  const PC = store.init(cryptoRoot);

  await test('enableEncryption turns entries.json into an unreadable vault', async () => {
    await store.securityStatus(); // sync module state to the fresh empty root
    const data = store.emptyData();
    data.entries['2026-09-01'] = { note: secret, updatedAt: 'x' };
    await store.saveData(data);
    assert.ok(fs.readFileSync(PC.dataFile, 'utf8').includes(secret), 'plaintext before encrypting');

    const res = await store.enableEncryption('1234');
    assert.ok(res.ok, 'encryption enabled');
    assert.match(res.recoveryCode, /^[A-Z0-9]{4}(-[A-Z0-9]{4}){4}$/, 'a grouped recovery code is returned');
    recoveryCode = res.recoveryCode;

    const raw = fs.readFileSync(PC.dataFile, 'utf8');
    assert.ok(!raw.includes(secret), 'the words are no longer on disk in the clear');
    const vault = JSON.parse(raw);
    assert.strictEqual(vault.flintEncrypted, 1);
    assert.ok(vault.pin && vault.recovery && vault.body, 'vault has both wraps and a body');

    const status = await store.securityStatus();
    assert.deepStrictEqual(
      { encrypted: status.encrypted, unlocked: status.unlocked },
      { encrypted: true, unlocked: true }
    );
  });

  await test('enableEncryption purges plaintext backups and writes encrypted ones', async () => {
    const backups = fs.readdirSync(PC.backupsDir).filter((n) => /^entries-.*\.json$/.test(n));
    assert.ok(backups.length >= 1, 'at least one backup exists');
    for (const name of backups) {
      const parsed = JSON.parse(fs.readFileSync(path.join(PC.backupsDir, name), 'utf8'));
      assert.strictEqual(parsed.flintEncrypted, 1, `${name} is encrypted`);
    }
  });

  await test('an unlocked session round-trips saves while encrypted', async () => {
    const { data } = await store.loadData();
    assert.strictEqual(data.entries['2026-09-01'].note, secret, 'decrypts to the original');
    data.entries['2026-09-02'] = { note: 'A second day, still secret.', updatedAt: 'y' };
    await store.saveData(data);
    const { data: again } = await store.loadData();
    assert.strictEqual(again.entries['2026-09-02'].note, 'A second day, still secret.');
    assert.strictEqual(JSON.parse(fs.readFileSync(PC.dataFile, 'utf8')).flintEncrypted, 1, 'still a vault');
  });

  await test('locking hides the words; loadData reports locked, not corrupt', async () => {
    store.lock();
    const status = await store.securityStatus();
    assert.strictEqual(status.unlocked, false, 'locked after lock()');
    const res = await store.loadData();
    assert.strictEqual(res.locked, true, 'load reports locked');
    assert.strictEqual(res.data, undefined, 'no data handed out while locked');
    const corrupt = fs.readdirSync(PC.dataDir).filter((n) => n.includes('.corrupt-'));
    assert.strictEqual(corrupt.length, 0, 'a locked vault is never quarantined');
  });

  await test('the PIN unlocks; a wrong PIN does not', async () => {
    assert.strictEqual((await store.unlock('0000')).ok, false, 'wrong PIN refused');
    assert.strictEqual((await store.loadData()).locked, true, 'still locked after a wrong PIN');
    assert.strictEqual((await store.unlock('1234')).ok, true, 'right PIN accepted');
    const { data } = await store.loadData();
    assert.strictEqual(data.entries['2026-09-01'].note, secret, 'words are back');
  });

  await test('the recovery code unlocks after a lock (forgotten-PIN path)', async () => {
    store.lock();
    assert.strictEqual((await store.unlockWithRecovery('BADX-BADX-BADX-BADX-BADX')).ok, false, 'wrong code refused');
    const ok = await store.unlockWithRecovery(recoveryCode.toLowerCase().replace(/-/g, ' '));
    assert.strictEqual(ok.ok, true, 'code accepted despite lower-case and odd spacing');
    const { data } = await store.loadData();
    assert.strictEqual(data.entries['2026-09-01'].note, secret);
  });

  await test('saving while locked is refused and never overwrites the vault', async () => {
    store.lock();
    const data = store.emptyData();
    data.entries['2026-09-03'] = { note: 'must not be written in the clear', updatedAt: 'z' };
    await assert.rejects(() => store.saveData(data), /locked/i);
    const raw = fs.readFileSync(PC.dataFile, 'utf8');
    assert.strictEqual(JSON.parse(raw).flintEncrypted, 1, 'still a vault');
    assert.ok(!raw.includes('must not be written'), 'the attempted plaintext never reached disk');
    await store.unlock('1234'); // leave it unlocked for the next tests
  });

  await test('changing the PIN rotates the key, so the old PIN and old code both die', async () => {
    const oldCode = recoveryCode;
    assert.strictEqual((await store.changeEncryptionPin('nope', '5678')).ok, false, 'wrong current PIN refused');
    const res = await store.changeEncryptionPin('1234', '5678');
    assert.ok(res.ok && res.recoveryCode, 'PIN changed and a fresh recovery code issued');
    assert.notStrictEqual(res.recoveryCode, oldCode, 'the recovery code rotates with the key');
    recoveryCode = res.recoveryCode;

    store.lock();
    assert.strictEqual((await store.unlock('1234')).ok, false, 'old PIN no longer works');
    assert.strictEqual((await store.unlockWithRecovery(oldCode)).ok, false, 'the old recovery code no longer works either');
    assert.strictEqual((await store.unlock('5678')).ok, true, 'new PIN works');
    const { data } = await store.loadData();
    assert.strictEqual(data.entries['2026-09-01'].note, secret, 'the words survived the rotation');
  });

  await test('after a PIN change the old PIN cannot open any surviving backup', async () => {
    // The point of rotating: a backup still carrying the OLD wraps would hand the
    // old PIN the very same key that opens today's journal.
    const vaultCrypto = require('../crypto');
    const names = fs.readdirSync(PC.backupsDir).filter((n) => /^entries-.*\.json$/.test(n));
    assert.ok(names.length, 'there are backups to check');
    for (const n of names) {
      const v = JSON.parse(fs.readFileSync(path.join(PC.backupsDir, n), 'utf8'));
      assert.strictEqual(v.flintEncrypted, 1, `${n} is a vault`);
      // The 2nd arg to assert.rejects is a matcher; a plain string there is taken as
      // the failure MESSAGE and asserts nothing, which is what this line used to do.
      await assert.rejects(() => vaultCrypto.openWithPin(v, '1234'), Error,
        `${n} must not open with the old PIN`);
    }
  });

  await test('a recovery unlock forces a new PIN, which retires the spent code', async () => {
    store.lock();
    const spent = recoveryCode;
    assert.strictEqual((await store.unlockWithRecovery(spent)).ok, true, 'in with the code');
    const res = await store.resetSecretsAfterRecovery('4321');
    assert.ok(res.ok && res.recoveryCode, 'a fresh code is issued');
    assert.notStrictEqual(res.recoveryCode, spent, 'the new code differs');
    recoveryCode = res.recoveryCode;

    store.lock();
    assert.strictEqual((await store.unlockWithRecovery(spent)).ok, false, 'the spent code is dead');
    assert.strictEqual((await store.unlock('5678')).ok, false, 'the forgotten PIN is dead too');
    assert.strictEqual((await store.unlock('4321')).ok, true, 'the new PIN works');
  });

  await test('checkEncryptionPin verifies without changing session state', async () => {
    assert.strictEqual((await store.checkEncryptionPin('4321')).valid, true, 'correct PIN passes');
    assert.strictEqual((await store.checkEncryptionPin('0000')).valid, false, 'wrong PIN fails');
    const { data } = await store.loadData();
    assert.strictEqual(data.entries['2026-09-01'].note, secret, 'still unlocked after the checks');
  });

  await test('an attachment is encrypted beside the words and reads back', async () => {
    const src = path.join(os.tmpdir(), `flint-test-photo-${Date.now()}.png`);
    fs.writeFileSync(src, photoBytes);
    try {
      const add = await store.addMedia(src);
      assert.ok(add.ok && add.id, 'the photo was attached');
      mediaId = add.id;

      const raw = fs.readFileSync(path.join(PC.mediaDir, mediaId));
      assert.strictEqual(raw.subarray(0, 9).toString(), 'FLINTMED1', 'stored encrypted');
      assert.ok(!raw.includes(photoBytes), 'the original bytes are not on disk in the clear');

      const got = await store.getMedia(mediaId);
      assert.ok(got.ok && got.dataUrl.startsWith('data:image/png;base64,'), 'reads back as a png data URL');
      assert.ok(Buffer.from(got.dataUrl.split(',')[1], 'base64').equals(photoBytes), 'the bytes round-trip exactly');
    } finally {
      fs.unlinkSync(src);
    }
  });

  await test('a locked journal will not hand back an attachment', async () => {
    store.lock();
    const locked = await store.getMedia(mediaId);
    assert.strictEqual(locked.ok, false, 'refused while locked');
    // The MESSAGE matters: without the lock check the decrypt fails instead and
    // says the attachment could not be decrypted, which reads as corruption to
    // someone whose diary is at stake.
    assert.match(locked.error, /locked/i, 'and says it is locked, not damaged');
    await store.unlock('4321');
  });

  await test('an attachment id is never treated as a path', async () => {
    // Attachments live in data/media, so the journal is exactly ONE level up.
    // These used to say '../../entries.json', which resolves to the folder ABOVE
    // the data folder, where no journal exists: the removeMedia case could not
    // have deleted anything even with the guard removed, so the strongest line
    // here was unfalsifiable. One '..' is the payload that actually reaches it.
    const before = fs.readFileSync(PC.dataFile);
    const settingsBefore = fs.existsSync(PC.settingsFile) ? fs.readFileSync(PC.settingsFile) : null;
    const ids = ['../entries.json', '..' + path.sep + 'entries.json', '../settings.json',
                 '../../entries.json', 'sub/../../entries.json'];

    for (const id of ids) {
      assert.strictEqual((await store.getMedia(id)).ok, false, `read refused: ${id}`);
      assert.strictEqual((await store.removeMedia(id)).ok, false, `delete refused: ${id}`);
    }

    assert.ok(fs.existsSync(PC.dataFile), 'the journal still exists');
    assert.deepStrictEqual(fs.readFileSync(PC.dataFile), before, 'and is byte-identical');
    if (settingsBefore) assert.deepStrictEqual(fs.readFileSync(PC.settingsFile), settingsBefore, 'settings untouched');
  });

  await test('disableEncryption needs the PIN and restores plaintext', async () => {
    assert.strictEqual((await store.disableEncryption('0000')).ok, false, 'wrong PIN keeps encryption on');
    assert.strictEqual(JSON.parse(fs.readFileSync(PC.dataFile, 'utf8')).flintEncrypted, 1, 'still a vault');

    assert.strictEqual((await store.disableEncryption('4321')).ok, true, 'correct PIN turns it off');
    const raw = fs.readFileSync(PC.dataFile, 'utf8');
    assert.ok(raw.includes(secret), 'entries are readable plaintext again');
    const parsed = JSON.parse(raw);
    assert.ok(!parsed.flintEncrypted && parsed.entries, 'plain journal shape restored');

    const status = await store.securityStatus();
    assert.strictEqual(status.encrypted, false, 'reports unencrypted');
    const { data } = await store.loadData();
    assert.strictEqual(data.entries['2026-09-01'].note, secret, 'still loads normally');
  });

  await test('turning encryption off returns attachments to the clear too', async () => {
    const raw = fs.readFileSync(path.join(PC.mediaDir, mediaId));
    assert.notStrictEqual(raw.subarray(0, 9).toString(), 'FLINTMED1', 'no longer encrypted');
    assert.ok(raw.equals(photoBytes), 'the original bytes are back');
    const got = await store.getMedia(mediaId);
    assert.ok(got.ok, 'still readable with no key held');
  });

  await test('enableEncryption refuses a too-short PIN', async () => {
    const res = await store.enableEncryption('12');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(JSON.parse(fs.readFileSync(PC.dataFile, 'utf8')).flintEncrypted, undefined, 'left as plaintext');
  });

  await test('an unreadable journal never downgrades encryption or drops the key', async () => {
    // The disaster: a file held open for a moment by antivirus or a sync client
    // must NOT be read as "not encrypted". If it were, the key would be dropped
    // and the next save would write the journal to disk in the clear.
    const rootU = tempRoot('flint-unreadable-');
    const PU = store.init(rootU);
    try {
      await store.securityStatus();
      const on = await store.enableEncryption('guardpin');
      assert.ok(on.ok, 'encrypted for the test');

      // Make entries.json unreadable without changing what it is: a directory in
      // its place makes readFile fail with EISDIR, exactly like a lock would.
      fs.unlinkSync(PU.dataFile);
      fs.mkdirSync(PU.dataFile);

      const st = await store.securityStatus();
      assert.strictEqual(st.unreadable, true, 'reports that it could not read the file');
      assert.strictEqual(st.encrypted, true, 'still considers the journal encrypted');
      assert.strictEqual(st.unlocked, true, 'the key was NOT thrown away');

      // And a save must never quietly become a plaintext write.
      const d = store.emptyData();
      d.entries['2026-12-01'] = { note: 'must never be written in the clear' };
      await assert.rejects(() => store.saveData(d), Error,
        'the save fails rather than writing plaintext');
    } finally {
      try { fs.rmSync(PU.dataFile, { recursive: true, force: true }); } catch { /* best effort */ }
      store.init(root);
    }
  });

  await test('a save refuses to write plaintext over a vault', async () => {
    // Belt and braces for the same disaster: even if the in-memory flag were
    // wrong, the bytes on disk get the final say.
    const rootG = tempRoot('flint-guard-');
    const PG = store.init(rootG);
    try {
      await store.securityStatus();
      await store.saveData(store.emptyData());
      const on = await store.enableEncryption('guardpin');
      assert.ok(on.ok, 'encrypted');
      const vaultBytes = fs.readFileSync(PG.dataFile);

      assert.strictEqual((await store.disableEncryption('guardpin')).ok, true, 'back to plaintext');
      assert.strictEqual((await store.securityStatus()).encrypted, false, 'app believes it is plaintext');

      // A vault reappears underneath the app (a restore, a sync, a stale flag).
      fs.writeFileSync(PG.dataFile, vaultBytes);

      const d = store.emptyData();
      d.entries['2026-12-02'] = { note: 'must not clobber the vault' };
      await assert.rejects(() => store.saveData(d), /lost track of the key/i, 'refused');
      assert.strictEqual(JSON.parse(fs.readFileSync(PG.dataFile, 'utf8')).flintEncrypted, 1, 'the vault is untouched');
    } finally {
      store.init(root);
    }
  });

  // H6. A failed decrypt used to leave the session key in place while adopting
  // the file it could not open, so the next save resealed a new body under wraps
  // from a different key: a journal neither the PIN nor the recovery code opens.
  await test('H6: a vault the held key cannot open drops the key instead of adopting it', async () => {
    const rootA = tempRoot('flint-h6a-');
    const rootB = tempRoot('flint-h6b-');
    try {
      // journal B, encrypted under its own PIN, gives us a foreign vault
      const PB = store.init(rootB);
      await store.saveData(store.emptyData());
      assert.ok((await store.enableEncryption('bbbb1111')).ok);
      const foreignVault = fs.readFileSync(PB.dataFile);

      // journal A, encrypted and unlocked, with real writing in it
      const PA = store.init(rootA);
      const d = store.emptyData();
      d.entries['2026-08-08'] = { note: 'Journal A words.', updatedAt: 'x' };
      await store.saveData(d);
      assert.ok((await store.enableEncryption('aaaa2222')).ok);
      assert.strictEqual((await store.securityStatus()).unlocked, true, 'A starts unlocked');

      // B's vault appears where A's used to be (a restore from the wrong folder)
      fs.writeFileSync(PA.dataFile, foreignVault);

      // openVault's guard, ON ITS OWN. No securityStatus() call in between, or
      // its independent duplicate mismatch check drops the key instead and this
      // passes with openVault's guard deleted. The sequence below is reachable
      // in the app, and with the guard gone the next save reseals a new body
      // under the foreign vault's wraps: a journal that opens for neither PIN.
      const res = await store.loadData();
      assert.strictEqual(res.locked, true, 'the foreign vault reports locked, not corrupt');
      const before = fs.readFileSync(PA.dataFile);
      await assert.rejects(
        () => store.saveData(d), /locked/i,
        'saving straight after the failed decrypt is refused, with no securityStatus in between'
      );
      assert.ok(fs.readFileSync(PA.dataFile).equals(before), 'the foreign vault is byte-identical afterwards');
      // it must still open with its OWN pin, proving it was never resealed
      assert.strictEqual((await store.unlock('bbbb1111')).ok, true, 'the foreign vault still opens with its own PIN');
      store.lock();

      // and securityStatus's own guard, separately
      assert.strictEqual(
        (await store.securityStatus()).unlocked, false,
        'the key that could not open it was dropped, so the session is locked'
      );
    } finally {
      store.init(root);
    }
  });

  // H7. An encrypted, unlocked session must not be downgraded by the file going
  // missing underneath it. That is always an outside event, and treating it as
  // "encryption is off" let the next autosave write every entry in the clear.
  await test('H7: losing the file does not silently turn encryption off', async () => {
    const rootH = tempRoot('flint-h7-');
    const PH = store.init(rootH);
    try {
      const d = store.emptyData();
      d.entries['2026-09-09'] = { note: 'Must never be written in the clear.', updatedAt: 'x' };
      await store.saveData(d);
      assert.ok((await store.enableEncryption('hhhh3333')).ok, 'encrypted and unlocked');

      // something outside Flint removes the journal file
      fs.unlinkSync(PH.dataFile);

      const st = await store.securityStatus();
      assert.strictEqual(st.encrypted, true, 'still believes it is encrypted');
      assert.strictEqual(st.unlocked, true, 'and still holds the key');

      // A save now takes the encrypted branch and restores the vault. The point
      // is that it is a vault: before the fix securityStatus had dropped the key
      // and this same save wrote every entry as readable JSON.
      await store.saveData(d);
      const written = JSON.parse(fs.readFileSync(PH.dataFile, 'utf8'));
      assert.strictEqual(written.flintEncrypted, 1, 'the journal was rewritten encrypted, not in the clear');
      assert.ok(!JSON.stringify(written).includes('Must never be written in the clear'), 'no entry text on disk');

      // The other half of the same hazard: loadData's ENOENT path clears
      // encryptedOnDisk, which would send the next save down the plaintext
      // branch. The sticky session flag has to catch that.
      fs.unlinkSync(PH.dataFile);
      const reloaded = await store.loadData();
      assert.deepStrictEqual(reloaded.data.entries, {}, 'a missing file reads as empty');
      await assert.rejects(
        () => store.saveData(d),
        /missing or is no longer encrypted/i,
        'a plaintext write is refused rather than silently undoing encryption'
      );
      assert.ok(!fs.existsSync(PH.dataFile), 'nothing was written in the clear');
    } finally {
      store.init(root);
    }
  });

  // H5. A PIN change rewrote every photo in place under the new key, then threw
  // that key away if any single one failed. Everything already rewritten became
  // unreadable forever, while the message said "Nothing was changed".
  // U5. A prompt keyed 'note' writes its answer into the day's own body field,
  // which then overwrites it, and every export prints the day twice.
  await test('U5: a prompt cannot claim the key the day body uses', async () => {
    const tmpRoot = tempRoot('flint-u5-');
    store.init(tmpRoot);
    try {
      const saved = await store.saveQuestions([
        { key: 'note', title: 'Shadowing prompt', hint: '' },
        { key: 'keepme', title: 'An ordinary prompt', hint: '' }
      ]);
      assert.ok(Array.isArray(saved) && saved.length === 2, 'both prompts saved');
      assert.notStrictEqual(saved[0].key, 'note', "'note' is not handed out as a prompt key");
      assert.match(saved[0].key, /^p[0-9a-f]{12}$/, 'it was replaced with a generated key');
      assert.strictEqual(saved[1].key, 'keepme', 'ordinary keys are untouched');

      // and a body-only day is still content, which reserving 'note' globally
      // would have broken by sending a deliberate save down the delete branch
      const d = store.emptyData();
      d.entries['2026-06-06'] = { note: 'A body-only day.', updatedAt: 'x' };
      await store.saveData(d);
      const back = await store.loadData();
      assert.strictEqual(back.data.entries['2026-06-06'].note, 'A body-only day.', 'a body-only day survives');
      const text = store.buildExportText(back.data, { questions: saved, knownTitles: {} });
      const hits = (text.match(/A body-only day\./g) || []).length;
      assert.strictEqual(hits, 1, `the body appears once in the export, not twice (got ${hits})`);
    } finally {
      store.init(root);
    }
  });

  // U3. Turning encryption on swept the journal copies in the external backup
  // folder but never descended into its media subfolder, so a readable photo sat
  // beside an encrypted journal for ever, surviving a PIN change and even
  // removing the photo from the app.
  await test('U3: enabling encryption clears readable photos from the backup folder too', async () => {
    const tmpRoot = tempRoot('flint-u3-');
    const dest = tempRoot('flint-u3-dest-');
    const PU = store.init(tmpRoot);
    try {
      await store.saveData(store.emptyData());
      const src = path.join(tmpRoot, 'snap.png');
      const pngBytes = Buffer.from('89504e470d0a1a0a' + 'c0ffee'.repeat(40), 'hex');
      fs.writeFileSync(src, pngBytes);
      const add = await store.addMedia(src);
      assert.ok(add.ok, `photo stored (${add.error || ''})`);

      assert.ok((await store.setBackupFolder(dest)).ok);
      await store.setBackupSettings({ enabled: true });
      assert.ok((await store.runScheduledBackup()).ok, 'backed up while still plaintext');

      const mediaDir = path.join(dest, 'Flint backups', 'media');
      const copied = path.join(mediaDir, add.id);
      assert.ok(fs.existsSync(copied), 'the photo was copied out in the clear');
      assert.ok(fs.readFileSync(copied).equals(pngBytes), 'and is byte-identical to the original');

      const on = await store.enableEncryption('u3pin1234');
      assert.strictEqual(on.ok, true, 'encryption turned on');

      assert.ok(
        !fs.existsSync(copied) || !fs.readFileSync(copied).equals(pngBytes),
        'the readable copy in the backup folder is gone, not left beside the encrypted journal'
      );
      // and the next scheduled backup carries the encrypted photo, not the old one
      assert.ok((await store.runScheduledBackup()).ok, 'a later backup still runs');
      if (fs.existsSync(copied)) {
        assert.ok(
          fs.readFileSync(copied).subarray(0, 9).equals(Buffer.from('FLINTMED1')),
          'any photo now in the backup folder is encrypted'
        );
      }
    } finally {
      store.lock();
      store.init(root);
    }
  });

  // U4. "Erase everything" promised there was no copy left while whole readable
  // journals sat in the user's chosen backup folder, and the same delete removed
  // the only record of where that folder was.
  await test('U4: erase everything also clears the copies in the backup folder', async () => {
    const tmpRoot = tempRoot('flint-u4-');
    const dest = tempRoot('flint-u4-dest-');
    store.init(tmpRoot);
    try {
      const d = store.emptyData();
      d.entries['2026-02-02'] = { note: 'CANARY-U4 a private day', updatedAt: 'x' };
      await store.saveData(d);
      assert.ok((await store.setBackupFolder(dest)).ok);
      await store.setBackupSettings({ enabled: true });
      assert.ok((await store.runScheduledBackup()).ok, 'a copy was made');

      const dir = path.join(dest, 'Flint backups');
      const before = fs.readdirSync(dir).filter((n) => /^flint-backup-/.test(n));
      assert.ok(before.length >= 1, 'the external copy exists to begin with');
      assert.match(fs.readFileSync(path.join(dir, before[0]), 'utf8'), /CANARY-U4/, 'and is readable');

      const res = await store.resetAll();
      assert.strictEqual(res.ok, true, 'reset succeeded');
      assert.strictEqual(res.cleanedBackupFolder, true, 'and reports that it reached the backup folder');
      assert.strictEqual(res.leftBehind, 0, 'with nothing left behind');
      const after = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^flint-backup-/.test(n)) : [];
      assert.strictEqual(after.length, 0, 'no readable copies of the journal remain');
      // the user's own folder is never touched, only the subfolder Flint made
      assert.ok(fs.existsSync(dest), "the folder the user chose still exists");
    } finally {
      store.init(root);
    }
  });

  // L6. slotParams throws BEFORE any key is derived, so a vault with unusable
  // scrypt settings could not check ANY pin. Reporting that as "your PIN is
  // correct, but the file is damaged" told every guess it had guessed right.
  await test('L6: unusable key settings say the PIN could not be checked, not that it was right', async () => {
    const tmpRoot = tempRoot('flint-l6-');
    const PL = store.init(tmpRoot);
    try {
      await store.saveData(store.emptyData());
      assert.ok((await store.enableEncryption('realpin11')).ok, 'encrypted');
      store.lock();

      // tamper with the stored cost parameters, as disk rot or an edit would
      const vault = JSON.parse(fs.readFileSync(PL.dataFile, 'utf8'));
      const slot = vault.pin || (vault.slots && vault.slots.pin);
      assert.ok(slot && typeof slot === 'object', 'the vault exposes a pin slot to tamper with');
      slot.N = 3; // not a power of two, and far outside the accepted bounds
      fs.writeFileSync(PL.dataFile, JSON.stringify(vault, null, 2));

      const res = await store.unlock('anything-at-all');
      assert.strictEqual(res.ok, false, 'a bogus PIN is still refused');
      assert.doesNotMatch(res.error || '', /is correct/i, 'and is never told it was correct');
      assert.match(res.error || '', /could not even check|does not recognise/i, 'the message says the PIN could not be checked');
    } finally {
      store.init(root);
    }
  });

  // L12. Backup filenames used to carry the date and time, to the millisecond,
  // of every write. In a folder the UI suggests syncing, that is a readable
  // record of when someone wrote in their diary, and unlike an mtime it survives
  // being copied. Encryption does not hide a filename.
  await test('L12: scheduled backup filenames carry no timestamp, and still prune', async () => {
    const tmpRoot = tempRoot('flint-l12-');
    const dest = tempRoot('flint-l12-dest-');
    store.init(tmpRoot);
    try {
      const d = store.emptyData();
      d.entries['2026-04-04'] = { note: 'a day', updatedAt: 'x' };
      await store.saveData(d);
      assert.ok((await store.setBackupFolder(dest)).ok, 'backup folder accepted');
      await store.setBackupSettings({ enabled: true });
      // keep is deliberately fixed rather than user-settable, so run past it
      const keep = (await store.getBackupSettings()).keep;

      const dir = path.join(dest, 'Flint backups');
      // a leftover from an older version, which must still be aged out
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'flint-backup-20240101-000000-000.json'), '{"version":1,"entries":{}}');

      for (let i = 0; i < keep + 2; i++) {
        const r = await store.runScheduledBackup();
        assert.ok(r.ok, `backup ${i} ran (${r.error || ''})`);
        await new Promise((res) => setTimeout(res, 8)); // distinct mtimes
      }
      const files = fs.readdirSync(dir).filter((n) => /^flint-backup-.*\.json$/.test(n));
      assert.ok(files.length <= keep, `pruned to keep (${files.length} files, keep=${keep})`);
      assert.ok(files.length >= 1, 'and at least one copy exists');
      assert.ok(!files.includes('flint-backup-20240101-000000-000.json'), 'the old dated leftover was aged out, not orphaned');
      for (const n of files) {
        assert.doesNotMatch(n, /\d{8}-\d{6}/, `${n} carries no date or time`);
        assert.match(n, /^flint-backup-\d{2}\.json$/, `${n} is a plain slot name`);
      }
      // the copies are real journals, not empty placeholders
      const first = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
      assert.ok(first.entries && first.entries['2026-04-04'], 'the copy holds the journal');
    } finally {
      store.init(root);
    }
  });

  // Turning encryption OFF decrypts each photo into a .rekey sidecar before
  // renaming it in. If that rename failed the sidecars were kept, which is right
  // for a PIN change (the sidecar is then the only copy under the surviving key)
  // and wrong here: these hold DECRYPTED photo bytes while the originals are
  // untouched, so keeping them left readable photographs beside an encrypted
  // journal with nothing to ever remove them. Nothing sweeps .rekey by name.
  await test('turning encryption off never leaves a decrypted photo sidecar behind', async () => {
    const tmpRoot = tempRoot('flint-sidecar-');
    const PS2 = store.init(tmpRoot);
    try {
      await store.saveData(store.emptyData());
      assert.ok((await store.enableEncryption('sidecar1234')).ok, 'encrypted');
      const ids = [];
      for (let i = 0; i < 2; i++) {
        const src = path.join(tmpRoot, `s${i}.png`);
        fs.writeFileSync(src, Buffer.from('89504e470d0a1a0a' + 'ab'.repeat(50) + String(i).repeat(2), 'hex'));
        const add = await store.addMedia(src);
        assert.ok(add.ok, `photo ${i} stored`);
        ids.push(add.id);
      }

      // Force the rename step to fail, exactly as a file held open would.
      const realRename = fsp.rename;
      fsp.rename = async (from, to) => {
        if (String(from).endsWith('.rekey')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
        return realRename(from, to);
      };
      let res;
      try { res = await store.disableEncryption('sidecar1234'); } finally { fsp.rename = realRename; }

      assert.strictEqual(res.ok, false, 'turning encryption off is refused');
      const leftovers = fs.readdirSync(PS2.mediaDir).filter((n) => n.endsWith('.rekey'));
      assert.strictEqual(leftovers.length, 0, `no decrypted sidecars are left behind (found ${leftovers.length})`);
      // and every photo on disk is still encrypted, as the message claims
      for (const id of ids) {
        const blob = fs.readFileSync(path.join(PS2.mediaDir, id));
        assert.ok(blob.subarray(0, 9).equals(Buffer.from('FLINTMED1')), 'the photo is still encrypted');
      }
      assert.strictEqual(JSON.parse(fs.readFileSync(PS2.dataFile, 'utf8')).flintEncrypted, 1, 'the journal is still a vault');
    } finally {
      store.lock();
      store.init(root);
    }
  });

  await test('H5: a PIN change that fails partway leaves every photo readable', async () => {
    const rootR = tempRoot('flint-h5-');
    const PR = store.init(rootR);
    try {
      await store.saveData(store.emptyData());
      assert.ok((await store.enableEncryption('firstpin1')).ok, 'encrypted');

      // three photos, all readable under the current PIN
      const ids = [];
      for (let i = 0; i < 3; i++) {
        const src = path.join(rootR, `shot${i}.png`);
        fs.writeFileSync(src, Buffer.from('89504e470d0a1a0a' + String(i).repeat(2) + 'cd'.repeat(64), 'hex'));
        const add = await store.addMedia(src);
        assert.ok(add.ok, `photo stored (${add.error || ''})`);
        ids.push(add.id);
      }

      // make the LAST photo unreadable so the rekey fails partway through,
      // exactly like a file held open by another program
      const victim = path.join(PR.mediaDir, ids[2]);
      fs.writeFileSync(victim, Buffer.concat([Buffer.from('FLINTMED1'), Buffer.from('not decryptable under any key')]));

      const before = ids.slice(0, 2).map((id) => fs.readFileSync(path.join(PR.mediaDir, id)));
      const res = await store.changeEncryptionPin('firstpin1', 'secondpin2');
      assert.strictEqual(res.ok, false, 'the PIN change is refused');
      // The file was deliberately corrupted, so this is the PERMANENT kind of
      // failure. Saying "please try again" would be advice that can never work,
      // so it names the file and offers to go on without it instead.
      assert.deepStrictEqual(res.damagedPhotos, [ids[2]], 'the damaged file is named');
      assert.doesNotMatch(res.error, /try again/i, 'and does not tell the user to retry forever');

      // the promise the message makes must actually hold
      ids.slice(0, 2).forEach((id, i) => {
        const now = fs.readFileSync(path.join(PR.mediaDir, id));
        assert.ok(now.equals(before[i]), `photo ${i} was not rewritten under a discarded key`);
      });
      const sidecars = fs.readdirSync(PR.mediaDir).filter((n) => n.endsWith('.rekey'));
      assert.strictEqual(sidecars.length, 0, 'no half-finished copies are left behind');

      // M-2: going on without the damaged file must actually work, and must
      // leave that file untouched rather than deleting it.
      const damagedBefore = fs.readFileSync(victim);
      const retry = await store.changeEncryptionPin('firstpin1', 'secondpin2', { skipDamaged: true });
      assert.strictEqual(retry.ok, true, `the PIN change goes through without it (${retry.error || ''})`);
      assert.deepStrictEqual(retry.damagedPhotos, [ids[2]], 'and reports what it skipped');
      assert.ok(fs.readFileSync(victim).equals(damagedBefore), 'the damaged file is left exactly as it was');
      // the two good photos moved to the new key
      store.lock();
      assert.strictEqual((await store.unlock('secondpin2')).ok, true, 'the NEW PIN works');
      for (const id of ids.slice(0, 2)) {
        const got = await store.getMedia(id);
        assert.ok(got.ok, `photo still opens under the new PIN (${got.error || ''})`);
      }
      store.lock();
      assert.strictEqual((await store.unlock('firstpin1')).ok, false, 'the old PIN no longer works');
      assert.strictEqual((await store.unlock('secondpin2')).ok, true, 'back in with the new one');

    } finally {
      store.init(root);
    }
  });

  await test('L7: addMedia checks the file itself, not just its name', async () => {
    const rootA = tempRoot('flint-l7-');
    store.init(rootA);
    try {
      await store.saveData(store.emptyData());

      // A missing file used to throw straight out of the IPC handler.
      const gone = await store.addMedia(path.join(rootA, 'never-existed.png'));
      assert.strictEqual(gone.ok, false, 'a missing file is refused, not thrown');
      assert.match(gone.error, /could not be opened/i, 'and says so plainly');

      // A folder named like an image.
      const dir = path.join(rootA, 'a-folder.png');
      fs.mkdirSync(dir);
      assert.strictEqual((await store.addMedia(dir)).ok, false, 'a directory is not a photo');

      // The real point: the extension is a claim. Flint renders attachments back
      // into the writing window, so a file gets in on its bytes or not at all.
      const liar = path.join(rootA, 'not-really.png');
      fs.writeFileSync(liar, Buffer.from('<?php echo "not an image"; ?>'));
      const res = await store.addMedia(liar);
      assert.strictEqual(res.ok, false, 'a renamed non-image is refused');
      assert.match(res.error, /not PNG/i, 'and the message says why');

      // A genuine file of each accepted kind still goes in.
      const real = {
        '.png': Buffer.from('89504e470d0a1a0a', 'hex'),
        '.jpg': Buffer.from('ffd8ff', 'hex'),
        '.gif': Buffer.from('474946383961', 'hex'),
        '.webp': Buffer.concat([Buffer.from('RIFF'), Buffer.from('0000', 'hex'), Buffer.from('00', 'hex'), Buffer.from('00', 'hex'), Buffer.from('WEBP')])
      };
      for (const [ext, magic] of Object.entries(real)) {
        const good = path.join(rootA, `real${ext}`);
        fs.writeFileSync(good, Buffer.concat([magic, Buffer.alloc(64, 7)]));
        const add = await store.addMedia(good);
        assert.strictEqual(add.ok, true, `a real ${ext} is accepted (${add.error || ''})`);
      }

      // Oversize is refused without reading the file into memory first.
      const big = path.join(rootA, 'huge.png');
      fs.writeFileSync(big, Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(21 * 1024 * 1024)]));
      assert.match((await store.addMedia(big)).error, /bigger than 20 MB/i, 'oversize refused');
    } finally {
      store.init(root);
    }
  });

  await test('S1: prompts and templates are encrypted with the journal, and survive the round trip', async () => {
    const rootS = tempRoot('flint-split-');
    const PSP = store.init(rootS);
    try {
      await store.saveData(store.emptyData());
      const PRIVATE = 'The appointment on Thursday, and what I want to say';
      await store.saveTemplates([{ name: 'Thursday', body: PRIVATE }]);
      await store.saveQuestions([{ key: 'mood', title: 'A private prompt title' }]);
      await store.saveActivities(['Something personal']);

      // Plaintext to begin with, and the words really are in the file.
      const before = fs.readFileSync(PSP.contentFile, 'utf8');
      assert.ok(before.includes(PRIVATE), 'plaintext while encryption is off');
      const settingsText = fs.existsSync(PSP.settingsFile) ? fs.readFileSync(PSP.settingsFile, 'utf8') : '';
      assert.ok(!settingsText.includes(PRIVATE), 'and NOT left behind in settings.json');

      assert.ok((await store.enableEncryption('splitpin12')).ok, 'encrypted');

      // The actual promise: the words are no longer readable on disk.
      const sealed = fs.readFileSync(PSP.contentFile);
      assert.ok(!sealed.toString('utf8').includes(PRIVATE), 'the template body is not readable on disk');
      assert.ok(!sealed.toString('utf8').includes('A private prompt title'), 'nor is the prompt title');
      assert.strictEqual(sealed.subarray(0, 9).toString('latin1'), 'FLINTSET1', 'it is the sealed form');

      // And still readable through the app while unlocked.
      assert.strictEqual((await store.loadTemplates()).templates[0].body, PRIVATE, 'still readable unlocked');

      // Locked: no words, and NO list masquerading as an empty answer.
      store.lock();
      for (const [name, res] of [['questions', await store.loadQuestions()],
                                 ['templates', await store.loadTemplates()],
                                 ['activities', await store.loadActivities()],
                                 ['titles', await store.knownTitles()]]) {
        assert.strictEqual(res.ok, false, `${name} refuses while locked`);
        assert.strictEqual(res.reason, 'locked', `${name} says why`);
        assert.ok(!res.questions && !res.templates && !res.activities && !res.titles,
          `${name} hands back no list at all`);
      }

      // A locked write must fail rather than replace what it could not read.
      const sealedBytes = fs.readFileSync(PSP.contentFile);
      await assert.rejects(() => store.saveTemplates([{ name: 'X', body: 'y' }]), Error,
        'a locked save is refused');
      assert.ok(fs.readFileSync(PSP.contentFile).equals(sealedBytes), 'and the file is byte-identical');

      assert.ok((await store.unlock('splitpin12')).ok, 'unlocked');
      assert.strictEqual((await store.loadTemplates()).templates[0].body, PRIVATE, 'the words came back');
      assert.strictEqual((await store.loadQuestions()).questions[0].title, 'A private prompt title');
    } finally {
      store.lock();
      store.init(root);
    }
  });

  await test('S2: a PIN change re-keys the content, and turning encryption off returns it readable', async () => {
    const rootT = tempRoot('flint-split2-');
    const PT = store.init(rootT);
    try {
      await store.saveData(store.emptyData());
      const BODY = 'Words that must survive a key rotation';
      await store.saveTemplates([{ name: 'Keep', body: BODY }]);
      assert.ok((await store.enableEncryption('firstpin99')).ok, 'encrypted');

      // Change the PIN: the data key rotates, so the content must be rewritten
      // under the new one or it is stranded.
      assert.ok((await store.changeEncryptionPin('firstpin99', 'secondpin88')).ok, 'PIN changed');
      store.lock();
      assert.strictEqual((await store.unlock('firstpin99')).ok, false, 'old PIN is dead');
      assert.ok((await store.unlock('secondpin88')).ok, 'new PIN works');
      assert.strictEqual((await store.loadTemplates()).templates[0].body, BODY,
        'the template survived the rotation');
      assert.ok(!fs.readFileSync(PT.contentFile).toString('utf8').includes(BODY), 'still sealed');

      // Turning encryption off must hand the words back in the clear. If the key
      // were cleared first they would be unreachable forever.
      assert.ok((await store.disableEncryption('secondpin88')).ok, 'encryption off');
      const plain = fs.readFileSync(PT.contentFile, 'utf8');
      assert.ok(plain.includes(BODY), 'the template is readable again');
      assert.strictEqual((await store.loadTemplates()).templates[0].body, BODY, 'and loads');
    } finally {
      store.lock();
      store.init(root);
    }
  });

  await test('S3: a journal written before the split keeps its templates, and settings.json is stripped', async () => {
    const rootM = tempRoot('flint-split3-');
    const PM = store.init(rootM);
    try {
      await store.saveData(store.emptyData());
      // Exactly what an older version left behind: the four fields inside
      // settings.json, and no content.json at all.
      const LEGACY = 'A template written by an older version';
      fs.mkdirSync(PM.dataDir, { recursive: true });
      fs.writeFileSync(PM.settingsFile, JSON.stringify({
        theme: 'dark',
        hardwareAcceleration: false,
        templates: [{ name: 'Old', body: LEGACY }],
        activities: ['Legacy activity']
      }, null, 2));
      assert.ok(!fs.existsSync(PM.contentFile), 'no content file yet');

      const got = await store.loadTemplates();
      assert.strictEqual(got.templates[0].body, LEGACY, 'the old template is carried across');
      assert.ok(fs.existsSync(PM.contentFile), 'and a content file now exists');

      // The point of migrating: the words are no longer in settings.json.
      const s = JSON.parse(fs.readFileSync(PM.settingsFile, 'utf8'));
      assert.ok(!('templates' in s), 'templates removed from settings');
      assert.ok(!('activities' in s), 'activities removed from settings');
      assert.strictEqual(s.theme, 'dark', 'unrelated settings untouched');
      assert.strictEqual(s.hardwareAcceleration, false, 'and the startup flag stays put');

      // Idempotent: running again changes nothing and loses nothing.
      const again = await store.loadTemplates();
      assert.deepStrictEqual(again.templates, got.templates, 'second read is identical');

      // The constraint that cannot break: this flag is read synchronously before
      // any key exists, so it must still be reachable from the cleartext file.
      assert.strictEqual(store.readStartupFlagsSync().hardwareAcceleration, false,
        'the startup flag is still readable without a key');
    } finally {
      store.init(root);
    }
  });

  await test('S4: deleting settings.json still clears the window PIN, but no longer costs the templates', async () => {
    // This is the documented recovery for a forgotten window PIN. Before the
    // split it also destroyed every template and custom prompt, because they
    // lived in the file being deleted.
    const rootR = tempRoot('flint-split4-');
    const PR2 = store.init(rootR);
    try {
      await store.saveData(store.emptyData());
      const KEEP = 'Should outlive the recovery step';
      await store.saveTemplates([{ name: 'Keep', body: KEEP }]);
      await store.setPin('4321');
      assert.strictEqual(await store.pinIsSet(), true, 'window PIN set');

      fs.unlinkSync(PR2.settingsFile);
      store.init(rootR); // a restart, so nothing is served from cache

      assert.strictEqual(await store.pinIsSet(), false, 'the window PIN is gone, as documented');
      assert.strictEqual((await store.loadTemplates()).templates[0].body, KEEP,
        'and the templates survived, which they did not used to');
    } finally {
      store.init(root);
    }
  });

  await test('S5: an unreadable content file never turns into defaults', async () => {
    const rootU = tempRoot('flint-split5-');
    const PU2 = store.init(rootU);
    try {
      await store.saveData(store.emptyData());
      await store.saveTemplates([{ name: 'Real', body: 'real words' }]);

      // Corrupt it while the journal is plaintext, so "locked" cannot be the
      // explanation: this is specifically the unreadable case.
      fs.writeFileSync(PU2.contentFile, '{ this is not json');
      store.init(rootU);

      for (const res of [await store.loadTemplates(), await store.loadQuestions(),
                         await store.loadActivities(), await store.knownTitles()]) {
        assert.strictEqual(res.ok, false, 'refused');
        assert.strictEqual(res.reason, 'unreadable', 'and named as unreadable, not empty');
      }
      // And a write on top of it is refused, rather than flattening the file.
      const before = fs.readFileSync(PU2.contentFile);
      await assert.rejects(() => store.saveTemplates([{ name: 'X', body: 'y' }]), Error);
      assert.ok(fs.readFileSync(PU2.contentFile).equals(before), 'the damaged file is left alone');
    } finally {
      store.init(root);
    }
  });

  await test('S7: a plaintext content file beside an encrypted journal is still readable, then resealed', async () => {
    // The state an interrupted enable leaves behind: the vault committed, but the
    // content file never got sealed. Deciding the form from encryptedOnDisk
    // instead of the file's own first bytes would try to decrypt plaintext here
    // and report the templates unreadable, which is a brick, not a fallback.
    const rootP = tempRoot('flint-split7-');
    const PP = store.init(rootP);
    try {
      await store.saveData(store.emptyData());
      const BODY = 'Written before the seal was finished';
      await store.saveTemplates([{ name: 'Half', body: BODY }]);
      assert.ok((await store.enableEncryption('sealpin1234')).ok, 'encrypted');

      // Put the file back the way an interrupted enable would have left it.
      fs.writeFileSync(PP.contentFile, JSON.stringify({ flintContent: 1, templates: [{ name: 'Half', body: BODY }] }, null, 2));
      store.init(rootP);
      assert.ok((await store.securityStatus()).encrypted, 'journal is still a vault');
      assert.ok((await store.unlock('sealpin1234')).ok, 'unlocked');

      // Readable despite the mismatch, because the form comes from the bytes.
      assert.strictEqual((await store.loadTemplates()).templates[0].body, BODY,
        'the plaintext content file is still readable');

      // And the unlock that just ran should have resealed it.
      const now = fs.readFileSync(PP.contentFile);
      assert.strictEqual(now.subarray(0, 9).toString('latin1'), 'FLINTSET1',
        'reconcile sealed it on unlock');
      assert.ok(!now.toString('utf8').includes(BODY), 'and the words are no longer on disk in the clear');
    } finally {
      store.lock();
      store.init(root);
    }
  });

  await test('S6: resetAll removes the content file too', async () => {
    const rootZ = tempRoot('flint-split6-');
    const PZ = store.init(rootZ);
    try {
      await store.saveData(store.emptyData());
      await store.saveTemplates([{ name: 'Gone', body: 'after a reset' }]);
      assert.ok(fs.existsSync(PZ.contentFile), 'content file exists');
      await store.resetAll();
      assert.ok(!fs.existsSync(PZ.contentFile), 'and is removed by a full reset');
    } finally {
      store.init(root);
    }
  });

  await test('PENTEST-M2: enabling encryption strips the four fields from a legacy settings.json', async () => {
    // Found by a running pentest PoC: enableEncryption sealed content.json but
    // left the same prompts, template bodies and activity names readable in
    // settings.json, on any install that still carried them there (a pre-split
    // upgrade, or one whose boot-time migration strip was swallowed by a lock).
    // enableEncryption returned ok:true with no warning while a full plaintext
    // copy of the person's own words sat beside the encrypted journal.
    const rootM = tempRoot('flint-m2-');
    const PMX = store.init(rootM);
    try {
      await store.saveData(store.emptyData());
      // Exactly the pre-content.json shape, and NO getMedia/loadContent call
      // first, so the boot migration has not run.
      fs.mkdirSync(PMX.dataDir, { recursive: true });
      fs.writeFileSync(PMX.settingsFile, JSON.stringify({
        theme: 'dark', hardwareAcceleration: false,
        templates: [{ name: 'Evening', body: 'PLAINTEXT_TEMPLATE_SECRET' }],
        questions: [{ key: 'mood', title: 'PLAINTEXT_PROMPT_SECRET' }],
        activities: ['PLAINTEXT_ACTIVITY_SECRET']
      }, null, 2));

      assert.strictEqual((await store.enableEncryption('1234')).ok, true, 'encrypted');

      const s = fs.readFileSync(PMX.settingsFile, 'utf8');
      assert.ok(!s.includes('PLAINTEXT_TEMPLATE_SECRET'), 'template body stripped from settings.json');
      assert.ok(!s.includes('PLAINTEXT_PROMPT_SECRET'), 'prompt title stripped');
      assert.ok(!s.includes('PLAINTEXT_ACTIVITY_SECRET'), 'activity stripped');
      assert.ok(JSON.parse(s).theme === 'dark', 'unrelated settings untouched');
      // and the words are sealed, not simply gone
      const c = fs.readFileSync(PMX.contentFile);
      assert.strictEqual(c.subarray(0, 9).toString('latin1'), 'FLINTSET1', 'content.json is sealed');
      assert.ok(!c.toString('utf8').includes('PLAINTEXT_TEMPLATE_SECRET'), 'and not readable there either');
    } finally {
      store.lock();
      store.init(root);
    }
  });

  await test('PENTEST-L1: an unparseable quarantined copy is removed, not reported as stuck', async () => {
    // Found by a running pentest PoC: purgePlaintextIn ran JSON.parse and unlink
    // in one try, so a readable-but-invalid-JSON copy (the usual reason a file is
    // quarantined) threw before the unlink and was counted as "could not be
    // removed", advice no retry could satisfy, while readable diary text stayed
    // on disk after encryption was turned on.
    const rootL = tempRoot('flint-l1-');
    const PLX = store.init(rootL);
    try {
      const d = store.emptyData();
      d.entries['2026-01-01'] = { note: 'a real entry so the journal is not empty', updatedAt: 'x' };
      await store.saveData(d);
      const unparseable = path.join(PLX.dataDir, 'entries.json.corrupt-9999');
      fs.writeFileSync(unparseable, 'READABLE_DIARY_TEXT but not valid json {{{');
      // A genuine vault, so the "already encrypted, keep it" branch is exercised
      // for real rather than against a shape isVault would reject anyway.
      const vaultCrypto = require('../crypto');
      const { vault } = await vaultCrypto.createVault({ version: 1, entries: {} }, 'anotherpin1');
      const aVault = path.join(PLX.dataDir, 'entries.json.corrupt-8888');
      fs.writeFileSync(aVault, JSON.stringify(vault));

      const res = await store.enableEncryption('strongpass99');
      assert.strictEqual(res.ok, true, 'encrypted');
      assert.ok(!fs.existsSync(unparseable), 'the unparseable plaintext copy was removed');
      assert.ok(fs.existsSync(aVault), 'but a copy that IS a vault is kept');
      assert.deepStrictEqual(res.leftovers || [], [], 'and nothing is falsely reported as unremovable');
    } finally {
      store.lock();
      store.init(root);
    }
  });

  await test('PENTEST-L2: a null or non-object day never crashes an export', async () => {
    // Found by a running pentest PoC: isValidData validates the entries container
    // but never each day, so a single null day (ordinary corruption) reached
    // orderedAnswers, which dereferenced it, and took down every export format.
    store.init(tempRoot('flint-l2-'));
    const bad = { version: 1, entries: {
      '2025-01-01': null, '2025-01-02': [1, 2, 3], '2025-01-03': 'a string',
      '2025-01-04': { note: 'a genuine entry that must still export' }
    } };
    const opts = { questions: store.DEFAULT_QUESTIONS, knownTitles: {} };
    for (const build of ['buildExportText', 'buildExportMarkdown', 'buildExportHtml', 'buildActivityReport', 'buildActivityReportHtml']) {
      let out;
      assert.doesNotThrow(() => { out = store[build](bad, opts); }, `${build} survives a corrupt day`);
      assert.strictEqual(typeof out, 'string', `${build} still produced output`);
    }
    // the one good day is still present in a full export
    assert.match(store.buildExportText(bad, opts), /genuine entry that must still export/, 'the valid day still exports');
    store.init(root);
  });

  await test('M5: the PIN meter prices a known-weak PIN by the wordlist, not the character set', async () => {
    // common-pins.js existed with no test at all, which is a poor state for the
    // one file whose entire job is to stop the meter lying. The estimator lives
    // in the renderer and cannot be required, so the shipped source is lifted out
    // and run directly: a reimplementation here would test itself, not the app.
    const { COMMON_PINS, COMMON_SUFFIXES, COMMON_PREFIXES } = require('../shared/common-pins');
    assert.ok(COMMON_PINS.length > 50, 'the wordlist is populated');
    assert.ok(COMMON_PINS.includes('password'), 'and contains the obvious ones');
    assert.deepStrictEqual(COMMON_PINS.map((w) => w.toLowerCase()), COMMON_PINS,
      'entries are lowercase, which is what the matcher assumes');

    // Normalised first: the working tree is CRLF, so a '\n}\n' scan finds nothing
    // and silently lifts an empty string, which then fails as a confusing
    // "not defined" rather than as "the function moved".
    const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8').split('\r\n').join('\n');
    const lift = (name) => {
      const at = src.indexOf(`function ${name}(`);
      assert.ok(at > -1, `${name} still exists in app.js`);
      const end = src.indexOf('\n}\n', at);
      assert.ok(end > at, `${name} has a findable end in app.js`);
      const out = src.slice(at, end + 3);
      assert.ok(out.includes('return'), `${name} was lifted with a body`);
      return out;
    };
    const sandbox = { COMMON_PINS, COMMON_SUFFIXES, COMMON_PREFIXES };
    const body = `const GUESSES_PER_SEC = 500;\n${lift('wordlistGuesses')}\n${lift('crackSeconds')}\n`
      + 'return { wordlistGuesses, crackSeconds };';
    const { wordlistGuesses, crackSeconds } = new Function(
      'COMMON_PINS', 'COMMON_SUFFIXES', 'COMMON_PREFIXES', body
    )(sandbox.COMMON_PINS, sandbox.COMMON_SUFFIXES, sandbox.COMMON_PREFIXES);

    // The measured case that prompted the whole file: "password1" was found in
    // 2.29 seconds against a real vault while the meter said thousands of years.
    const YEAR = 60 * 60 * 24 * 365;
    for (const weak of ['password1', 'Password1', 'letmein123', 'qwerty', 'iloveyou!', '1111', '123456789']) {
      assert.notStrictEqual(wordlistGuesses(weak), null, `${weak} is recognised as known-weak`);
      assert.ok(crackSeconds(weak) < 60 * 60, `${weak} is not called safe (got ${crackSeconds(weak)}s)`);
    }

    // And the promise made in the comment: the wordlist can only ever lower an
    // estimate, so a PIN that owes nothing to it is untouched.
    for (const strong of ['xk4vT!m9qLz2', 'correct-horse-battery-staple-7']) {
      assert.strictEqual(wordlistGuesses(strong), null, `${strong} is not on any list`);
      assert.ok(crackSeconds(strong) > 100 * YEAR, `${strong} is still rated strong`);
    }
  });

  await test('M4: a day holding only a photo still exports, in every format', async () => {
    // The comment above entryMediaCount promises this, and the code delivered it,
    // but nothing held it there: dropping the media clause from entryHasContent
    // would silently erase those days from every export, and the person would
    // only find out from an export they made because something had gone wrong.
    const d = store.emptyData();
    d.entries['2026-04-04'] = { __media: [{ id: 'a.bin' }, { id: 'b.bin' }], updatedAt: 'x' };
    d.entries['2026-04-05'] = { note: 'a day with words', updatedAt: 'x' };
    d.entries['2026-04-06'] = { __media: [{ id: null }, 'junk'], updatedAt: 'x' };
    const opts = { questions: store.DEFAULT_QUESTIONS, knownTitles: {} };

    for (const build of ['buildExportText', 'buildExportMarkdown', 'buildExportHtml']) {
      const out = store[build](d, opts);
      assert.ok(/4 April 2026|2026-04-04/.test(out), `${build}: the photo-only day is in the export`);
      assert.match(out, /2 photos/, `${build}: and says how many`);
      assert.ok(/5 April 2026|2026-04-05/.test(out), `${build}: the written day is still there too`);
      // A day whose only attachments are malformed entries has nothing in it.
      assert.ok(!/6 April 2026|2026-04-06/.test(out), `${build}: a day with no real photo is not padded in`);
    }
  });

  await test('M3: turning encryption OFF with a damaged photo refuses, then can go on without it', async () => {
    // The mirror of H5, and the more dangerous direction: here the key is thrown
    // away at the end, so a photo still encrypted after this is gone for good,
    // and a sidecar left behind is a DECRYPTED photo sitting next to a journal
    // that no longer has anything to clean it up. Neither had a test.
    const rootD = tempRoot('flint-m3-');
    const PD = store.init(rootD);
    try {
      await store.saveData(store.emptyData());
      assert.ok((await store.enableEncryption('offpin1234')).ok, 'encrypted');

      const ids = [];
      for (let i = 0; i < 3; i++) {
        const src = path.join(rootD, `pic${i}.png`);
        fs.writeFileSync(src, Buffer.from('89504e470d0a1a0a' + String(i).repeat(2) + 'ab'.repeat(64), 'hex'));
        const add = await store.addMedia(src);
        assert.ok(add.ok, `photo stored (${add.error || ''})`);
        ids.push(add.id);
      }

      const victim = path.join(PD.mediaDir, ids[1]);
      fs.writeFileSync(victim, Buffer.concat([Buffer.from('FLINTMED1'), Buffer.from('damaged beyond any key')]));
      const damagedBefore = fs.readFileSync(victim);
      const goodBefore = [ids[0], ids[2]].map((id) => fs.readFileSync(path.join(PD.mediaDir, id)));

      const res = await store.disableEncryption('offpin1234');
      assert.strictEqual(res.ok, false, 'refused rather than stranding a photo');
      assert.deepStrictEqual(res.damagedPhotos, [ids[1]], 'the damaged file is named');
      assert.doesNotMatch(res.error, /try again/i, 'no advice that can never work');
      assert.strictEqual(JSON.parse(fs.readFileSync(PD.dataFile, 'utf8')).flintEncrypted, 1, 'still a vault');

      // Nothing half-done: no sidecars, and the good photos are untouched and
      // still encrypted, because the journal is still encrypted.
      assert.strictEqual(fs.readdirSync(PD.mediaDir).filter((n) => n.endsWith('.rekey')).length, 0, 'no sidecars left');
      [ids[0], ids[2]].forEach((id, i) => {
        assert.ok(fs.readFileSync(path.join(PD.mediaDir, id)).equals(goodBefore[i]), `photo ${i} untouched`);
      });

      // Going on without it: the good photos come out readable, the damaged one
      // is left exactly as it was rather than quietly deleted.
      const retry = await store.disableEncryption('offpin1234', { skipDamaged: true });
      assert.strictEqual(retry.ok, true, `encryption turns off without it (${retry.error || ''})`);
      assert.deepStrictEqual(retry.damagedPhotos, [ids[1]], 'and reports what it skipped');
      assert.ok(fs.readFileSync(victim).equals(damagedBefore), 'the damaged file is left exactly as it was');
      assert.strictEqual(fs.readdirSync(PD.mediaDir).filter((n) => n.endsWith('.rekey')).length, 0, 'and no sidecars survive');

      const plain = JSON.parse(fs.readFileSync(PD.dataFile, 'utf8'));
      assert.ok(!plain.flintEncrypted, 'the journal is plaintext now');
      for (const id of [ids[0], ids[2]]) {
        const raw = fs.readFileSync(path.join(PD.mediaDir, id));
        assert.ok(!raw.subarray(0, 9).equals(Buffer.from('FLINTMED1')), 'the good photos really were decrypted');
        const got = await store.getMedia(id);
        assert.ok(got.ok, `and still open (${got.error || ''})`);
      }
    } finally {
      store.lock();
      store.init(root);
    }
  });

  await test('enableEncryption sweeps a readable copy left beside the journal, keeps an encrypted one', async () => {
    const rootS = tempRoot('flint-sweep-');
    const PS = store.init(rootS);
    try {
      await store.securityStatus();
      const d = store.emptyData();
      d.entries['2026-05-05'] = { note: 'readable copy that must not linger beside the vault' };
      await store.saveData(d);

      // Readable leftovers sitting in the data root beside the journal: a corrupt
      // copy set aside by loadData and a half-written .tmp (both plaintext), plus a
      // corrupt copy that is itself a vault and must be KEPT.
      const plainCorrupt = path.join(PS.dataDir, 'entries.json.corrupt-20260101-000000-000');
      const plainTmp = PS.dataFile + '.tmp';
      const vaultCorrupt = path.join(PS.dataDir, 'entries.json.corrupt-20260101-000000-001');
      // A foreign .tmp standing in for a concurrent settings write (which runs
      // off the save lock): the sweep must NOT delete it.
      const foreignTmp = path.join(PS.dataDir, 'keepme.tmp');
      fs.writeFileSync(plainCorrupt, JSON.stringify(d));
      fs.writeFileSync(plainTmp, JSON.stringify(d));
      fs.writeFileSync(vaultCorrupt, JSON.stringify({ flintEncrypted: 1, kdf: 'scrypt', pin: 'x', recovery: 'x', body: 'x' }));
      fs.writeFileSync(foreignTmp, 'a concurrent settings write in progress');

      assert.ok((await store.enableEncryption('sweeppin')).ok, 'encryption turned on');

      assert.ok(!fs.existsSync(plainCorrupt), 'the readable corrupt copy was removed');
      assert.ok(!fs.existsSync(plainTmp), 'no readable entries .tmp lingers beside the vault');
      assert.ok(fs.existsSync(vaultCorrupt), 'an already-encrypted corrupt copy was kept');
      assert.ok(fs.existsSync(foreignTmp), 'a foreign .tmp (concurrent settings write) is left untouched');
      assert.strictEqual(JSON.parse(fs.readFileSync(PS.dataFile, 'utf8')).flintEncrypted, 1, 'the live journal is a vault');
    } finally {
      store.init(root);
    }
  });

  await test('addMedia refuses to write a cleartext photo over a drifted vault', async () => {
    // Same disaster as the save guard, for attachments: a vault on disk while the
    // in-memory flag still says plaintext must never yield a readable image.
    const rootM = tempRoot('flint-media-guard-');
    const PM = store.init(rootM);
    try {
      await store.securityStatus();
      await store.saveData(store.emptyData());
      assert.ok((await store.enableEncryption('guardpin')).ok, 'encrypted');
      const vaultBytes = fs.readFileSync(PM.dataFile);
      assert.strictEqual((await store.disableEncryption('guardpin')).ok, true, 'back to plaintext');
      assert.strictEqual((await store.securityStatus()).encrypted, false, 'app believes it is plaintext');

      // A vault reappears underneath the app (a restore, a sync, a stale flag).
      fs.writeFileSync(PM.dataFile, vaultBytes);

      const src = path.join(os.tmpdir(), `flint-media-guard-${Date.now()}.png`);
      // A COMPLETE PNG signature. This was a truncated one, which addMedia now
      // rejects on format before it ever reaches the drift guard being tested,
      // so the test would have passed for the wrong reason.
      fs.writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
      try {
        const res = await store.addMedia(src);
        assert.strictEqual(res.ok, false, 'the photo was refused');
        assert.match(res.error, /lost track of the key/i, 'told to unlock and retry');
        let mediaNames = [];
        try { mediaNames = fs.readdirSync(PM.mediaDir); } catch { /* dir never created */ }
        assert.strictEqual(mediaNames.length, 0, 'no image file was written beside the vault');
        assert.strictEqual(JSON.parse(fs.readFileSync(PM.dataFile, 'utf8')).flintEncrypted, 1, 'the vault is untouched');
      } finally {
        fs.unlinkSync(src);
      }
    } finally {
      store.init(root);
    }
  });

  await test('a vault written at the old cost still opens, and upgrades on unlock', async () => {
    const nodeCrypto = require('crypto');
    const legacyRoot = tempRoot('flint-legacy-');
    const PL = store.init(legacyRoot);
    try {
      const enc = (k, buf) => {
        const iv = nodeCrypto.randomBytes(12);
        const c = nodeCrypto.createCipheriv('aes-256-gcm', k, iv);
        const ct = Buffer.concat([c.update(buf), c.final()]);
        return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
      };
      const dk = nodeCrypto.randomBytes(32);
      // The old format: scrypt N=2^15 and no cost recorded in the slot.
      const mkWrap = (secret) => {
        const salt = nodeCrypto.randomBytes(16);
        const key = nodeCrypto.scryptSync(Buffer.from(secret, 'utf8'), salt, 32, { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 });
        return { salt: salt.toString('base64'), ...enc(key, dk) };
      };
      const legacy = {
        flintEncrypted: 1, kdf: 'scrypt',
        pin: mkWrap('legacypin'),
        recovery: mkWrap('LEGACYCODE'),
        body: enc(dk, Buffer.from(JSON.stringify({ version: 1, entries: { '2026-10-01': { note: 'written long ago' } } }), 'utf8'))
      };
      fs.writeFileSync(PL.dataFile, JSON.stringify(legacy, null, 2), 'utf8');

      await store.securityStatus();
      assert.strictEqual((await store.unlock('legacypin')).ok, true, 'an old vault still opens');
      const { data } = await store.loadData();
      assert.strictEqual(data.entries['2026-10-01'].note, 'written long ago', 'old words are readable');

      const after = JSON.parse(fs.readFileSync(PL.dataFile, 'utf8'));
      assert.strictEqual(after.pin.N, 65536, 'the PIN wrap was rewritten at the current cost');
      store.lock();
      assert.strictEqual((await store.unlock('legacypin')).ok, true, 'the same PIN works after the upgrade');
    } finally {
      store.init(root);
    }
  });

  await test('finishing onboarding stamps startedOn once and never overwrites it', async () => {
    const r = tempRoot('flint-started-');
    store.init(r);
    try {
      assert.strictEqual((await store.getStartedOn()).startedOn, '', 'blank before onboarding');
      await store.setOnboarded(true);
      const stamped = (await store.getStartedOn()).startedOn;
      assert.match(stamped, /^\d{4}-\d{2}-\d{2}$/, 'a local date was stamped');
      // Re-onboarding on the SAME day cannot detect an overwrite: the new value
      // would be identical. Plant an older date, as a real returning user has,
      // so moving it is visible. Otherwise a starter week silently restarts.
      const P1 = store.paths();
      const s1 = JSON.parse(fs.readFileSync(P1.settingsFile, 'utf8'));
      s1.startedOn = '2020-01-01';
      fs.writeFileSync(P1.settingsFile, JSON.stringify(s1), 'utf8');
      await store.setOnboarded(true);
      assert.strictEqual(
        (await store.getStartedOn()).startedOn, '2020-01-01',
        'a later run does not move an existing stamp'
      );
    } finally {
      store.init(root);
    }
  });

  await test('prompt picker is stable per day, cycles, and dodges cheery cats on Hard days', async () => {
    assert.strictEqual(
      prompts.promptForDay('2026-07-17', 0, []).text,
      prompts.promptForDay('2026-07-17', 0, []).text,
      'same day and offset returns the same prompt'
    );
    assert.ok(prompts.promptForDay('2026-07-18', 0, []).text, 'the next day still returns a prompt');
    const avoid = ['gratitude', 'savor', 'forward'];
    for (let off = 0; off < 48; off++) {
      assert.ok(!avoid.includes(prompts.promptForDay('2026-07-17', off, avoid).cat), `offset ${off} avoids cheery categories`);
    }

    // The three assertions above all pass if the picker ignores the date, the
    // offset, or both, which is how a live cycling bug shipped unnoticed. These
    // pin the two behaviours the names actually promise.
    const overDays = new Set();
    for (let i = 0; i < 28; i++) {
      const d = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
      overDays.add(prompts.promptForDay(d, 0, []).text);
    }
    assert.ok(overDays.size >= 20, `28 consecutive days offer varied prompts (got ${overDays.size} distinct)`);

    // "Show me another" must actually move, and cycling must reach every
    // allowed prompt exactly once before repeating, on an ordinary day and on a
    // Hard one where whole categories are filtered out.
    for (const cats of [[], avoid]) {
      const pool = prompts.PROMPT_LIBRARY.filter((p) => !cats.includes(p.cat));
      const seen = [];
      for (let off = 0; off < pool.length; off++) seen.push(prompts.promptForDay('2026-07-17', off, cats).text);
      assert.strictEqual(
        new Set(seen).size, pool.length,
        `cycling reaches every allowed prompt exactly once (avoid=[${cats}], ${new Set(seen).size} of ${pool.length})`
      );
      assert.strictEqual(
        prompts.promptForDay('2026-07-17', pool.length, cats).text, seen[0],
        `cycling wraps after the whole pool (avoid=[${cats}])`
      );
    }
  });

  await test('resetAll wipes entries, backups and settings back to brand new', async () => {
    const r = tempRoot('flint-reset-');
    const PR = store.init(r);
    try {
      const d = store.emptyData();
      d.entries['2026-04-01'] = { note: 'to be erased' };
      await store.saveData(d);
      await store.setOnboarded(true);
      assert.ok(fs.existsSync(PR.dataFile), 'entries exist before reset');
      const res = await store.resetAll();
      assert.strictEqual(res.ok, true, 'reset reports ok');
      assert.ok(!fs.existsSync(PR.dataFile), 'entries.json is gone');
      assert.ok(!fs.existsSync(PR.settingsFile), 'settings.json is gone');
      assert.deepStrictEqual((await store.loadData()).data.entries, {}, 'loads empty after reset');
      assert.strictEqual(await store.getOnboarded(), false, 'onboarding is due again');
      assert.strictEqual((await store.getStartedOn()).startedOn, '', 'startedOn cleared');
    } finally {
      store.init(root);
    }
  });

  store.init(root); // restore the main root

  console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
