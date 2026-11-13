// 渲染层唯一入口:window.dj(最小面,全部经 invoke)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dj', {
  pickDirectory: () => ipcRenderer.invoke('dj:pick-directory'),
  scan: (root, maxDepth) => ipcRenderer.invoke('dj:scan', { root, maxDepth }),
  scanPause: () => ipcRenderer.invoke('dj:scan-pause'),
  scanResume: () => ipcRenderer.invoke('dj:scan-resume'),
  scanCancel: () => ipcRenderer.invoke('dj:scan-cancel'),
  expand: (dirPath, maxDepth) => ipcRenderer.invoke('dj:expand', { dirPath, maxDepth }),
  plan: (paths, mode) => ipcRenderer.invoke('dj:plan', { paths, mode }),
  execute: (paths, mode) => ipcRenderer.invoke('dj:execute', { paths, mode }),
  undoList: () => ipcRenderer.invoke('dj:undo-list'),
  undo: id => ipcRenderer.invoke('dj:undo', { id }),
  stagingUsage: () => ipcRenderer.invoke('dj:staging-usage'),
  purgeBatch: id => ipcRenderer.invoke('dj:purge-batch', { id }),
  purgeAll: () => ipcRenderer.invoke('dj:purge-all'),
  overlayLoad: () => ipcRenderer.invoke('dj:overlay-load'),
  overlaySave: text => ipcRenderer.invoke('dj:overlay-save', { text }),
  reveal: p => ipcRenderer.invoke('dj:reveal', { p }),
  exportReport: outDir => ipcRenderer.invoke('dj:export-report', { outDir }),
  onScanProgress: cb => ipcRenderer.on('dj:scan-progress', (_e, payload) => cb(payload)),
});
