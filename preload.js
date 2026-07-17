'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('journal', {
  load: () => ipcRenderer.invoke('journal:load'),
  save: (data) => ipcRenderer.invoke('journal:save', data),
  exportToFile: () => ipcRenderer.invoke('journal:export-file'),
  exportToPdf: () => ipcRenderer.invoke('journal:export-pdf'),
  exportToMarkdown: () => ipcRenderer.invoke('journal:export-markdown'),
  exportToJson: () => ipcRenderer.invoke('journal:export-json'),
  importJson: () => ipcRenderer.invoke('journal:import-json'),
  copyAll: () => ipcRenderer.invoke('journal:copy-all'),

  getQuestions: () => ipcRenderer.invoke('questions:get'),
  setQuestions: (list) => ipcRenderer.invoke('questions:set', list),
  getTemplates: () => ipcRenderer.invoke('templates:get'),
  setTemplates: (list) => ipcRenderer.invoke('templates:set', list),
  addMedia: () => ipcRenderer.invoke('media:add'),
  getMedia: (id) => ipcRenderer.invoke('media:get', id),
  removeMedia: (id) => ipcRenderer.invoke('media:remove', id),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),
  getGuided: () => ipcRenderer.invoke('guided:get'),
  setGuided: (on) => ipcRenderer.invoke('guided:set', on),
  getOnboarded: () => ipcRenderer.invoke('onboarding:get'),
  setOnboarded: () => ipcRenderer.invoke('onboarding:done'),
  getAutoLock: () => ipcRenderer.invoke('autolock:get'),
  setAutoLock: (minutes) => ipcRenderer.invoke('autolock:set', minutes),
  getDaysOff: () => ipcRenderer.invoke('daysoff:get'),
  setDaysOff: (days) => ipcRenderer.invoke('daysoff:set', days),
  getReminder: () => ipcRenderer.invoke('reminder:get'),
  setReminder: (next) => ipcRenderer.invoke('reminder:set', next),
  getBackup: () => ipcRenderer.invoke('backup:get'),
  setBackup: (next) => ipcRenderer.invoke('backup:set', next),
  chooseBackupFolder: () => ipcRenderer.invoke('backup:choose-folder'),
  runBackupNow: () => ipcRenderer.invoke('backup:run-now'),

  pinStatus: () => ipcRenderer.invoke('pin:status'),
  pinSet: (pin) => ipcRenderer.invoke('pin:set', pin),
  pinVerify: (pin) => ipcRenderer.invoke('pin:verify', pin),
  pinRemove: (pin) => ipcRenderer.invoke('pin:remove', pin),

  securityStatus: () => ipcRenderer.invoke('security:status'),
  unlock: (pin) => ipcRenderer.invoke('security:unlock', pin),
  unlockWithRecovery: (code) => ipcRenderer.invoke('security:unlock-recovery', code),
  lock: () => ipcRenderer.invoke('security:lock'),
  enableEncryption: (pin) => ipcRenderer.invoke('security:enable', pin),
  disableEncryption: (pin) => ipcRenderer.invoke('security:disable', pin),
  changeEncryptionPin: (currentPin, newPin) => ipcRenderer.invoke('security:change-pin', currentPin, newPin),
  resetAfterRecovery: (newPin) => ipcRenderer.invoke('security:reset-after-recovery', newPin),
  checkPin: (pin) => ipcRenderer.invoke('security:check-pin', pin),
  copyText: (text) => ipcRenderer.invoke('app:copy-text', text),

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
