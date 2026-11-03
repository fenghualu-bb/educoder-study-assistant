import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const module = await import('../src/data-upgrade.js').catch(() => ({}));
const prepare = options => {
  assert.equal(typeof module.prepareDataUpgrade, 'function', 'upgrade preparation must exist');
  return module.prepareDataUpgrade(options);
};

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'educoder-upgrade-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const inventory = Buffer.from('{"items":[{"progress":37}]}');
  const journal = Buffer.from('{"version":1,"phase":"stopped"}');
  await writeFile(path.join(dir, 'course-inventory.json'), inventory);
  await writeFile(path.join(dir, 'run-journal.json'), journal);
  return { dir, inventory, journal };
}

test('legacy progress is backed up byte-for-byte once without copying browser credentials', async t => {
  const { dir, inventory, journal } = await fixture(t);
  const profile = path.join(dir, 'browser-profile');
  await mkdir(profile);
  await writeFile(path.join(profile, 'Cookies'), 'synthetic-cookie');
  const first = await prepare({ dataDir: dir, appVersion: '0.1.1' });
  const backupDir = first.backupDir;
  assert.match(path.basename(backupDir), /^legacy-to-0\.1\.1--[a-f0-9]{64}$/);
  assert.deepEqual(first, { backedUp: true, backupDir });
  assert.deepEqual(await readFile(path.join(backupDir, 'course-inventory.json')), inventory);
  assert.deepEqual(await readFile(path.join(backupDir, 'run-journal.json')), journal);
  assert.deepEqual((await readdir(backupDir)).sort(), ['course-inventory.json', 'run-journal.json']);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'data-upgrade.json'), 'utf8')),
    { version: 1, appVersion: '0.1.1' });
  assert.deepEqual(await prepare({ dataDir: dir, appVersion: '0.1.1' }),
    { backedUp: false, backupDir: null });
  assert.deepEqual(await readdir(path.join(dir, 'upgrade-backups')), [path.basename(backupDir)]);
  assert.equal(await readFile(path.join(profile, 'Cookies'), 'utf8'), 'synthetic-cookie');
});

test('a later app version backs up the current files before changing its marker', async t => {
  const { dir, inventory, journal } = await fixture(t);
  await writeFile(path.join(dir, 'data-upgrade.json'), JSON.stringify({ version: 1, appVersion: '0.1.0' }));
  const result = await prepare({ dataDir: dir, appVersion: '0.1.1' });
  assert.match(path.basename(result.backupDir), /^0\.1\.0-to-0\.1\.1--[a-f0-9]{64}$/);
  assert.deepEqual(await readFile(path.join(result.backupDir, 'course-inventory.json')), inventory);
  assert.deepEqual(await readFile(path.join(result.backupDir, 'run-journal.json')), journal);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'data-upgrade.json'), 'utf8')),
    { version: 1, appVersion: '0.1.1' });
});

test('backup failure leaves both original files and the old marker untouched', async t => {
  const { dir, inventory, journal } = await fixture(t);
  const marker = JSON.stringify({ version: 1, appVersion: '0.1.0' });
  await writeFile(path.join(dir, 'data-upgrade.json'), marker);
  await writeFile(path.join(dir, 'upgrade-backups'), 'obstructed');
  await assert.rejects(prepare({ dataDir: dir, appVersion: '0.1.1' }),
    error => error.code === 'UPGRADE_BACKUP_FAILED' && !error.message.includes(dir));
  assert.deepEqual(await readFile(path.join(dir, 'course-inventory.json')), inventory);
  assert.deepEqual(await readFile(path.join(dir, 'run-journal.json')), journal);
  assert.equal(await readFile(path.join(dir, 'data-upgrade.json'), 'utf8'), marker);
});

test('a malformed marker is not silently reset or used as a backup path', async t => {
  const { dir, inventory } = await fixture(t);
  await writeFile(path.join(dir, 'data-upgrade.json'), '{bad-json');
  await assert.rejects(prepare({ dataDir: dir, appVersion: '0.1.1' }),
    error => error.code === 'UPGRADE_BACKUP_FAILED');
  assert.equal(await readFile(path.join(dir, 'data-upgrade.json'), 'utf8'), '{bad-json');
  assert.deepEqual(await readFile(path.join(dir, 'course-inventory.json')), inventory);
});

test('a non-string marker version is rejected instead of being coerced and rewritten', async t => {
  const { dir, inventory } = await fixture(t);
  const marker = JSON.stringify({ version: 1, appVersion: ['0.1.1'] });
  await writeFile(path.join(dir, 'data-upgrade.json'), marker);
  await assert.rejects(prepare({ dataDir: dir, appVersion: '0.1.1' }),
    error => error.code === 'UPGRADE_BACKUP_FAILED');
  assert.equal(await readFile(path.join(dir, 'data-upgrade.json'), 'utf8'), marker);
  assert.deepEqual(await readFile(path.join(dir, 'course-inventory.json')), inventory);
});

test('the requested app version must be a string, not a coercible array', async t => {
  const { dir, inventory } = await fixture(t);
  await assert.rejects(prepare({ dataDir: dir, appVersion: ['0.1.1'] }),
    error => error.code === 'UPGRADE_BACKUP_FAILED');
  assert.deepEqual(await readFile(path.join(dir, 'course-inventory.json')), inventory);
  await assert.rejects(readFile(path.join(dir, 'data-upgrade.json')), { code: 'ENOENT' });
});

test('retry accepts byte-identical backup files left before the marker was written', async t => {
  const { dir } = await fixture(t);
  const first = await prepare({ dataDir: dir, appVersion: '0.1.1' });
  const backupDir = first.backupDir;
  await rm(path.join(dir, 'data-upgrade.json'));
  assert.deepEqual(await prepare({ dataDir: dir, appVersion: '0.1.1' }),
    { backedUp: true, backupDir });
  assert.deepEqual((await readdir(backupDir)).sort(), ['course-inventory.json', 'run-journal.json']);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'data-upgrade.json'), 'utf8')),
    { version: 1, appVersion: '0.1.1' });
});

test('conflicting existing backup blocks startup without replacing either copy', async t => {
  const { dir, inventory } = await fixture(t);
  const first = await prepare({ dataDir: dir, appVersion: '0.1.1' });
  const backupDir = first.backupDir;
  await rm(path.join(dir, 'data-upgrade.json'));
  const conflicting = Buffer.from('different previous data');
  const backupFile = path.join(backupDir, 'course-inventory.json');
  await writeFile(backupFile, conflicting);
  await assert.rejects(prepare({ dataDir: dir, appVersion: '0.1.1' }),
    error => error.code === 'UPGRADE_BACKUP_FAILED');
  assert.deepEqual(await readFile(backupFile), conflicting);
  assert.deepEqual(await readFile(path.join(dir, 'course-inventory.json')), inventory);
  await assert.rejects(readFile(path.join(dir, 'data-upgrade.json')), { code: 'ENOENT' });
});

test('a repeated upgrade direction with changed progress keeps both snapshots', async t => {
  const { dir, inventory } = await fixture(t);
  await writeFile(path.join(dir, 'data-upgrade.json'), JSON.stringify({ version: 1, appVersion: '0.1.0' }));
  const first = await prepare({ dataDir: dir, appVersion: '0.1.1' });
  const updated = Buffer.from('{"items":[{"progress":73}]}');
  await writeFile(path.join(dir, 'course-inventory.json'), updated);
  await writeFile(path.join(dir, 'data-upgrade.json'), JSON.stringify({ version: 1, appVersion: '0.1.0' }));
  const second = await prepare({ dataDir: dir, appVersion: '0.1.1' });
  assert.notEqual(second.backupDir, first.backupDir);
  assert.match(path.basename(second.backupDir), /^0\.1\.0-to-0\.1\.1--[a-f0-9]{64}$/);
  assert.deepEqual(await readFile(path.join(first.backupDir, 'course-inventory.json')), inventory);
  assert.deepEqual(await readFile(path.join(second.backupDir, 'course-inventory.json')), updated);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'data-upgrade.json'), 'utf8')),
    { version: 1, appVersion: '0.1.1' });
});
