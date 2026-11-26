'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('usage', {
  getState: () => ipcRenderer.invoke('get-state'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  refresh: () => ipcRenderer.send('refresh'),
  quit: () => ipcRenderer.send('quit'),
  hide: () => ipcRenderer.send('hide'),
  setOrder: (ids) => ipcRenderer.send('set-order', ids),
  setMascot: (v) => ipcRenderer.send('set-mascot', v),
  openProvider: (id) => ipcRenderer.send('open-provider', id),
  setPinned: (v) => ipcRenderer.send('set-pinned', v),
  reportHeight: (h) => ipcRenderer.send('content-height', h),
  setCollapsed: (v) => ipcRenderer.send('set-collapsed', v),
  pillDrag: (phase) => ipcRenderer.send('pill-drag', phase),
});
