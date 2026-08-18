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

  let inUse = [];                  // [{ name, label, silent }]
  let watcher = function () {};

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
      silent: true
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
      printers: inUse.map((p) => ({ name: p.name, label: p.label, silent: p.silent }))
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
          silent: r.silent !== false
        });
      });
    } else {
      // older per-photographer format
      const older = []
        .concat(Array.isArray(saved.photographers) ? saved.photographers.map((p) => p && p.printer) : [])
        .concat([saved.printer]);
      older.filter(Boolean).forEach((name) => {
        if (byName(name)) return;
        inUse.push({ name, label: shortLabel(name), silent: saved.silent !== false });
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
    add, remove, discover, toJSON, load, onChange
  };

})(window.FM);
