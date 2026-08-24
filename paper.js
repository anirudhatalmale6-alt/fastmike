/* FastMike - what paper the printer is actually set to
 * ---------------------------------------------------------------------------
 * A dye-sub roll is 6 inches wide and the driver decides where to cut it - at 4
 * inches or at 8. That choice lives in the Windows printer preferences, not in
 * this app. Set to 6x4 the driver quietly shrinks the 6x8 page we send and pads
 * the two long sides with white, which is a ruined print and a ruined sheet of
 * media. So the app reads the setting and can warn before anything is sent.
 *
 * Read-only on purpose: it reports what the driver is on and never changes it.
 *
 * Kept out of main.js so the parsing can be tested on its own, without Electron
 * and without Windows - which is the only part of this that can be tested here
 * at all.
 */

'use strict';

/** Quote a printer name for a single-quoted PowerShell string - no interpolation. */
function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/**
 * .NET reports paper in hundredths of an inch, which is the unit these printers
 * are actually sold in - 6x8 is 600 x 800, with no floating point anywhere near
 * it. PowerShell 2.0 is all Windows 7 ships with, so no ConvertTo-Json: plain
 * delimited lines, parsed here.
 */
function paperScript(printer) {
  return [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Drawing',
    '$ps = New-Object System.Drawing.Printing.PrinterSettings',
    '$ps.PrinterName = ' + psQuote(printer),
    'if (-not $ps.IsValid) { Write-Output "ERR|Windows does not have that printer"; exit }',
    '$d = $ps.DefaultPageSettings.PaperSize',
    'Write-Output ("CUR|" + $d.PaperName + "|" + $d.Width + "|" + $d.Height)',
    'foreach ($p in $ps.PaperSizes) {',
    '  Write-Output ("PAP|" + $p.PaperName + "|" + $p.Width + "|" + $p.Height)',
    '}'
  ].join('\n');
}

/**
 * One "NAME|width|height" line into a paper.
 *
 * The name is read from the left and the two numbers from the right, because
 * driver paper names contain bars, brackets and all sorts - "PC (6x8) | 2 cut"
 * is a real one. Splitting on the last two separators cannot be confused by it.
 */
function parsePaper(rest) {
  const cut = rest.lastIndexOf('|');
  if (cut < 0) return null;
  const cut2 = rest.lastIndexOf('|', cut - 1);
  if (cut2 < 0) return null;

  const w = parseInt(rest.slice(cut2 + 1, cut), 10);
  const h = parseInt(rest.slice(cut + 1), 10);
  if (!(w > 0) || !(h > 0)) return null;

  return {
    name: rest.slice(0, cut2).trim(),
    wIn: w / 100,
    hIn: h / 100,
    // 6.00 x 8.00 in is 152.4 x 203.2 mm - the same numbers the crop works in
    wMm: Math.round(((w * 25.4) / 100) * 10) / 10,
    hMm: Math.round(((h * 25.4) / 100) * 10) / 10
  };
}

/**
 * The whole PowerShell reply.
 *
 * Anything unrecognised is ignored rather than treated as a failure - a profile
 * banner or a warning line printed ahead of the real output must not turn a
 * good answer into "paper size unknown".
 */
function parsePaperOutput(text) {
  const out = { papers: [], current: null };

  for (const line of String(text).split(/\r?\n/)) {
    const bar = line.indexOf('|');
    if (bar < 0) continue;
    const tag = line.slice(0, bar).trim();
    const rest = line.slice(bar + 1);

    if (tag === 'ERR') return { error: rest.trim() || 'Could not read the printer' };
    if (tag === 'CUR') out.current = parsePaper(rest);
    else if (tag === 'PAP') {
      const p = parsePaper(rest);
      if (p) out.papers.push(p);
    }
  }

  if (!out.current && !out.papers.length) return { error: 'The printer reported no paper sizes' };
  return out;
}

module.exports = { psQuote, paperScript, parsePaper, parsePaperOutput };
