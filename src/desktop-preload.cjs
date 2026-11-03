const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('studyAppearance', Object.freeze({
  get: () => ipcRenderer.invoke('appearance:get'),
  set: mode => ipcRenderer.invoke('appearance:set', mode),
  onChanged: callback => { ipcRenderer.on('appearance:changed', (_event, mode) => callback(mode)); },
}));
contextBridge.exposeInMainWorld('localManualVideo', Object.freeze({
  start: request => ipcRenderer.invoke('local-manual-video:start', request),
  status: () => ipcRenderer.invoke('local-manual-video:status'),
  action: name => ipcRenderer.invoke('local-manual-video:action', name),
  finish: () => ipcRenderer.invoke('local-manual-video:finish'),
  discardAndFinish: () => ipcRenderer.invoke('local-manual-video:discard-and-finish', true),
  options: patch => ipcRenderer.invoke('local-manual-video:options', patch),
  playbackOptions: () => ipcRenderer.invoke('local-manual-video:playback-options'),
  position: selection => ipcRenderer.invoke('local-manual-video:position', selection),
  session: () => ipcRenderer.invoke('local-manual-video:session'),
  onSessionChanged: callback => { ipcRenderer.on('local-manual-video:session-changed', (_event, state) => callback(state)); },
  recent: courseUrl => ipcRenderer.invoke('local-manual-video:recent', courseUrl),
  personalSummary: () => ipcRenderer.invoke('personal-queue:summary'),
  onPersonalChanged: callback => { ipcRenderer.on('personal-queue:changed', (_event, state) => callback(state)); },
  onClosed: callback => { ipcRenderer.on('local-manual-video:closed', (_event, result) => callback(result)); },
}));
