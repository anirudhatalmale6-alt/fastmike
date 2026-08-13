/* The only bridge between the UI and the machine.
 *
 * Deliberately no `require('fs')` here: Electron runs preload scripts in a
 * sandbox by default, where node builtins are unavailable, and a preload that
 * throws leaves the whole bridge undefined - the app silently falls back to
 * browser mode with no printer list and no native file dialogs. Every
 * filesystem operation goes through IPC to the main process instead.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('fastmike', {
  isDesktop: true,

  importFiles: () => ipcRenderer.invoke('import:files'),
  importFolder: () => ipcRenderer.invoke('import:folder'),

  // reads straight off disk - originals are opened read-only, never written
  readImage: (p) => ipcRenderer.invoke('image:read', p),

  pickExportFolder: () => ipcRenderer.invoke('export:pick-folder'),
  writeExport: (folder, name, dataUrl) =>
    ipcRenderer.invoke('export:write', { folder, name, dataUrl }),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (v) => ipcRenderer.invoke('settings:set', v),

  listPrinters: () => ipcRenderer.invoke('print:list'),
  printImages: (payload) => ipcRenderer.invoke('print:images', payload),

  // Electron 32 removed File.path; this is the supported replacement and is
  // what lets drag-and-drop use the on-disk file rather than a memory copy.
  pathForFile: (file) => {
    try {
      return webUtils && webUtils.getPathForFile ? webUtils.getPathForFile(file) : null;
    } catch (_) {
      return null;
    }
  }
});
