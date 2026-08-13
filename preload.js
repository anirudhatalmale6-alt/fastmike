const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff'
};

contextBridge.exposeInMainWorld('fastmike', {
  isDesktop: true,

  importFiles: () => ipcRenderer.invoke('import:files'),
  importFolder: () => ipcRenderer.invoke('import:folder'),

  // read straight off disk - no copying, originals are never modified
  readImage: (p) => {
    const buf = fs.readFileSync(p);
    const mime = MIME[path.extname(p).toLowerCase()] || 'image/jpeg';
    return 'data:' + mime + ';base64,' + buf.toString('base64');
  },

  pickExportFolder: () => ipcRenderer.invoke('export:pick-folder'),
  writeExport: (folder, name, dataUrl) =>
    ipcRenderer.invoke('export:write', { folder, name, dataUrl }),

  listPrinters: () => ipcRenderer.invoke('print:list'),
  printImages: (payload) => ipcRenderer.invoke('print:images', payload)
});
