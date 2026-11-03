import path from 'node:path';

export function resolveDesktopPaths({ userData, sessionData, resourcesPath, packaged, projectRoot }) {
  if (!userData || !sessionData || !resourcesPath) throw new Error('应用数据路径不可用');
  if (!packaged && !projectRoot) throw new Error('开发资源路径不可用');
  return {
    dataDir: userData,
    profileDir: path.win32.join(sessionData, 'browser-profile'),
    browserRoot: packaged
      ? path.win32.join(resourcesPath, 'ms-playwright')
      : path.win32.join(projectRoot, 'vendor', 'ms-playwright'),
  };
}
