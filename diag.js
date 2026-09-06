/**
 * A log file, and the handlers that make sure something is written to it when
 * the app dies.
 *
 * An app that closes without saying anything cannot be worked on from another
 * country. Everything here exists so that "it freezes and then closes" leaves a
 * file behind that names what happened.
 *
 * The file is written next to the portable exe - which is wherever he keeps the
 * icon he double clicks - because asking someone to find AppData mid-event is
 * asking for nothing back. electron-builder sets PORTABLE_EXECUTABLE_DIR to the
 * folder the portable was launched from; the exe itself runs from a temporary
 * copy, so process.execPath is the wrong place to look.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_BYTES = 2 * 1024 * 1024;   // keep the tail of a long night, not all of it
const KEEP_BYTES = 512 * 1024;

let file = null;
let broken = false;

function stamp() {
  const d = new Date();
  const p = (n, w) => String(n).padStart(w || 2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) +
         '.' + p(d.getMilliseconds(), 3);
}

/** Somewhere we can actually write, tried in order of how easily he can find it. */
function pickDir(app) {
  const tries = [
    process.env.PORTABLE_EXECUTABLE_DIR,
    path.dirname(process.execPath),
    app && app.getPath('userData'),
    os.tmpdir()
  ];
  for (const dir of tries) {
    if (!dir) continue;
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch (_) {
      // not writable - a portable on a locked-down machine, try the next one
    }
  }
  return null;
}

/**
 * Trim the log if it has grown, keeping the end.
 *
 * The end is the part that matters: whatever was happening when it stopped.
 */
function trim() {
  try {
    if (fs.statSync(file).size <= MAX_BYTES) return;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(KEEP_BYTES);
    const size = fs.fstatSync(fd).size;
    fs.readSync(fd, buf, 0, KEEP_BYTES, size - KEEP_BYTES);
    fs.closeSync(fd);
    fs.writeFileSync(file, '...earlier lines trimmed...\n' + buf.toString('utf8'));
  } catch (_) {
    // trimming is housekeeping, never a reason to lose the run we are logging
  }
}

/**
 * Append one line.
 *
 * Written synchronously on purpose. These lines are most valuable in the last
 * moments before the process disappears, and a queued asynchronous write is
 * exactly what would be lost there.
 */
function line(tag, msg) {
  if (!file || broken) return;
  try {
    fs.appendFileSync(file, stamp() + '  ' + tag + '  ' + msg + '\n');
  } catch (_) {
    broken = true;                    // a full or read-only disk must not crash us
  }
}

function describe(err) {
  if (!err) return 'unknown';
  return (err.stack || (err.name + ': ' + err.message) || String(err))
    .split('\n').slice(0, 6).join(' | ');
}

/** Open the log and write the header describing this machine. */
function start(app, extra) {
  const dir = pickDir(app);
  if (!dir) return null;
  file = path.join(dir, 'FastMike-log.txt');
  try {
    trim();
    const mem = Math.round(os.totalmem() / (1024 * 1024 * 1024) * 10) / 10;
    fs.appendFileSync(file,
      '\n=======================================================\n' +
      new Date().toString() + '\n' +
      'FastMike ' + ((extra && extra.version) || '?') +
      '   electron ' + process.versions.electron +
      '   chrome ' + process.versions.chrome + '\n' +
      os.platform() + ' ' + os.release() + ' ' + process.arch +
      '   ' + mem + ' GB RAM   ' + os.cpus().length + ' cores\n' +
      'log file: ' + file + '\n' +
      '=======================================================\n');
  } catch (_) {
    file = null;
  }
  return file;
}

/**
 * Everything that can end the app without a word, wired to say something first.
 *
 * render-process-gone is the one that matters most here: when the window's
 * process runs out of memory the window simply vanishes, the app quits through
 * window-all-closed, and from the outside the program has closed itself.
 */
function watch(app, dialog, getWin) {
  process.on('uncaughtException', (err) => {
    line('CRASH', 'uncaught exception in the main process: ' + describe(err));
    try {
      dialog.showErrorBox('FastMike stopped',
        'Something went wrong and FastMike has to close.\n\n' + describe(err) +
        '\n\nDetails were written to:\n' + (file || '(no log file could be written)'));
    } catch (_) { /* no window yet - the log line is what counts */ }
    process.exit(1);
  });

  process.on('unhandledRejection', (err) => {
    line('ERROR', 'unhandled rejection in the main process: ' + describe(err));
  });

  app.on('render-process-gone', (_e, _wc, details) => {
    const why = (details && details.reason) || 'unknown';
    line('CRASH', 'the window process ended: reason=' + why +
                  ' exitCode=' + (details && details.exitCode));
    const human = {
      'oom': 'FastMike ran out of memory.\n\nThis usually means too many photos ' +
             'were imported in one go. Try one photographer folder at a time.',
      'crashed': 'The FastMike window closed unexpectedly.',
      'killed': 'Something outside FastMike stopped it - usually antivirus.',
      'launch-failed': 'The FastMike window could not start.'
    }[why] || 'The FastMike window closed unexpectedly (' + why + ').';
    try {
      dialog.showErrorBox('FastMike stopped', human +
        '\n\nDetails were written to:\n' + (file || '(no log file could be written)'));
    } catch (_) { /* nothing to attach a dialog to */ }
  });

  app.on('child-process-gone', (_e, details) => {
    line('ERROR', 'a helper process ended: type=' + (details && details.type) +
                  ' reason=' + (details && details.reason));
  });

  const w = getWin && getWin();
  if (w) attachWindow(w);
}

/** Per-window signals - a hang, and anything the page itself complains about. */
function attachWindow(win) {
  win.on('unresponsive', () => line('HANG', 'the window stopped responding'));
  win.on('responsive', () => line('HANG', 'the window is responding again'));
  win.webContents.on('console-message', (_e, level, message, lineNo, src) => {
    // 2 is warning, 3 is error - the rest is our own progress logging
    if (level >= 2) {
      line(level === 3 ? 'PAGE-ERR' : 'PAGE-WARN',
           message + '  (' + path.basename(src || '?') + ':' + lineNo + ')');
    }
  });
  win.webContents.on('preload-error', (_e, p, err) => {
    line('CRASH', 'preload failed: ' + p + ' ' + describe(err));
  });
}

module.exports = { start, watch, attachWindow, line, describe, logPath: () => file };
