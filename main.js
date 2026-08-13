const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.webp', '.tif', '.tiff']);

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#151515',
    autoHideMenuBar: true,
    title: 'FastMike',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // large event shoots: keep decoded bitmaps on the GPU
      backgroundThrottling: false
    }
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

function listImages(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((f) => ({ name: f, path: path.join(dir, f) }));
}

ipcMain.handle('import:files', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Import photos',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'bmp', 'webp', 'tif', 'tiff'] }]
  });
  if (res.canceled) return [];
  return res.filePaths.map((p) => ({ name: path.basename(p), path: p }));
});

ipcMain.handle('import:folder', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Import folder',
    properties: ['openDirectory']
  });
  if (res.canceled) return [];
  return listImages(res.filePaths[0]);
});

/* ------------------------------------------------------------------ */
/* Save / export                                                       */
/* ------------------------------------------------------------------ */

ipcMain.handle('export:pick-folder', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose export folder',
    properties: ['openDirectory', 'createDirectory']
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('export:write', async (_e, { folder, name, dataUrl }) => {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const target = path.join(folder, name);
  fs.writeFileSync(target, Buffer.from(base64, 'base64'));
  return target;
});

/* ------------------------------------------------------------------ */
/* Print                                                               */
/* ------------------------------------------------------------------ */

ipcMain.handle('print:list', async () => {
  if (!win) return [];
  const printers = await win.webContents.getPrintersAsync();
  return printers.map((p) => ({
    name: p.name,
    displayName: p.displayName,
    isDefault: p.isDefault,
    status: p.status
  }));
});

/**
 * Prints one or more already-rendered print-ready images.
 * Each image is laid out on its own page at exactly widthMm x heightMm,
 * borderless, so the printer driver does not rescale the crop.
 */
ipcMain.handle('print:images', async (_e, { images, widthMm, heightMm, printer, silent, copies }) => {
  const pages = images
    .map(
      (d) =>
        `<div class="page"><img src="${d}"></div>`
    )
    .join('');

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  @page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  .page {
    width: ${widthMm}mm; height: ${heightMm}mm;
    page-break-after: always; overflow: hidden;
  }
  .page:last-child { page-break-after: auto; }
  .page img { width: 100%; height: 100%; display: block; object-fit: fill; }
</style></head><body>${pages}</body></html>`;

  const job = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: false, sandbox: true }
  });

  await job.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  // give the decoder a moment so the first page is never blank
  await job.webContents.executeJavaScript(
    'Promise.all(Array.from(document.images).map(i => i.decode().catch(() => {})))'
  );

  const opts = {
    silent: !!silent,
    printBackground: true,
    color: true,
    margins: { marginType: 'none' },
    copies: copies || 1,
    pageSize: { width: Math.round(widthMm * 1000), height: Math.round(heightMm * 1000) }
  };
  if (printer) opts.deviceName = printer;

  return new Promise((resolve) => {
    job.webContents.print(opts, (success, reason) => {
      job.destroy();
      resolve({ success, reason });
    });
  });
});
