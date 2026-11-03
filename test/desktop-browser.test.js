import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserModeFromArgs, resolveDesktopBrowser } from '../src/desktop-browser.js';

const dataDir = 'C:\\Users\\student\\AppData\\Roaming\\Study';
const profileDir = 'C:\\Users\\student\\AppData\\Local\\Study\\browser-profile';
const bundledPath = 'C:\\Study\\resources\\ms-playwright\\chrome.exe';
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const env = { 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramFiles: 'C:\\Program Files' };

test('default desktop keeps the bundled browser and its existing profile', () => {
  assert.equal(browserModeFromArgs([]), 'bundled');
  assert.deepEqual(resolveDesktopBrowser({
    args: [], dataDir, profileDir, bundledPath, env, exists: value => value === bundledPath,
  }), { mode: 'bundled', browserPath: bundledPath, profileDir, dataDir });
});

test('internal Edge mode selects installed Edge and an independent profile', () => {
  assert.equal(browserModeFromArgs(['app.exe', '--study-browser=edge']), 'edge');
  assert.deepEqual(resolveDesktopBrowser({
    args: ['--study-browser=edge'], dataDir, profileDir, bundledPath, env,
    exists: value => value === bundledPath || value === edgePath,
  }), {
    mode: 'edge', browserPath: edgePath,
    profileDir: 'C:\\Users\\student\\AppData\\Local\\Study\\browser-profile-edge',
    dataDir: 'C:\\Users\\student\\AppData\\Roaming\\Study-edge',
  });
});

test('Edge-only package defaults to Edge on double click without a command-line flag', () => {
  const resourcesPath = 'C:\\Study\\resources';
  const marker = 'C:\\Study\\resources\\edge-only.marker';
  const exists = value => value === marker || value === edgePath;
  assert.equal(browserModeFromArgs(['C:\\Study\\app.exe'], { packageResourcesPath: resourcesPath, exists }), 'edge');
  assert.deepEqual(resolveDesktopBrowser({
    args: ['C:\\Study\\app.exe'], packageResourcesPath: resourcesPath,
    dataDir, profileDir, bundledPath, env, exists,
  }), {
    mode: 'edge', browserPath: edgePath,
    profileDir: 'C:\\Users\\student\\AppData\\Local\\Study\\browser-profile-edge',
    dataDir: 'C:\\Users\\student\\AppData\\Roaming\\Study-edge',
  });
});

test('missing Edge-only marker does not silently switch the default package to Edge', () => {
  assert.equal(browserModeFromArgs(['C:\\Study\\app.exe'], {
    packageResourcesPath: 'C:\\Study\\resources', exists: value => value === edgePath,
  }), 'bundled');
});

test('internal Edge mode fails explicitly when Edge is absent instead of using the bundle', () => {
  assert.throws(() => resolveDesktopBrowser({
    args: ['--study-browser=edge'], dataDir, profileDir, bundledPath, env,
    exists: value => value === bundledPath,
  }), error => error.code === 'EDGE_NOT_FOUND' && /Microsoft Edge/.test(error.message));
});

test('unknown browser choice fails closed', () => {
  assert.throws(() => resolveDesktopBrowser({
    args: ['--study-browser=unknown'], dataDir, profileDir, bundledPath, env,
    exists: () => true,
  }), /浏览器模式/);
});
