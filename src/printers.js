/* FastMike - the printers in use at this event
 * ---------------------------------------------------------------------------
 * A venue has two dye-subs standing side by side, and any photographer may want
 * to send a batch to either one - the DNP is busy with a queue of ten, so the
 * next lot goes to the Citizen instead.
 *
 * So the printers are not owned by a photographer. They are set up once for the
 * event and every tab gets a button for each of them.
 */

'use strict';

window.FM = window.FM || {};

(function (FM) {

  // What a photo printer looks like in a Windows printer list. Anything else at
  // a venue is an office laser or a PDF writer, which is never what is wanted.
  const PHOTO_PRINTER =
    /\b(dnp|citizen|ds620|ds820|ds-?rx1|rx1|cx-?0?2|cy-?0?2|qw410|sinfonia|mitsubishi|cp-?k60|hiti)\b/i;

  let inUse = [];                  // [{ name, label, silent, auto, paper }]
  let watcher = function () {};

  /* What the media is supposed to be. A 6 inch roll cut at 8 inches - the size
   * every photo in this app is rendered at. Half an inch of slack either way,
   * because a driver may call the same paper 6x8, 152x203mm or 15x20cm and the
   * rounding is not always kind. */
  const WANT_IN = { w: 6, h: 8 };
  const SLACK_IN = 0.5;

  /** Is this paper the 6x8 the app prints, in either orientation? */
  function isTargetPaper(paper) {
    if (!paper) return false;
    const near = (a, b) => Math.abs(a - b) <= SLACK_IN;
    return (near(paper.wIn, WANT_IN.w) && near(paper.hIn, WANT_IN.h)) ||
           (near(paper.wIn, WANT_IN.h) && near(paper.hIn, WANT_IN.w));
  }

  /** "6 × 8 in" - what he reads on the box the media came in. */
  function paperLabel(paper) {
    if (!paper) return '';
    const n = (v) => String(Math.round(v * 100) / 100).replace(/\.0+$/, '');
    return n(paper.wIn) + ' × ' + n(paper.hIn) + ' in';
  }

  /**
   * What the driver says it is set to, once it has been asked.
   *
   * Three states, and they mean different things: null is "not asked yet", an
   * object with .error is "asked and could not tell", and an object with
   * .current is an answer. Only the third one is ever used to block a print -
   * not knowing must never stop him printing.
   */
  function setPaper(name, info) {
    const p = byName(name);
    if (!p) return false;
    p.paper = info || null;
    changed();
    return true;
  }

  function paperFor(name) {
    const p = byName(name);
    return p ? (p.paper || null) : null;
  }

  /**
   * Is this printer set to the wrong paper? Returns the offending paper, or
   * null when it is right, unknown, or the driver could not be read.
   */
  function wrongPaper(name) {
    const info = paperFor(name);
    if (!info || info.error || !info.current) return null;
    return isTargetPaper(info.current) ? null : info.current;
  }

  /** Whether the page size is sent to the driver, or left to the driver. */
  function sendsPageSize(name) {
    const p = byName(name);
    return p ? p.auto !== true : true;
  }

  function setAuto(name, auto) {
    const p = byName(name);
    if (!p) return false;
    p.auto = !!auto;
    changed();
    return true;
  }

  /** Button text. The driver name is usually far too long to sit on a button. */
  function shortLabel(displayName, name) {
    let s = String(displayName || name || '').trim();
    s = s.replace(/\s*\((?:copy\s*\d+|redirected[^)]*)\)\s*$/i, '');
    s = s.replace(/\s+(?:series|printer|photo\s+printer|card\s+printer)$/i, '');
    s = s.replace(/\s+/g, ' ').trim();
    if (s.length > 22) s = s.slice(0, 21).trim() + '…';
    return s || 'Printer';
  }

  function isPhoto(p) {
    return PHOTO_PRINTER.test((p.displayName || '') + ' ' + (p.name || ''));
  }

  function list() { return inUse; }

  function count() { return inUse.length; }

  function byName(name) { return inUse.find((p) => p.name === name) || null; }

  function labelFor(name) {
    const p = byName(name);
    return p ? p.label : (name || 'system dialog');
  }

  /** Whether this printer takes jobs straight, or shows the Windows dialog. */
  function silentFor(name) {
    const p = byName(name);
    return p ? p.silent !== false : false;
  }

  function setSilent(name, silent) {
    const p = byName(name);
    if (!p) return false;
    p.silent = !!silent;
    changed();
    return true;
  }

  function rename(name, label) {
    const p = byName(name);
    if (!p) return false;
    label = String(label || '').trim().slice(0, 22);
    if (!label) return false;
    p.label = label;
    changed();
    return true;
  }

  /** Put a printer on the bar. Adding one already there is a no-op. */
  function add(printer) {
    if (!printer || !printer.name || byName(printer.name)) return null;
    const p = {
      name: printer.name,
      label: shortLabel(printer.displayName, printer.name),
      silent: true,
      auto: false,
      paper: null
    };
    inUse.push(p);
    changed();
    return p;
  }

  function remove(name) {
    const i = inUse.findIndex((p) => p.name === name);
    if (i < 0) return false;
    inUse.splice(i, 1);
    changed();
    return true;
  }

  /**
   * First run, nothing saved: put the dye-subs on the bar. Windows' own default
   * printer is deliberately ignored unless nothing else is attached - at a
   * venue that default is an office laser somebody set up months ago.
   */
  function discover(available) {
    const photo = (available || []).filter(isPhoto);
    if (photo.length) {
      photo.slice(0, 4).forEach(add);
      return;
    }
    const def = (available || []).find((p) => p.isDefault) || (available || [])[0];
    if (def) add(def);
  }

  /* ------------------------------------------------------------ persistence */

  function toJSON() {
    return {
      // paper is not saved - it is whatever the driver is set to right now, and
      // that is a live fact, re-read every time the app starts
      printers: inUse.map((p) => ({ name: p.name, label: p.label, silent: p.silent, auto: !!p.auto }))
    };
  }

  /**
   * Rebuild from saved settings.
   *
   * Before this existed each photographer carried his own printer, so those are
   * folded into the bar - upgrading must not lose a setup somebody already did.
   */
  function load(saved) {
    saved = saved || {};
    inUse = [];

    if (Array.isArray(saved.printers) && saved.printers.length) {
      saved.printers.forEach((r) => {
        if (!r || !r.name || byName(r.name)) return;
        inUse.push({
          name: r.name,
          label: r.label || shortLabel(r.name),
          silent: r.silent !== false,
          auto: r.auto === true,
          paper: null
        });
      });
    } else {
      // older per-photographer format
      const older = []
        .concat(Array.isArray(saved.photographers) ? saved.photographers.map((p) => p && p.printer) : [])
        .concat([saved.printer]);
      older.filter(Boolean).forEach((name) => {
        if (byName(name)) return;
        inUse.push({ name, label: shortLabel(name), silent: saved.silent !== false, auto: false, paper: null });
      });
    }

    changed();
    return inUse.length > 0;
  }

  function onChange(fn) { watcher = fn; }
  function changed() { watcher(); }

  FM.printers = {
    PHOTO_PRINTER, isPhoto, shortLabel,
    list, count, byName, labelFor, silentFor, setSilent, rename,
    add, remove, discover, toJSON, load, onChange,
    isTargetPaper, paperLabel, setPaper, paperFor, wrongPaper, sendsPageSize, setAuto
  };

})(window.FM);
