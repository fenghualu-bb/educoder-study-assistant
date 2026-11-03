import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const browsers = path.join(root, 'vendor', 'ms-playwright');
const require = createRequire(import.meta.url);
const cli = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'cli.js');
await mkdir(browsers, { recursive: true });

const child = spawn(process.execPath, [cli, 'install', 'chromium', '--no-shell'], {
  cwd: root,
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers },
  stdio: 'inherit',
});
const code = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', resolve);
});
if (code !== 0) throw new Error(`浏览器资源安装失败（退出码 ${code}）`);
