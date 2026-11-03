import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadRunJournal, saveRunJournal } from '../src/run-journal.js';

const record = {
  version: 1,
  runId: 'r1',
  courseUrl: 'https://www.educoder.net/classrooms/abc/video',
  mode: 'trial',
  limits: { maxVideos: 1, maxPages: 1 },
  phase: 'running',
  layout: [{ page: 1, index: 0, title: '集合' }],
  events: [],
  updatedAt: '2026-09-23T00:00:00.000Z',
};

test('paid absent-lease recovery is durable and cannot carry credentials or appear in a free trial', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'educoder-journal-paid-'));
  const file = path.join(dir, 'run.json');
  const event = { type: 'paid-lease-absent', accountFingerprint: 'a'.repeat(64), at: record.updatedAt };
  try {
    const paid = { ...record, mode: 'paid', events: [event] };
    await saveRunJournal(file, paid);
    assert.deepEqual(await loadRunJournal(file), paid);
    await assert.rejects(saveRunJournal(file, { ...paid, mode: 'trial' }), /运行记录损坏/);
    await assert.rejects(saveRunJournal(file, { ...paid, events: [{ ...event, token: 'synthetic-secret' }] }), /unexpected field: token/);
    await assert.rejects(saveRunJournal(file, { ...paid, events: [{ ...event, leaseId: 'invented' }] }), /unexpected field: leaseId/);
    assert.deepEqual(await loadRunJournal(file), paid);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an invalid or credential-bearing journal cannot replace the last saved record', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'educoder-journal-'));
  const file = path.join(dir, 'run.json');
  try {
    await saveRunJournal(file, record);
    assert.deepEqual(await loadRunJournal(file), record);
    await assert.rejects(saveRunJournal(file, { ...record, cookie: 'secret' }), /unexpected field: cookie/);
    await assert.rejects(saveRunJournal(file, { ...record, events: [{ type: 'failed', at: record.updatedAt, token: 'secret' }] }), /unexpected field: token/);
    await assert.rejects(saveRunJournal(file, { ...record, limits: { ...record.limits, password: 'secret' } }), /unexpected field: password/);
    await assert.rejects(saveRunJournal(file, { ...record, layout: [{ ...record.layout[0], token: 'secret' }] }), /unexpected field: token/);
    await assert.rejects(saveRunJournal(file, { ...record, courseUrl: `${record.courseUrl}?password=secret` }), /运行记录损坏/);
    await assert.rejects(saveRunJournal(file, { ...record, events: [{ type: 'failed', at: record.updatedAt, code: 'secret' }] }), /运行记录损坏/);
    assert.deepEqual(await loadRunJournal(file), record);
    assert.equal((await readFile(file, 'utf8')).includes('secret'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('corrupt JSON or invalid schema is reported, never treated as an empty run', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'educoder-journal-'));
  const file = path.join(dir, 'run.json');
  try {
    assert.equal(await loadRunJournal(file), null);
    await writeFile(file, '{bad json', 'utf8');
    await assert.rejects(loadRunJournal(file), /运行记录损坏/);
    await writeFile(file, JSON.stringify({ ...record, phase: 'unknown' }), 'utf8');
    await assert.rejects(loadRunJournal(file), /运行记录损坏/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('later-page trial journals preserve a validated start page without breaking old journals', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'educoder-journal-page-'));
  const file = path.join(dir, 'run.json');
  try {
    await saveRunJournal(file, record);
    assert.deepEqual((await loadRunJournal(file)).limits, { maxVideos: 1, maxPages: 1 });
    const later = { ...record, limits: { maxVideos: 3, maxPages: 2, startPage: 2 } };
    await saveRunJournal(file, later);
    assert.deepEqual((await loadRunJournal(file)).limits, later.limits);
    await assert.rejects(saveRunJournal(file, { ...later, limits: { ...later.limits, startPage: 0 } }), /运行记录损坏/);
    await assert.rejects(saveRunJournal(file, { ...later, limits: { ...later.limits, startPage: '2' } }), /运行记录损坏/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('product trial reservation is durably recorded without allowing account credentials', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'educoder-journal-'));
  const file = path.join(dir, 'run.json');
  const event = { type: 'trial-reserved', page: 1, index: 0, title: '集合',
    reservationId: 'trial-reservation-1', itemKey: '[1,0,"集合"]',
    accountFingerprint: 'a'.repeat(64), at: record.updatedAt };
  try {
    const trial = { ...record, events: [event] };
    await saveRunJournal(file, trial);
    assert.deepEqual(await loadRunJournal(file), trial);
    await assert.rejects(saveRunJournal(file, { ...trial, events: [{ ...event, token: 'secret' }] }),
      /unexpected field: token/);
    await assert.rejects(saveRunJournal(file, { ...trial, events: [{ ...event, reservationId: '' }] }),
      /运行记录损坏/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('product trial intent is saved before the server reservation response arrives', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'educoder-journal-'));
  const file = path.join(dir, 'run.json');
  const event = { type: 'trial-intent', page: 1, index: 0, title: '集合',
    itemKey: '[1,0,"集合"]', initialProgress: 0,
    accountFingerprint: 'a'.repeat(64), at: record.updatedAt };
  try {
    const trial = { ...record, events: [event] };
    await saveRunJournal(file, trial);
    assert.deepEqual(await loadRunJournal(file), trial);
    await assert.rejects(saveRunJournal(file, { ...trial, events: [{ ...event, initialProgress: 100 }] }),
      /运行记录损坏/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a definite server denial can close the intent without storing a reservation', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'educoder-journal-'));
  const file = path.join(dir, 'run.json');
  const position = { page: 1, index: 0, title: '集合', itemKey: '[1,0,"集合"]', at: record.updatedAt };
  const trial = { ...record, events: [
    { type: 'trial-intent', ...position, initialProgress: 0, accountFingerprint: 'a'.repeat(64) },
    { type: 'trial-denied', ...position },
  ] };
  try {
    await saveRunJournal(file, trial);
    assert.deepEqual(await loadRunJournal(file), trial);
    await assert.rejects(saveRunJournal(file, { ...trial, events: [trial.events[0],
      { ...trial.events[1], reservationId: 'forbidden' }] }), /运行记录损坏/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('product trial report outcome survives restart without storing product credentials', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'educoder-journal-'));
  const file = path.join(dir, 'run.json');
  const reservation = { type: 'trial-reserved', page: 1, index: 0, title: '集合',
    reservationId: 'trial-reservation-1', itemKey: '[1,0,"集合"]', at: record.updatedAt };
  const report = { type: 'trial-reported', page: 1, index: 0, title: '集合',
    reservationId: 'trial-reservation-1', itemKey: '[1,0,"集合"]',
    reportId: 'trial-reservation-1:ended:100', status: 'consumed',
    mediaEnded: true, platformProgress: 100, at: record.updatedAt };
  try {
    const trial = { ...record, events: [reservation, report] };
    await saveRunJournal(file, trial);
    assert.deepEqual(await loadRunJournal(file), trial);
    await assert.rejects(saveRunJournal(file, { ...trial, events: [reservation,
      { ...report, token: 'secret' }] }), /unexpected field: token/);
    await assert.rejects(saveRunJournal(file, { ...trial, events: [reservation,
      { ...report, platformProgress: 101 }] }), /运行记录损坏/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('product media-end marker survives restart before the runner verification event', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'educoder-journal-'));
  const file = path.join(dir, 'run.json');
  const event = { type: 'trial-media-ended', page: 1, index: 0, title: '集合',
    reservationId: 'trial-reservation-1', itemKey: '[1,0,"集合"]', at: record.updatedAt };
  try {
    const trial = { ...record, events: [event] };
    await saveRunJournal(file, trial);
    assert.deepEqual(await loadRunJournal(file), trial);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('starting a different run archives the previous journal once before replacing it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'educoder-journal-'));
  const file = path.join(dir, 'run.json');
  const previous = { ...record, phase: 'complete', events: [
    { type: 'verified', page: 1, index: 0, title: '集合', at: record.updatedAt },
  ] };
  const next = { ...record, runId: 'r2', events: [], updatedAt: '2026-09-24T00:00:00.000Z' };
  try {
    await saveRunJournal(file, previous);
    const previousBytes = await readFile(file);
    await saveRunJournal(file, next);
    const archiveDir = path.join(dir, 'run-archive');
    const archivedNames = await readdir(archiveDir);
    assert.equal(archivedNames.length, 1);
    assert.deepEqual(await readFile(path.join(archiveDir, archivedNames[0])), previousBytes);
    assert.deepEqual(await loadRunJournal(file), next);
    await saveRunJournal(file, { ...next, phase: 'complete' });
    assert.equal((await readdir(archiveDir)).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an archive write failure preserves the previous run instead of overwriting it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'educoder-journal-'));
  const file = path.join(dir, 'run.json');
  try {
    await saveRunJournal(file, { ...record, phase: 'stopped' });
    const before = await readFile(file);
    await writeFile(path.join(dir, 'run-archive'), 'not a directory', 'utf8');
    await assert.rejects(saveRunJournal(file, { ...record, runId: 'r2' }));
    assert.deepEqual(await readFile(file), before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
