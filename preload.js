'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('journal', {
  load: () => ipcRenderer.invoke('journal:load'),
  save: (data) => ipcRenderer.invoke('journal:save', data),
  exportToFile: () => ipcRenderer.invoke('journal:export-file'),
  exportToPdf: () => ipcRenderer.invoke('journal:export-pdf'),
  copyAll: () => ipcRenderer.invoke('journal:copy-all'),

  getQuestions: () => ipcRenderer.invoke('questions:get'),
  setQuestions: (list) => ipcRenderer.invoke('questions:set', list),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),

  pinStatus: () => ipcRenderer.invoke('pin:status'),
  pinSet: (pin) => ipcRenderer.invoke('pin:set', pin),
  pinVerify: (pin) => ipcRenderer.invoke('pin:verify', pin),
  pinRemove: (pin) => ipcRenderer.invoke('pin:remove', pin),

  openDataFolder: () => ipcRenderer.invoke('app:open-data-folder'),

  appVersion: () => ipcRenderer.invoke('app:version'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  getUpdateSetting: () => ipcRenderer.invoke('update:get-setting'),
  setUpdateSetting: (on) => ipcRenderer.invoke('update:set-setting', on),
  onUpdateStatus: (cb) => ipcRenderer.on('update:status', (_e, payload) => cb(payload)),

  closeNow: () => ipcRenderer.send('app:close-now'),
  dirtyReply: (v) => ipcRenderer.send('app:dirty-reply', Boolean(v)),

  onMenu: (cb) => ipcRenderer.on('menu', (_e, action) => cb(action)),
  onQueryDirty: (cb) => ipcRenderer.on('app:query-dirty', () => cb()),
  onSaveThenClose: (cb) => ipcRenderer.on('app:save-then-close', () => cb())
});
