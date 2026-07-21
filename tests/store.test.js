// Plain-Node tests for the data layer. Run with: npm test
// They use a throwaway temp folder and never touch real journal data.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../store');
const prompts = require('../shared/prompts');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-test-'));
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
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-autosave-'));
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
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-test2-'));
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
    await assert.rejects(() => store.saveData(null));
    await assert.rejects(() => store.saveData({ entries: [] }));
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
    assert.match(rep, /A quieter day\./);
    assert.doesNotMatch(rep, /\b(PIP|DWP|benefit|assessment|disability|medical)\b/i, 'the report never labels itself');
    const html = store.buildActivityReportHtml(data, { questions: store.DEFAULT_QUESTIONS });
    assert.match(html, /Daily activities summary/);
    assert.match(html, /Preparing food/);
    assert.doesNotMatch(html, /\b(PIP|DWP|benefit|assessment|disability|medical)\b/i);
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
    const def = await store.loadQuestions();
    assert.ok(def.length >= 1 && def[0].key, 'defaults load when none saved');

    const saved = await store.saveQuestions([
      { key: 'work', title: 'Work', hint: 'How was work?' }, { key: 'work', title: 'Duplicate key', hint: '' }, // clashing key gets regenerated
      { title: '   ', hint: 'blank title dropped' }, { title: 'Gratitude' } // no key -> generated
    ]);
    assert.strictEqual(saved.length, 3, 'blank-title prompt dropped');
    const keys = saved.map((q) => q.key);
    assert.strictEqual(new Set(keys).size, keys.length, 'keys are unique');
    assert.ok(keys.every((k) => k && !k.startsWith('__') && k !== 'updatedAt'), 'no reserved keys');

    const reloaded = await store.loadQuestions();
    assert.deepStrictEqual(reloaded, saved, 'saved prompts persist');

    const titles = await store.knownTitles();
    assert.strictEqual(titles.work, 'Work', 'known titles recorded for later orphan labelling');
  });

  await test('saveQuestions refuses an all-blank list', async () => {
    await assert.rejects(() => store.saveQuestions([{ title: '  ' }]));
    await assert.rejects(() => store.saveQuestions([]));
  });

  await test('removing a default prompt still labels its old answers by title', async () => {
    // save a set that does NOT include the default "challenge" prompt
    await store.saveQuestions([{ key: 'highlight', title: 'A good moment' }]);
    const titles = await store.knownTitles();
    assert.strictEqual(titles.challenge, 'Something hard', 'default title still resolvable');

    const data = store.emptyData();
    data.entries['2026-08-01'] = { challenge: 'A rough afternoon, but I got through it.', updatedAt: 'x' };
    const questions = await store.loadQuestions();
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
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-startup-'));
    try {
      store.init(tmpRoot);
      assert.strictEqual(await store.getStartWithWindows(), false, 'a brand new install starts off');

      // simulate an existing install upgrading: only the old key is present
      await store.setRunInBackground(true);
      assert.strictEqual(await store.getStartWithWindows(), true, 'existing tray users keep starting with Windows');

      // once answered explicitly, the new key wins and the two are independent
      assert.strictEqual(await store.setStartWithWindows(false), false);
      assert.strictEqual(await store.getStartWithWindows(), false, 'an explicit no survives runInBackground being on');
      assert.strictEqual(await store.getRunInBackground(), true, 'the tray setting is untouched by the split');
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
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-hwaccel-'));
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
    assert.ok(Array.isArray(def) && def.length > 0, 'has a default set');
    const saved = await store.saveActivities(['  Rest  ', 'Rest', 'Walk', '', '   ']);
    assert.deepStrictEqual(saved, ['Rest', 'Walk'], 'trims, dedupes case-insensitively, drops blanks');
    assert.deepStrictEqual(await store.loadActivities(), ['Rest', 'Walk']);
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

  // ----------------------------------------------------------- encryption
  // These run last and in their own root, because turning encryption on
  // changes module-level session state (the in-memory data key).

  const secret = 'A quiet note only I should be able to read.';
  let recoveryCode = null;
  let mediaId = null;
  const photoBytes = Buffer.from('89504e470d0a1a0a' + 'ab'.repeat(96), 'hex'); // a stand-in PNG

  const cryptoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-crypto-'));
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
      await assert.rejects(() => vaultCrypto.openWithPin(v, '1234'), `${n} must not open with the old PIN`);
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
    assert.strictEqual((await store.getMedia(mediaId)).ok, false, 'refused while locked');
    await store.unlock('4321');
  });

  await test('an attachment id is never treated as a path', async () => {
    assert.strictEqual((await store.getMedia('../../entries.json')).ok, false, 'traversal refused');
    assert.strictEqual((await store.getMedia('..\\settings.json')).ok, false, 'traversal refused');
    assert.strictEqual((await store.removeMedia('../../entries.json')).ok, false, 'traversal refused');
    assert.ok(fs.existsSync(PC.dataFile), 'entries.json is untouched');
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
    const rootU = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-unreadable-'));
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
      await assert.rejects(() => store.saveData(d), 'the save fails rather than writing plaintext');
    } finally {
      try { fs.rmSync(PU.dataFile, { recursive: true, force: true }); } catch { /* best effort */ }
      store.init(root);
    }
  });

  await test('a save refuses to write plaintext over a vault', async () => {
    // Belt and braces for the same disaster: even if the in-memory flag were
    // wrong, the bytes on disk get the final say.
    const rootG = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-guard-'));
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

  await test('enableEncryption sweeps a readable copy left beside the journal, keeps an encrypted one', async () => {
    const rootS = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-sweep-'));
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
    const rootM = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-media-guard-'));
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
      fs.writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
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
    const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-legacy-'));
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
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-started-'));
    store.init(r);
    try {
      assert.strictEqual((await store.getStartedOn()).startedOn, '', 'blank before onboarding');
      await store.setOnboarded(true);
      const stamped = (await store.getStartedOn()).startedOn;
      assert.match(stamped, /^\d{4}-\d{2}-\d{2}$/, 'a local date was stamped');
      await store.setOnboarded(true);
      assert.strictEqual((await store.getStartedOn()).startedOn, stamped, 'a later run does not move it');
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
  });

  await test('resetAll wipes entries, backups and settings back to brand new', async () => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'flint-reset-'));
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
