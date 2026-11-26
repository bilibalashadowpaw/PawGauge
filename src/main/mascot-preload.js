'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mascot', {
  onLook: (cb) => ipcRenderer.on('look', (_e, dx) => cb(dx)),
  onMood: (cb) => ipcRenderer.on('mood', (_e, m) => cb(m)),
  onMode: (cb) => ipcRenderer.on('mode', (_e, m) => cb(m)),
  clicked: () => ipcRenderer.send('mascot-click'),
});
