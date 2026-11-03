import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const forgeFile = require.resolve('../forge.config.cjs');

function forgeVariant(edgeOnly) {
  const key = 'EDUCODER_EDGE_ONLY_INTERNAL';
  const previous = process.env[key];
  try {
    if (edgeOnly) process.env[key] = '1';
    else delete process.env[key];
    delete require.cache[forgeFile];
    return require(forgeFile);
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
    delete require.cache[forgeFile];
  }
}

test('packaging excludes private course data and backup archives but keeps runtime code', () => {
  const forge = forgeVariant(false);
  const ignored = forge.packagerConfig.ignore;
  assert.equal(ignored(path.join(root, 'data', 'chrome-profile', 'Cookies')), true);
  assert.equal(ignored(path.join(root, 'data', 'course-inventory.json')), true);
  assert.equal(ignored('\\data\\chrome-profile\\Cookies'), true);
  assert.equal(ignored('\\data\\course-inventory.json'), true);
  assert.equal(ignored('\\backup-pre-one-video.zip'), true);
  assert.equal(ignored(path.join(root, 'backup-pre-one-video.zip')), true);
  assert.equal(ignored(path.join(root, 'vendor', 'ms-playwright', 'chromium-1243')), true);
  assert.equal(ignored(path.join(root, 'build-assets', 'edge-only.marker')), true);
  assert.equal(ignored(path.join(root, '.private-quarantine')), true);
  assert.equal(ignored('\\.private-quarantine'), true);
  assert.equal(ignored('\\README.md'), true);
  assert.equal(ignored(path.join(root, 'src', 'runtime.js')), false);
  assert.equal(ignored(path.join(root, 'public', 'index.html')), false);
  assert.equal(ignored(path.join(root, 'node_modules', 'playwright-core', 'data', 'example.json')), true);
  assert.equal(forge.packagerConfig.afterCopy.length, 1);
  assert.equal(forge.packagerConfig.tmpdir, path.resolve(root, '..', 'packager-tmp'));
  assert.deepEqual(forge.packagerConfig.extraResource, ['vendor/ms-playwright', 'src/local-single-video/local-single-video-native-control.ps1']);
});

test('Edge-only internal package has a separate output and never copies the bundled browser', () => {
  const forge = forgeVariant(true);
  assert.equal(forge.buildIdentifier, 'edge-internal');
  assert.deepEqual(forge.packagerConfig.extraResource, ['build-assets/edge-only.marker', 'src/local-single-video/local-single-video-native-control.ps1']);
  assert.equal(forge.packagerConfig.ignore('\\vendor\\ms-playwright\\chromium-1243'), true);
  assert.equal(forge.packagerConfig.ignore('\\out\\educoder-local-study-control-win32-x64'), true);
});

test('candidate output includes the app version to preserve previously delivered packages', () => {
  const key = 'EDUCODER_CANDIDATE_BUILD';
  const previous = process.env[key];
  try {
    process.env[key] = '1';
    const forge = forgeVariant(false);
    assert.equal(forge.buildIdentifier, `edge-candidate-${require('../package.json').version}`);
    assert.deepEqual(forge.packagerConfig.extraResource, ['build-assets/edge-only.marker', 'src/local-single-video/local-single-video-native-control.ps1']);
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});
