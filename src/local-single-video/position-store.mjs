import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { freshLedger, validateLedger } from './ledger.mjs';
import { normalizeTarget, sameTarget, targetKey } from './target.mjs';
export async function readLegacyPositionTarget(file) {
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    const target = normalizeTarget(value.target);
    validateLedger(value, target);
    return target;
  } catch (error) { throw new Error(error.code === 'ENOENT' ? 'LEGACY_RECORD_MISSING' : 'LEGACY_RECORD_INVALID'); }
}
const queues = new Map();
async function serialize(file, action) {
  const key = path.resolve(file).toLowerCase();
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(action); queues.set(key, next);
  try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
}
function invalid(reason) {
  return Object.assign(new Error('RECORD_INVALID'), { code: 'RECORD_INVALID', reason });
}
function validate(value, input) {
  try {
    const target = normalizeTarget(input), storedTarget = normalizeTarget(value?.target);
    const observedTarget = normalizeTarget(value?.observation?.target);
    if (value?.version !== 2 || targetKey(storedTarget) !== targetKey(target)
      || !Number.isSafeInteger(value.revision) || value.revision < 1) throw invalid('SCHEMA_INVALID');
    // Both stored targets must agree. A known thumbnail is never replaced by a scan.
    if (!sameTarget(storedTarget, observedTarget) || !sameTarget(observedTarget, storedTarget)
      || (target.cardIdentity && storedTarget.cardIdentity && target.cardIdentity !== storedTarget.cardIdentity))
      throw invalid('TARGET_IDENTITY_MISMATCH');
    // Validate the original evidence before supplementing missing thumbnail metadata.
    const observation = validateLedger(value.observation, storedTarget);
    const recordTarget = target.cardIdentity ? target : storedTarget;
    return { version: 2, target: recordTarget, revision: value.revision,
      observation: { ...observation, target: { ...recordTarget } }, playerIdentity: value.playerIdentity ?? null };
  } catch (error) {
    if (error.code === 'RECORD_INVALID') throw error;
    throw invalid('SCHEMA_INVALID');
  }
}
async function readRecord(file, target) {
  const bytes = await fs.readFile(file);
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw invalid('JSON_INVALID'); }
  return { bytes, value, record: validate(value, target) };
}
function needsIdentityBackup(value, record) {
  return Boolean(record.target.cardIdentity && !value.target.cardIdentity && !value.observation.target.cardIdentity);
}
async function backupIdentityRecord(file, bytes) {
  const digest = createHash('sha256').update(bytes).digest('hex');
  const backup = `${file}.before-card-identity-${digest}.bak`;
  try { await fs.writeFile(backup, bytes, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!(await fs.readFile(backup)).equals(bytes)) throw invalid('BACKUP_CHANGED');
  }
}
export class PositionStore {
  constructor({ directory, legacyFile }) {
    this.directory = directory; this.legacyFile = legacyFile; this.snapshots = new WeakMap();
  }
  remember({ bytes, value, record }) {
    this.snapshots.set(record, { bytes, needsIdentityBackup: needsIdentityBackup(value, record) });
    return record;
  }
  file(target) { return path.join(this.directory, `${targetKey(target)}.json`); }
  async load(input) {
    const target = normalizeTarget(input), file = this.file(target);
    return serialize(file, async () => {
      try { return this.remember(await readRecord(file, target)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      let observation = freshLedger(target);
      if (this.legacyFile) {
        try {
          const value = JSON.parse(await fs.readFile(this.legacyFile, 'utf8'));
          const legacyTarget = normalizeTarget(value.target);
          if (sameTarget(legacyTarget, target) && sameTarget(target, legacyTarget)) observation = validateLedger(value, target);
        } catch (error) {
          if (error.code !== 'ENOENT') {
            if (error.code && error.code !== 'RECORD_INVALID') throw error;
            throw Object.assign(new Error('LEGACY_RECORD_INVALID'), { code: 'LEGACY_RECORD_INVALID' });
          }
        }
      }
      const value = { version: 2, target, revision: 1, observation, playerIdentity: null };
      await fs.mkdir(this.directory, { recursive: true });
      const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
      try { await fs.writeFile(file, bytes, { flag: 'wx' }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        return this.remember(await readRecord(file, target));
      }
      return this.remember({ bytes, value, record: value });
    });
  }
  async recentForTargets(targets) {
    let recent = null;
    for (const input of targets) {
      const target = normalizeTarget(input), file = this.file(target);
      try {
        const { record } = await readRecord(file, target);
        if (record.observation.position < 1) continue;
        const updated = (await fs.stat(file)).mtimeMs;
        if (!recent || updated > recent.updated) recent = { target, seconds: Math.floor(record.observation.position), updated };
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return recent;
  }
  async save(record, observation, identity) {
    const target = normalizeTarget(record.target), file = this.file(target);
    return serialize(file, async () => {
      const loaded = await readRecord(file, target), current = loaded.record;
      const snapshot = this.snapshots.get(record);
      if (current.revision !== record.revision) throw new Error('RECORD_CHANGED');
      if (snapshot && !loaded.bytes.equals(snapshot.bytes)) throw new Error('RECORD_CHANGED');
      if (!Number.isSafeInteger(current.revision + 1)) throw invalid('REVISION_EXHAUSTED');
      const next = { ...current, revision: current.revision + 1,
        observation: validateLedger(observation, target), playerIdentity: identity ?? null };
      const temporary = `${file}.${randomUUID()}.tmp`;
      const bytes = Buffer.from(JSON.stringify(next, null, 2) + '\n');
      try {
        if (snapshot?.needsIdentityBackup || needsIdentityBackup(loaded.value, current))
          await backupIdentityRecord(file, loaded.bytes);
        await fs.writeFile(temporary, bytes, { flag: 'wx' });
        // Preserve edits even when another writer forgets to advance the revision.
        const latest = await readRecord(file, target);
        if (latest.record.revision !== record.revision || !latest.bytes.equals(loaded.bytes)) throw new Error('RECORD_CHANGED');
        await fs.rename(temporary, file);
      } finally { await fs.rm(temporary, { force: true }); }
      Object.assign(record, next);
      this.snapshots.set(record, { bytes, needsIdentityBackup: false });
      return record;
    });
  }
}
