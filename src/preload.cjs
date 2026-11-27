const { contextBridge, ipcRenderer, webUtils } = require('electron');

window.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    const filePath = webUtils.getPathForFile(file);
    if (filePath) ipcRenderer.send('course:dropped', filePath);
  });
});

contextBridge.exposeInMainWorld('slCourse', {
  status: () => ipcRenderer.invoke('course:status'),
  checkUpdates: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  openUpdateRelease: (url) => ipcRenderer.invoke('updater:open-release', url),
  choose: () => ipcRenderer.invoke('course:choose'),
  importPath: (path) => ipcRenderer.invoke('course:import-path', path),
  setName: (name) => ipcRenderer.invoke('course:set-name', name),
  launch: () => ipcRenderer.invoke('course:launch'),
  platforms: () => ipcRenderer.invoke('course:platforms'),
  exportWrapper: (targets) => ipcRenderer.invoke('course:export', targets),
  openFolder: (folder) => ipcRenderer.invoke('course:open-folder', folder),
  onDroppedImport: (callback) => ipcRenderer.on('course:imported', (_event, meta) => callback(meta)),
  onDroppedError: (callback) => ipcRenderer.on('course:import-error', (_event, message) => callback(message)),
  onUpdate: (callback) => {
    for (const channel of ['updater:checking','updater:available','updater:current','updater:progress','updater:downloaded','updater:error']) {
      ipcRenderer.on(channel, (_event, info) => callback(channel, info));
    }
  }
});
