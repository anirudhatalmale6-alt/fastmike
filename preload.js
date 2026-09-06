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
  importFolderAt: (dir) => ipcRenderer.invoke('import:folder-at', dir),

  // reads straight off disk - originals are opened read-only, never written
  readImageBytes: (p) => ipcRenderer.invoke('image:bytes', p),

  pickExportFolder: () => ipcRenderer.invoke('export:pick-folder'),
  writeExport: (folder, name, dataUrl) =>
    ipcRenderer.invoke('export:write', { folder, name, dataUrl }),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (v) => ipcRenderer.invoke('settings:set', v),

  // one shared log file, so a single attachment tells the whole story
  log: (tag, msg) => ipcRenderer.invoke('diag:log', tag, msg),
  logPath: () => ipcRenderer.invoke('diag:path'),

  listPrinters: () => ipcRenderer.invoke('print:list'),
  printerPaper: (name) => ipcRenderer.invoke('print:paper', name),
  printImages: (payload) => ipcRenderer.invoke('print:images', payload),

  // Electron 32 removed File.path; webUtils is the supported replacement and is
  // what lets drag-and-drop use the on-disk file rather than a memory copy.
  // The Windows 7 build runs Electron 22, which has no webUtils but still has
  // File.path - so dragging photos in reads from disk on both.
  pathForFile: (file) => {
    try {
      if (webUtils && webUtils.getPathForFile) return webUtils.getPathForFile(file);
      return (file && file.path) || null;
    } catch (_) {
      return null;
    }
  }
});
