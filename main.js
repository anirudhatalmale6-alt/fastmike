const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.webp', '.tif', '.tiff']);

const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff'
};

let win = null;

// On a PC with broken or missing GPU drivers Chromium would otherwise hand out
// a WebGL context that immediately dies. This lets it fall back to its software
// renderer instead; the app has its own CPU path as a second line of defence.
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

/* Alt is an editing modifier in this app, so there must be no menu bar for
 * Windows to pop open when it is pressed. `autoHideMenuBar` only hides it -
 * Alt still summons it - so the menu is removed altogether. */
Menu.setApplicationMenu(null);

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#151515',
    autoHideMenuBar: true,
    show: false,
    title: 'FastMike',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // preload does no filesystem work of its own, so it can stay sandboxed
      sandbox: true,
      // large event shoots: keep decoded bitmaps on the GPU
      backgroundThrottling: false
    }
  });

  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => win.show());
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

/** The folders directly inside dir, in the order a file browser would show them. */
function subFolders(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name[0] !== '.')
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch (_) {
    return [];                        // unreadable - no folders, not a failure
  }
}

/**
 * A photographer's folder and the folders inside it.
 *
 * The setup at a venue is one folder per event, a folder inside it per
 * photographer, and inside that D1, D2, D3... - one per shot. So the folder that
 * is picked usually holds no photographs at all, only subfolders. Every image is
 * returned in one list, each tagged with the folder it came from - "D2", or
 * "Dimitris/D2" if he pointed at the whole event - and the folders are listed
 * separately so the interface can draw them as a tree.
 *
 * Two levels deep and no further, and it gives up after MAX_DIRS folders.
 * Walking a whole disk from a folder chosen by mistake would hang the app at
 * exactly the wrong moment of the night.
 */
const MAX_DEPTH = 2;
const MAX_DIRS = 300;

function listTree(dir) {
  const files = [];
  const groups = [];
  let seen = 0;

  const walk = (at, rel, depth) => {
    let inside = [];
    try {
      inside = listImages(at);
    } catch (_) {
      return;                         // unreadable folder - skip, do not fail
    }
    if (inside.length || rel === '') {
      groups.push({ name: rel, count: inside.length });
      files.push(...inside.map((f) => Object.assign({ group: rel }, f)));
    }
    if (depth >= MAX_DEPTH) return;
    for (const name of subFolders(at)) {
      if (++seen > MAX_DIRS) return;
      walk(path.join(at, name), rel ? rel + '/' + name : name, depth + 1);
    }
  };

  walk(dir, '', 0);

  // the folder itself only earns a row of its own when it holds photographs
  if (groups.length && groups[0].name === '' && !groups[0].count) groups.shift();
  return { files, groups };
}

ipcMain.handle('import:files', async () => {
  let res;
  try {
    res = await dialog.showOpenDialog(win, {
      title: 'Import photos',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'bmp', 'webp', 'tif', 'tiff'] }]
    });
  } catch (err) {
    return { error: 'Could not open the file chooser: ' + err.message };
  }
  if (res.canceled) return [];
  return res.filePaths.map((p) => ({ name: path.basename(p), path: p }));
});

/**
 * Read one original off disk. Read-only - the source file is never written.
 *
 * The bytes are sent as-is rather than as a base64 data URL: a 24 megapixel
 * JPEG turns into an 11 MB string that has to be encoded here, copied across
 * the bridge and parsed again in the renderer, which is dead time between
 * clicking a photo and seeing it.
 */
ipcMain.handle('image:bytes', async (_e, p) => {
  const buf = await fs.promises.readFile(p);
  return {
    bytes: new Uint8Array(buf),
    mime: MIME[path.extname(p).toLowerCase()] || 'image/jpeg'
  };
});

/**
 * Nothing here may fail silently. "I press Import Folder and nothing happens" is
 * impossible to work on from a distance, so anything that goes wrong comes back
 * as a message the operator can read out.
 */
ipcMain.handle('import:folder', async () => {
  let res;
  try {
    res = await dialog.showOpenDialog(win, {
      title: 'Import folder',
      properties: ['openDirectory']
    });
  } catch (err) {
    return { dir: '', files: [], groups: [], error: 'Could not open the folder chooser: ' + err.message };
  }
  if (res.canceled) return null;

  const dir = res.filePaths[0];
  if (!dir) return null;
  try {
    return Object.assign({ dir }, listTree(dir));
  } catch (err) {
    return { dir, files: [], groups: [], error: 'Could not read ' + dir + ': ' + err.message };
  }
});

/**
 * Re-read a folder that was chosen earlier.
 *
 * Each photographer shoots into his own folder on the desktop, so at an event
 * the folder is picked once and then pulled from again and again as new frames
 * land in it. No dialog - the wrong folder at eleven at night with a queue of
 * people waiting is exactly the mistake this avoids.
 */
ipcMain.handle('import:folder-at', async (_e, dir) => {
  try {
    if (!fs.statSync(dir).isDirectory()) return { dir, files: [], groups: [], missing: true };
    return Object.assign({ dir }, listTree(dir));
  } catch (_) {
    return { dir, files: [], groups: [], missing: true };
  }
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
/* Settings                                                            */
/*                                                                     */
/* The printer is configured once before an event and remembered, so   */
/* the operator never picks it again while photos are going out.       */
/* ------------------------------------------------------------------ */

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

ipcMain.handle('settings:get', async () => {
  try {
    return JSON.parse(await fs.promises.readFile(settingsFile(), 'utf8'));
  } catch (_) {
    return {};
  }
});

ipcMain.handle('settings:set', async (_e, value) => {
  await fs.promises.writeFile(settingsFile(), JSON.stringify(value, null, 2), 'utf8');
  return true;
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
