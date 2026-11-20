const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('studyAppearance', Object.freeze({
  get: () => ipcRenderer.invoke('appearance:get'),
  set: mode => ipcRenderer.invoke('appearance:set', mode),
  onChanged: callback => { ipcRenderer.on('appearance:changed', (_event, mode) => callback(mode)); },
}));
contextBridge.exposeInMainWorld('localManualVideo', Object.freeze({
  open: request => ipcRenderer.invoke('local-manual-video:open', request),
  session: () => ipcRenderer.invoke('local-manual-video:session'),
  onSessionChanged: callback => { ipcRenderer.on('local-manual-video:session-changed', (_event, state) => callback(state)); },
  onClosed: callback => { ipcRenderer.on('local-manual-video:closed', (_event, result) => callback(result)); },
}));
