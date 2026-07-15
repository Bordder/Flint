// Plain-Node tests for the data layer. Run with: npm test
// They use a throwaway temp folder and never touch real journal data.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../store');

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

  await test('concurrent saves are serialised — last one wins, file stays valid', async () => {
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
    const text = store.buildExportText(data, {
      questions: store.DEFAULT_QUESTIONS,
      now: new Date('2026-07-15T14:00:00')
    });

    assert.match(text, /Flint export/);
    assert.match(text, /Days recorded: 2/);
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
      food: 'Managed a sandwich.',
      __day: 'hard',
      __tags: ['migraine', 'work'],
      updatedAt: 'x'
    };
    const text = store.buildExportText(data, { questions: store.DEFAULT_QUESTIONS });
    assert.match(text, /Overall: Hard day/);
    assert.match(text, /Tags: migraine, work/);
  });

  await test('a day with only a marker or only tags still exports', async () => {
    const data = store.emptyData();
    data.entries['2026-04-11'] = { __day: 'good', updatedAt: 'x' };
    data.entries['2026-04-12'] = { __tags: ['holiday'], updatedAt: 'x' };
    const text = store.buildExportText(data, { questions: store.DEFAULT_QUESTIONS });
    assert.match(text, /Days recorded: 2/);
    assert.match(text, /Good day/);
    assert.match(text, /Tags: holiday/);
  });

  await test('answers to a removed prompt are still exported (never lost)', async () => {
    const data = store.emptyData();
    // "mood" is not one of the current questions — it is an orphaned answer
    data.entries['2026-04-13'] = { mood: 'Low but steady.', updatedAt: 'x' };
    const text = store.buildExportText(data, {
      questions: store.DEFAULT_QUESTIONS,
      knownTitles: { mood: 'Mood' }
    });
    assert.match(text, /Mood/);
    assert.match(text, /Low but steady\./);
  });

  await test('buildExportHtml escapes content and includes marker + tags', async () => {
    const data = store.emptyData();
    data.entries['2026-04-14'] = {
      food: 'Bread & butter <ok>',
      __day: 'mixed',
      __tags: ['a & b'],
      updatedAt: 'x'
    };
    const html = store.buildExportHtml(data, { questions: store.DEFAULT_QUESTIONS });
    assert.match(html, /Bread &amp; butter &lt;ok&gt;/);
    assert.match(html, /Mixed day/);
    assert.ok(!html.includes('<ok>'), 'raw angle brackets are escaped');
  });

  await test('prompts default, then save + normalise (dedupe keys, drop blank, keep titles)', async () => {
    const def = await store.loadQuestions();
    assert.ok(def.length >= 1 && def[0].key, 'defaults load when none saved');

    const saved = await store.saveQuestions([
      { key: 'work', title: 'Work', hint: 'How was work?' },
      { key: 'work', title: 'Duplicate key', hint: '' }, // clashing key gets regenerated
      { title: '   ', hint: 'blank title dropped' },
      { title: 'Gratitude' } // no key -> generated
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
    // save a set that does NOT include the default "eating" prompt
    await store.saveQuestions([{ key: 'food', title: 'Food and cooking' }]);
    const titles = await store.knownTitles();
    assert.strictEqual(titles.eating, 'Eating and drinking', 'default title still resolvable');

    const data = store.emptyData();
    data.entries['2026-08-01'] = { eating: 'Skipped lunch, no appetite.', updatedAt: 'x' };
    const questions = await store.loadQuestions();
    const text = store.buildExportText(data, { questions, knownTitles: titles });
    assert.match(text, /Eating and drinking/);
    assert.match(text, /Skipped lunch/);
  });

  await test('theme get/set persists', async () => {
    assert.strictEqual(await store.getTheme(), 'light', 'defaults to light');
    assert.strictEqual(await store.setTheme('dark'), 'dark');
    assert.strictEqual(await store.getTheme(), 'dark');
    assert.strictEqual(await store.setTheme('nonsense'), 'light', 'unknown value falls back to light');
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

  console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
