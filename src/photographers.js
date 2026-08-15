/* FastMike - photographers
 * ---------------------------------------------------------------------------
 * Spec sections 17 and 18. Several photographers work the same event from the
 * same laptop. Each one gets his own tab, his own set of photos, and his own
 * printer, so a print started by one of them never comes out of another one's
 * machine.
 *
 * Everything a photographer owns lives on his own record. The application
 * shell reads whichever record is active, which is why switching tabs is
 * instant and nothing has to be copied about.
 */

'use strict';

window.FM = window.FM || {};

(function (FM) {

  // Enough to tell three or four people apart at a glance across a busy room.
  const COLOURS = ['#e0523c', '#3b82f6', '#10b981', '#a855f7', '#f59e0b', '#06b6d4'];

  let people = [];
  let activeId = null;
  let seq = 0;
  let watcher = function () {};

  const newId = () => 'ph' + (++seq) + '-' + (people.length + 1);

  /** A photographer and everything he is working on. */
  function make(name, colour) {
    return {
      id: newId(),
      name: name,
      colour: colour || COLOURS[people.length % COLOURS.length],

      // his printer, chosen once at the start of the event and remembered
      printer: '',
      silent: true,

      // his own folder on the desktop - chosen once, then pulled from again
      // and again as new frames land in it
      folder: '',

      // his working set - the shell reads these through app.photos etc
      photos: [],
      selected: -1,
      edited: [],
      editedSelected: null
    };
  }

  function list() { return people; }

  function active() {
    return people.find((p) => p.id === activeId) || people[0];
  }

  function byId(id) { return people.find((p) => p.id === id) || null; }

  function setActive(id) {
    if (!byId(id) || id === activeId) return false;
    activeId = id;
    changed();
    return true;
  }

  /** Added but not switched to - the shell does that, so it can swap the view. */
  function add(name) {
    const p = make(name || ('Photographer ' + (people.length + 1)));
    people.push(p);
    changed();
    return p;
  }

  function rename(id, name) {
    const p = byId(id);
    if (!p) return false;
    name = String(name || '').trim();
    if (!name) return false;
    p.name = name.slice(0, 24);
    changed();
    return true;
  }

  function setPrinter(id, printer) {
    const p = byId(id);
    if (!p) return false;
    p.printer = printer || '';
    changed();
    return true;
  }

  function setFolder(id, folder) {
    const p = byId(id);
    if (!p) return false;
    p.folder = folder || '';
    changed();
    return true;
  }

  function setSilent(id, silent) {
    const p = byId(id);
    if (!p) return false;
    p.silent = !!silent;
    changed();
    return true;
  }

  /**
   * Remove a photographer. The last one cannot be removed - there always has to
   * be somebody to import into.
   */
  function remove(id) {
    if (people.length < 2) return false;
    const i = people.findIndex((p) => p.id === id);
    if (i < 0) return false;

    // let go of the print-ready images this photographer was holding
    people[i].edited.forEach((e) => { try { URL.revokeObjectURL(e.url); } catch (_) {} });

    people.splice(i, 1);
    if (activeId === id) activeId = people[Math.min(i, people.length - 1)].id;
    changed();
    return true;
  }

  /* ------------------------------------------------------------ persistence */

  /**
   * Only the setup is saved, never the photographs. An event can run for hours
   * and the app may be restarted in the middle of it; when it comes back the
   * photographers and their printers must still be there.
   */
  function toJSON() {
    return {
      photographers: people.map((p) => ({
        id: p.id, name: p.name, colour: p.colour,
        printer: p.printer, silent: p.silent, folder: p.folder
      })),
      activePhotographer: activeId
    };
  }

  /**
   * Rebuild from saved settings. Accepts the older single-printer format from
   * before this existed, so an upgrade does not lose the printer the operator
   * had already set up.
   */
  function load(saved) {
    saved = saved || {};
    people = [];
    seq = 0;

    const rows = Array.isArray(saved.photographers) ? saved.photographers : [];
    rows.forEach((r, i) => {
      const p = make(r.name || 'Photographer ' + (i + 1), r.colour);
      if (r.id) p.id = r.id;
      p.printer = r.printer || '';
      p.silent = r.silent !== false;
      p.folder = r.folder || '';
      people.push(p);
    });

    if (!people.length) {
      const p = make('Photographer 1');
      p.printer = saved.printer || '';                 // older single-printer setup
      p.silent = saved.silent !== false;
      people.push(p);
    }

    activeId = byId(saved.activePhotographer) ? saved.activePhotographer : people[0].id;
    changed();
  }

  function onChange(fn) { watcher = fn; }
  function changed() { watcher(); }

  FM.people = {
    COLOURS, list, active, byId, setActive, add, rename, remove,
    setPrinter, setSilent, setFolder, toJSON, load, onChange,
    get activeId() { return activeId; }
  };

})(window.FM);
