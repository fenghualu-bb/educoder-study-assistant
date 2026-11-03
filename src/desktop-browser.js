import { existsSync } from 'node:fs';
import path from 'node:path';

export function browserModeFromArgs(args = [], { packageResourcesPath, exists = existsSync } = {}) {
  const choices = args.filter(arg => arg.startsWith('--study-browser='));
  const defaultMode = packageResourcesPath
    && exists(path.win32.join(packageResourcesPath, 'edge-only.marker')) ? 'edge' : 'bundled';
  const mode = choices.length === 0 ? defaultMode : choices[0].slice('--study-browser='.length);
  if (choices.length > 1 || !['bundled', 'edge'].includes(mode)) {
    throw new Error('内部浏览器模式无效');
  }
  return mode;
}

export function resolveDesktopBrowser({
  args = [], packageResourcesPath, dataDir, profileDir, bundledPath,
  env = process.env, exists = existsSync,
}) {
  const mode = browserModeFromArgs(args, { packageResourcesPath, exists });
  if (!dataDir || !profileDir) throw new Error('应用数据路径不可用');
  if (mode === 'bundled') {
    if (!exists(bundledPath)) throw new Error('随应用提供的浏览器资源缺失');
    return { mode, browserPath: bundledPath, profileDir, dataDir };
  }

  const bases = [
    env['ProgramFiles(x86)'] ?? env['PROGRAMFILES(X86)'],
    env.ProgramFiles ?? env.PROGRAMFILES,
    env.LOCALAPPDATA,
  ];
  const browserPath = bases.filter(Boolean)
    .map(base => path.win32.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    .find(exists);
  if (!browserPath) {
    throw Object.assign(new Error('未找到 Microsoft Edge；内部 Edge 对照模式无法启动'), { code: 'EDGE_NOT_FOUND' });
  }
  return { mode, browserPath, profileDir: `${profileDir}-edge`, dataDir: `${dataDir}-edge` };
}
