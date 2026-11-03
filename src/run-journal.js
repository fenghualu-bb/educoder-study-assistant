import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RUN_ERROR_CODES } from './run-error.js';

const rootFields = ['version', 'runId', 'courseUrl', 'mode', 'limits', 'phase', 'layout', 'events', 'updatedAt'];
const eventTypes = ['selected', 'trial-intent', 'trial-denied', 'trial-reserved', 'trial-media-ended', 'trial-reported',
  'media-ended', 'verified', 'failed', 'stopped', 'paid-lease-intent', 'paid-lease-acquired', 'paid-lease-released', 'paid-lease-absent'];

function object(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('运行记录损坏');
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) throw new Error(`unexpected field: ${key}`);
  }
}

function position(value) {
  return Number.isInteger(value.page) && value.page > 0
    && Number.isInteger(value.index) && value.index >= 0
    && typeof value.title === 'string' && value.title.length > 0;
}

export function validateRunJournal(value) {
  object(value, rootFields);
  let validCourseUrl = false;
  try {
    const url = new URL(value.courseUrl);
    validCourseUrl = url.origin === 'https://www.educoder.net'
      && /^\/classrooms\/[A-Za-z0-9_-]+\/video$/.test(url.pathname)
      && !url.search && !url.hash;
  } catch { /* Reject below. */ }
  if (value.version !== 1 || !value.runId || typeof value.runId !== 'string'
    || !validCourseUrl
    || !['trial', 'full', 'paid'].includes(value.mode)
    || !['running', 'interrupted', 'stopped', 'failed', 'complete'].includes(value.phase)
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error('运行记录损坏');
  }
  object(value.limits, ['maxVideos', 'maxPages', 'startPage']);
  for (const key of ['maxVideos', 'maxPages']) {
    const limit = value.limits[key];
    if (limit !== null && (!Number.isInteger(limit) || limit < 1)) throw new Error('运行记录损坏');
  }
  if (value.limits.startPage !== undefined
    && (!Number.isInteger(value.limits.startPage) || value.limits.startPage < 1
      || value.limits.startPage > 1_000)) throw new Error('运行记录损坏');
  if (!Array.isArray(value.layout) || !Array.isArray(value.events)) throw new Error('运行记录损坏');
  for (const item of value.layout) {
    object(item, ['page', 'index', 'title']);
    if (!position(item)) throw new Error('运行记录损坏');
  }
  for (const event of value.events) {
    object(event, ['type', 'at', 'page', 'index', 'title', 'code', 'reservationId', 'itemKey',
      'reportId', 'status', 'mediaEnded', 'platformProgress', 'accountFingerprint', 'initialProgress', 'leaseId']);
    if (!eventTypes.includes(event.type) || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))
      || (event.code !== undefined && !RUN_ERROR_CODES.includes(event.code))) throw new Error('运行记录损坏');
    const hasPosition = ['page', 'index', 'title'].some(key => event[key] !== undefined);
    const paidEvent = event.type.startsWith('paid-lease-');
    if ((!paidEvent && event.leaseId !== undefined) || (value.mode === 'paid' && event.type.startsWith('trial-'))) {
      throw new Error('运行记录损坏');
    }
    if (paidEvent) {
      if (value.mode !== 'paid') throw new Error('运行记录损坏');
      const fields = ['type', 'at', ...(event.type === 'paid-lease-released' ? ['leaseId', 'status']
        : event.type === 'paid-lease-acquired' ? ['leaseId', 'accountFingerprint'] : ['accountFingerprint'])];
      object(event, fields);
      if (event.type !== 'paid-lease-released'
        && (typeof event.accountFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(event.accountFingerprint))) {
        throw new Error('运行记录损坏');
      }
      if (!['paid-lease-intent', 'paid-lease-absent'].includes(event.type)
        && (typeof event.leaseId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(event.leaseId))) throw new Error('运行记录损坏');
      if (event.type === 'paid-lease-released' && !['released', 'expired', 'revoked'].includes(event.status)) {
        throw new Error('运行记录损坏');
      }
    } else if (event.type === 'trial-intent') {
      if (typeof event.itemKey !== 'string' || !event.itemKey || event.itemKey.length > 2_048
        || typeof event.accountFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(event.accountFingerprint)
        || !Number.isInteger(event.initialProgress) || event.initialProgress < 0 || event.initialProgress >= 100
        || event.reservationId !== undefined || event.reportId !== undefined || event.status !== undefined
        || event.mediaEnded !== undefined || event.platformProgress !== undefined) {
        throw new Error('运行记录损坏');
      }
    } else if (event.type === 'trial-denied') {
      if (typeof event.itemKey !== 'string' || !event.itemKey || event.itemKey.length > 2_048
        || event.accountFingerprint !== undefined || event.initialProgress !== undefined
        || event.reservationId !== undefined || event.reportId !== undefined || event.status !== undefined
        || event.mediaEnded !== undefined || event.platformProgress !== undefined) {
        throw new Error('运行记录损坏');
      }
    } else if (['trial-reserved', 'trial-media-ended'].includes(event.type)) {
      if (typeof event.reservationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(event.reservationId)
        || typeof event.itemKey !== 'string' || !event.itemKey || event.itemKey.length > 2_048
        || (event.accountFingerprint !== undefined && !/^[0-9a-f]{64}$/.test(event.accountFingerprint))
        || event.initialProgress !== undefined
        || event.reportId !== undefined || event.status !== undefined
        || event.mediaEnded !== undefined || event.platformProgress !== undefined) {
        throw new Error('运行记录损坏');
      }
    } else if (event.type === 'trial-reported') {
      if (typeof event.reservationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(event.reservationId)
        || typeof event.itemKey !== 'string' || !event.itemKey || event.itemKey.length > 2_048
        || typeof event.reportId !== 'string' || !/^[A-Za-z0-9_:-]{1,256}$/.test(event.reportId)
        || event.accountFingerprint !== undefined || event.initialProgress !== undefined
        || !['available', 'pending', 'consumed'].includes(event.status)
        || typeof event.mediaEnded !== 'boolean'
        || (event.platformProgress !== null && (!Number.isInteger(event.platformProgress)
          || event.platformProgress < 0 || event.platformProgress > 100))) {
        throw new Error('运行记录损坏');
      }
    } else if (event.reservationId !== undefined || event.itemKey !== undefined
      || event.reportId !== undefined || event.status !== undefined
      || event.mediaEnded !== undefined || event.platformProgress !== undefined
      || event.accountFingerprint !== undefined || event.initialProgress !== undefined) {
      throw new Error('运行记录损坏');
    }
    if (['selected', 'trial-intent', 'trial-denied', 'trial-reserved', 'trial-media-ended', 'trial-reported', 'media-ended', 'verified']
      .includes(event.type) || hasPosition) {
      if (!position(event)) throw new Error('运行记录损坏');
    }
  }
  return value;
}

export async function saveRunJournal(file, value) {
  validateRunJournal(value);
  await mkdir(path.dirname(file), { recursive: true });
  let previousBytes;
  try { previousBytes = await readFile(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previousBytes) {
    const previous = validateRunJournal(JSON.parse(previousBytes.toString('utf8')));
    if (previous.runId !== value.runId) {
      const archiveDir = path.join(path.dirname(file), 'run-archive');
      const archiveName = `${createHash('sha256').update(previousBytes).digest('hex')}.json`;
      const archiveFile = path.join(archiveDir, archiveName);
      await mkdir(archiveDir, { recursive: true });
      try { await writeFile(archiveFile, previousBytes, { flag: 'wx' }); }
      catch (error) {
        if (error.code !== 'EEXIST' || !(await readFile(archiveFile)).equals(previousBytes)) throw error;
      }
    }
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function loadRunJournal(file) {
  try {
    return validateRunJournal(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('运行记录损坏', { cause: error });
  }
}
