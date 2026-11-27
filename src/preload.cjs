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
  choose: () => ipcRenderer.invoke('course:choose'),
  importPath: (path) => ipcRenderer.invoke('course:import-path', path),
  setName: (name) => ipcRenderer.invoke('course:set-name', name),
  launch: () => ipcRenderer.invoke('course:launch'),
  platform: () => ipcRenderer.invoke('course:platform'),
  exportWrapper: () => ipcRenderer.invoke('course:export'),
  openFolder: (folder) => ipcRenderer.invoke('course:open-folder', folder),
  onDroppedImport: (callback) => ipcRenderer.on('course:imported', (_event, meta) => callback(meta)),
  onDroppedError: (callback) => ipcRenderer.on('course:import-error', (_event, message) => callback(message))
});
