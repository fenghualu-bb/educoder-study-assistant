import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const dataFiles = ['course-inventory.json', 'run-journal.json'];
const versionPattern = /^\d+\.\d+\.\d+$/;

async function readPreviousVersion(markerFile) {
  let bytes;
  try { bytes = await readFile(markerFile, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const marker = JSON.parse(bytes);
  if (!marker || marker.version !== 1 || typeof marker.appVersion !== 'string'
    || !versionPattern.test(marker.appVersion)
    || Object.keys(marker).sort().join(',') !== 'appVersion,version') {
    throw new Error('升级标记损坏');
  }
  return marker.appVersion;
}

async function readOptional(file) {
  try { return await readFile(file); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function saveExactBackup(file, bytes) {
  const previous = await readOptional(file);
  if (previous) {
    if (!previous.equals(bytes)) throw new Error('已有升级备份与原记录不一致');
    return;
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    try { await link(temporary, file); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const stored = await readFile(file);
    if (!stored.equals(bytes)) throw new Error('升级备份校验失败');
  } finally {
    await rm(temporary, { force: true });
  }
}

async function saveMarkerAtomically(file, appVersion) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, appVersion }), { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

function snapshotDigest(files) {
  const hash = createHash('sha256');
  for (const { name, bytes } of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(nameBytes.length));
    hash.update(length).update(nameBytes).update(Buffer.from([bytes === null ? 0 : 1]));
    if (bytes !== null) {
      length.writeBigUInt64BE(BigInt(bytes.length));
      hash.update(length).update(bytes);
    }
  }
  return hash.digest('hex');
}

export async function prepareDataUpgrade({ dataDir, appVersion }) {
  try {
    if (!dataDir || typeof dataDir !== 'string' || typeof appVersion !== 'string'
      || !versionPattern.test(appVersion)) {
      throw new Error('升级路径或版本无效');
    }
    const markerFile = path.join(dataDir, 'data-upgrade.json');
    const previousVersion = await readPreviousVersion(markerFile);
    if (previousVersion === appVersion) return { backedUp: false, backupDir: null };

    const files = [];
    for (const name of dataFiles) {
      const bytes = await readOptional(path.join(dataDir, name));
      files.push({ name, bytes });
    }
    const existing = files.filter(({ bytes }) => bytes !== null);
    const backupDir = existing.length
      ? path.join(dataDir, 'upgrade-backups',
        `${previousVersion ?? 'legacy'}-to-${appVersion}--${snapshotDigest(files)}`) : null;
    if (backupDir) {
      await mkdir(backupDir, { recursive: true });
      for (const { name, bytes } of existing) await saveExactBackup(path.join(backupDir, name), bytes);
    }
    await mkdir(dataDir, { recursive: true });
    await saveMarkerAtomically(markerFile, appVersion);
    return { backedUp: Boolean(backupDir), backupDir };
  } catch (error) {
    throw Object.assign(new Error('升级备份失败；原有课程进度未改动，请检查磁盘空间后重试', { cause: error }),
      { code: 'UPGRADE_BACKUP_FAILED' });
  }
}
