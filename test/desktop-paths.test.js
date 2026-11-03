import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDesktopPaths } from '../src/desktop-paths.js';

test('packaged desktop keeps user data outside read-only application resources', () => {
  assert.deepEqual(resolveDesktopPaths({
    userData: 'C:\\Users\\student\\AppData\\Roaming\\Study',
    sessionData: 'C:\\Users\\student\\AppData\\Local\\Study',
    resourcesPath: 'C:\\Program Files\\Study\\resources',
    packaged: true,
  }), {
    dataDir: 'C:\\Users\\student\\AppData\\Roaming\\Study',
    profileDir: 'C:\\Users\\student\\AppData\\Local\\Study\\browser-profile',
    browserRoot: 'C:\\Program Files\\Study\\resources\\ms-playwright',
  });
});

test('development desktop uses its own browser resources without importing project data', () => {
  const paths = resolveDesktopPaths({
    userData: 'C:\\Users\\student\\AppData\\Roaming\\Study',
    sessionData: 'C:\\Users\\student\\AppData\\Local\\Study',
    resourcesPath: 'C:\\Electron\\resources',
    projectRoot: 'C:\\project',
    packaged: false,
  });
  assert.equal(paths.browserRoot, 'C:\\project\\vendor\\ms-playwright');
  assert.equal(paths.dataDir.includes('project'), false);
});
