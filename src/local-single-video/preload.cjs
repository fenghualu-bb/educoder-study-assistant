const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('studyAppearance', Object.freeze({
  get: () => ipcRenderer.invoke('appearance:get'),
  onChanged: callback => { ipcRenderer.on('appearance:changed', (_event, mode) => callback(mode)); },
}));
contextBridge.exposeInMainWorld('singleVideo', {
  status: () => ipcRenderer.invoke('single:status'),
  action: action => ipcRenderer.invoke('single:action', action),
  options: patch => ipcRenderer.invoke('single:options', patch),
  queueAction: action => ipcRenderer.invoke('single:queue-action', action),
  home: () => ipcRenderer.invoke('single:home'),
  finish: () => ipcRenderer.invoke('single:finish'),
  discardAndFinish: () => ipcRenderer.invoke('single:discard-and-finish', true),
  onFinishError: callback => { ipcRenderer.on('single:finish-error', (_event, message) => callback(message)); },
});
