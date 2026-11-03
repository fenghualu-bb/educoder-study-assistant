import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PositionStore } from '../src/local-single-video/position-store.mjs';

const targetWithoutIdentity = Object.freeze({ classroomId: 'AnonymousRecordCompat', title: '匿名观测记录', page: 2, index: 1 });
const cardIdentity = 'https://www.educoder.net/record-compat/expected-card';
const otherIdentity = 'https://www.educoder.net/record-compat/other-card';
const selectedTarget = Object.freeze({ ...targetWithoutIdentity, cardIdentity });

function recordFor({ outerTarget = targetWithoutIdentity, innerTarget = outerTarget, revision = 7,
  watchedPrefix = 431.456789, position = watchedPrefix, duration = 654.32, watchedRanges } = {}) {
  return { version: 2, target: { ...outerTarget }, revision,
    observation: { version: 1, target: { ...innerTarget }, watchedPrefix, position, duration,
      ...(watchedRanges === undefined ? {} : { watchedRanges: structuredClone(watchedRanges) }) },
    playerIdentity: null };
}

async function fixture(t, original) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'educoder-record-compat-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('educoder-record-compat-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const store = new PositionStore({ directory });
  const file = store.file(selectedTarget);
  // Deliberately retain CRLF and four-space formatting so byte preservation is tested.
  const bytes = Buffer.from(JSON.stringify(original, null, 4) + '\r\n', 'utf8');
  await fs.writeFile(file, bytes, { flag: 'wx' });
  return { directory, store, file, bytes };
}

async function backupNames(f) {
  return (await fs.readdir(f.directory)).filter(name => name.startsWith(path.basename(f.file) + '.before-card-identity-')).sort();
}

function assertObservationUnchanged(actual, original, expectedTarget) {
  assert.deepEqual(actual, { ...original, target: { ...expectedTarget } });
}

test('loading a historical position without card identity adds only in-memory metadata and preserves fractional ranges', async t => {
  const original = recordFor({ watchedRanges: [[0, 431.456789], [600.125, 610.5]] });
  const f = await fixture(t, original);
  const loaded = await f.store.load(selectedTarget);
  assert.deepEqual(loaded.target, selectedTarget);
  assert.equal(loaded.revision, original.revision);
  assertObservationUnchanged(loaded.observation, original.observation, selectedTarget);
  assert.equal(loaded.playerIdentity, null);
  assert.deepEqual(await fs.readFile(f.file), f.bytes);
  assert.deepEqual(await backupNames(f), []);
  const recent = await f.store.recentForTargets([selectedTarget]);
  assert.deepEqual(recent.target, selectedTarget);
  assert.equal(recent.seconds, 431);
  assert.deepEqual(await fs.readFile(f.file), f.bytes);
});

test('a completed historical observation retains the exact anonymous 802.345678 value without adding ranges', async t => {
  const original = recordFor({ watchedPrefix: 802.345678, position: 802.345678, duration: 802.345678 });
  const f = await fixture(t, original);
  const loaded = await f.store.load(selectedTarget);
  assertObservationUnchanged(loaded.observation, original.observation, selectedTarget);
  assert.equal(Object.hasOwn(loaded.observation, 'watchedRanges'), false);
  assert.deepEqual(await fs.readFile(f.file), f.bytes);
});

test('identity compatibility preserves a sparse observation without extending its watched prefix or filling gaps', async t => {
  const original = recordFor({ watchedPrefix: 431.456789, position: 802.345678, duration: 900,
    watchedRanges: [[0, 431.456789], [800.125, 802.345678]] });
  const f = await fixture(t, original);
  const loaded = await f.store.load(selectedTarget);
  assertObservationUnchanged(loaded.observation, original.observation, selectedTarget);
  assert.equal(loaded.observation.watchedPrefix, 431.456789);
  assert.deepEqual(await fs.readFile(f.file), f.bytes);
});

test('the first actual compatible save backs up exact original bytes and increments revision only for each save', async t => {
  const original = recordFor({ watchedRanges: [[0, 431.456789], [600.125, 610.5]] });
  const f = await fixture(t, original);
  const loaded = await f.store.load(selectedTarget);
  const nextObservation = { ...loaded.observation, position: 432.456789, watchedPrefix: 432.456789,
    watchedRanges: [[0, 432.456789], [600.125, 610.5]] };
  const playerIdentity = { pathname: '/video_info', identifiers: { video_id: 'anonymous-record-compat' } };
  await f.store.save(loaded, nextObservation, playerIdentity);
  const expectedName = path.basename(f.file) + '.before-card-identity-' + createHash('sha256').update(f.bytes).digest('hex') + '.bak';
  assert.deepEqual(await backupNames(f), [expectedName]);
  assert.deepEqual(await fs.readFile(path.join(f.directory, expectedName)), f.bytes);
  const saved = JSON.parse(await fs.readFile(f.file, 'utf8'));
  assert.equal(saved.revision, original.revision + 1);
  assert.equal(loaded.revision, saved.revision);
  assert.deepEqual(saved.target, selectedTarget);
  assert.deepEqual(saved.observation, nextObservation);
  assert.deepEqual(saved.playerIdentity, playerIdentity);

  const secondObservation = { ...nextObservation, position: 431.456789 };
  await f.store.save(loaded, secondObservation, playerIdentity);
  const savedAgain = JSON.parse(await fs.readFile(f.file, 'utf8'));
  assert.equal(savedAgain.revision, original.revision + 2);
  assert.deepEqual(savedAgain.observation, secondObservation);
  assert.deepEqual(await backupNames(f), [expectedName]);
  assert.deepEqual(await fs.readFile(path.join(f.directory, expectedName)), f.bytes);
});

test('a scan without card identity retains the historical identity in both loaded and saved targets', async t => {
  const original = recordFor({ outerTarget: selectedTarget });
  const f = await fixture(t, original);
  const loaded = await f.store.load(targetWithoutIdentity);
  assert.deepEqual(loaded.target, selectedTarget);
  assertObservationUnchanged(loaded.observation, original.observation, selectedTarget);
  assert.deepEqual(await fs.readFile(f.file), f.bytes);
  await f.store.save(loaded, loaded.observation, null);
  const saved = JSON.parse(await fs.readFile(f.file, 'utf8'));
  assert.deepEqual(saved.target, selectedTarget);
  assert.deepEqual(saved.observation.target, selectedTarget);
  assert.equal(saved.revision, original.revision + 1);
});

test('an ordinary valid identified record retains its observation and follows normal save revision behavior', async t => {
  const original = recordFor({ outerTarget: selectedTarget, revision: 3, watchedRanges: [[0, 431.456789]] });
  const f = await fixture(t, original);
  const loaded = await f.store.load(selectedTarget);
  assert.deepEqual(loaded, original);
  assert.deepEqual(await fs.readFile(f.file), f.bytes);
  const observation = { ...loaded.observation, position: 400.125 };
  await f.store.save(loaded, observation, null);
  const saved = await f.store.load(selectedTarget);
  assert.equal(saved.revision, 4);
  assert.deepEqual(saved.observation, observation);
});

test('saving a compatible record at MAX_SAFE_INTEGER rejects before writing a backup or replacing original bytes', async t => {
  const original = recordFor({ revision: Number.MAX_SAFE_INTEGER });
  const f = await fixture(t, original);
  const loaded = await f.store.load(selectedTarget);
  const beforeNames = (await fs.readdir(f.directory)).sort();
  await assert.rejects(f.store.save(loaded, { ...loaded.observation, position: 400.25 }, null),
    error => error.message === 'RECORD_INVALID');
  assert.deepEqual(await fs.readFile(f.file), f.bytes);
  assert.equal(loaded.revision, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(await backupNames(f), []);
  assert.deepEqual((await fs.readdir(f.directory)).sort(), beforeNames);
});

for (const [name, outerTarget, innerTarget] of [
  ['both stored identities differ', { ...targetWithoutIdentity, cardIdentity: otherIdentity }, { ...targetWithoutIdentity, cardIdentity: otherIdentity }],
  ['outer identity differs', { ...targetWithoutIdentity, cardIdentity: otherIdentity }, selectedTarget],
  ['inner identity differs', selectedTarget, { ...targetWithoutIdentity, cardIdentity: otherIdentity }],
  ['only outer identity is present', selectedTarget, targetWithoutIdentity],
  ['only inner identity is present', targetWithoutIdentity, selectedTarget],
]) {
  test(`identity compatibility rejects ${name} and preserves the original file`, async t => {
    const f = await fixture(t, recordFor({ outerTarget, innerTarget }));
    await assert.rejects(f.store.load(selectedTarget), error => error.message === 'RECORD_INVALID');
    assert.deepEqual(await fs.readFile(f.file), f.bytes);
    assert.deepEqual(await backupNames(f), []);
  });
}

for (const [name, original] of [
  ['an unobserved position outside the prefix', recordFor({ position: 500 })],
  ['an inner target belonging to another video', recordFor({ innerTarget: { ...targetWithoutIdentity, index: 2 } })],
]) {
  test(`a record lacking both identities still rejects ${name}`, async t => {
    const f = await fixture(t, original);
    await assert.rejects(f.store.load(selectedTarget), error => error.message === 'RECORD_INVALID');
    assert.deepEqual(await fs.readFile(f.file), f.bytes);
    assert.deepEqual(await backupNames(f), []);
  });
}

for (const [name, outerTarget, formatOnly] of [
  ['a compatible historical record with changed observation', targetWithoutIdentity, false],
  ['a compatible historical record with changed formatting', targetWithoutIdentity, true],
  ['an ordinary identified record with changed observation', selectedTarget, false],
]) {
  test(`same-revision byte protection preserves an external edit to ${name}`, async t => {
    const original = recordFor({ outerTarget });
    const f = await fixture(t, original);
    const loaded = await f.store.load(selectedTarget);
    const external = structuredClone(original);
    if (!formatOnly) external.observation.position = 400.25;
    const externalBytes = Buffer.from(JSON.stringify(external) + '\n');
    await fs.writeFile(f.file, externalBytes);
    await assert.rejects(f.store.save(loaded, loaded.observation, null), error => error.message === 'RECORD_CHANGED');
    assert.deepEqual(await fs.readFile(f.file), externalBytes);
    assert.equal(loaded.revision, original.revision);
  });
}

for (const method of ['load', 'recentForTargets']) {
  test(`${method} preserves a non-ENOENT read I/O error code instead of reporting schema corruption`, async t => {
    const f = await fixture(t, recordFor({ outerTarget: selectedTarget }));
    const readFile = fs.readFile.bind(fs);
    t.mock.method(fs, 'readFile', async (file, ...options) => {
      if (path.resolve(String(file)) === path.resolve(f.file)) {
        throw Object.assign(new Error('synthetic denied position read'), { code: 'EACCES' });
      }
      return readFile(file, ...options);
    });
    const operation = method === 'load' ? f.store.load(selectedTarget) : f.store.recentForTargets([selectedTarget]);
    await assert.rejects(operation, error => error.code === 'EACCES' && error.message !== 'RECORD_INVALID');
    assert.deepEqual(await readFile(f.file), f.bytes);
  });
}
