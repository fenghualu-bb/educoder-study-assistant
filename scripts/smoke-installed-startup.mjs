import assert from 'node:assert/strict';
import path from 'node:path';
import { _electron } from 'playwright-core';

const executablePath = process.argv[2];
if (!executablePath || !path.isAbsolute(executablePath)) throw new Error('INSTALLED_EXECUTABLE_PATH_REQUIRED');

const application = await _electron.launch({
  executablePath,
  cwd: path.dirname(executablePath),
  chromiumSandbox: true,
  timeout: 45_000,
});
try {
  const window = await application.firstWindow({ timeout: 30_000 });
  try {
    await window.waitForURL(url => url.protocol === 'http:' && url.hostname === '127.0.0.1', { timeout: 30_000 });
  } catch (error) {
    const current = window.url();
    throw new Error(`Installed window did not reach the workbench (${current.startsWith('file:') ? path.basename(new URL(current).pathname) : current})`, { cause: error });
  }
  const version = await window.locator('#app-version').innerText();
  assert.match(version, /^0\.2\.0\b/);
  assert.equal(await window.locator('#heatmap-grid').count(), 1);
  assert.equal(await window.locator('#open').isVisible(), true);
  console.log('Installed Windows app rendered the 0.2.0 workbench.');
} finally {
  await application.close();
}
