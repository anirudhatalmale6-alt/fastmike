/* FastMike - photographers
 * ---------------------------------------------------------------------------
 * Spec sections 17 and 18. Several photographers work the same event from the
 * same laptop. Each one gets his own tab, his own set of photos and his own
 * folder on the desktop.
 *
 * The printers are deliberately NOT owned by a photographer - see printers.js.
 * Any of them may want either machine at any moment, so every tab gets a button
 * for every printer.
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

      // his own folder on the desktop - chosen once, then pulled from again
      // and again as new frames land in it
      folder: '',

      // which folder of his he is looking at - null is all of them. Belongs to
      // him, so moving between tabs does not lose his place.
      view: null,

      // the branches he has closed in the tree on the left. Closed rather than
      // open, so a folder that lands mid-event shows up on its own.
      closed: new Set(),

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

  function setFolder(id, folder) {
    const p = byId(id);
    if (!p) return false;
    p.folder = folder || '';
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
   * photographers and their folders must still be there.
   */
  function toJSON() {
    return {
      photographers: people.map((p) => ({
        id: p.id, name: p.name, colour: p.colour, folder: p.folder
      })),
      activePhotographer: activeId
    };
  }

  /** Rebuild from saved settings. */
  function load(saved) {
    saved = saved || {};
    people = [];
    seq = 0;

    const rows = Array.isArray(saved.photographers) ? saved.photographers : [];
    rows.forEach((r, i) => {
      const p = make(r.name || 'Photographer ' + (i + 1), r.colour);
      if (r.id) p.id = r.id;
      p.folder = r.folder || '';
      people.push(p);
    });

    if (!people.length) people.push(make('Photographer 1'));

    activeId = byId(saved.activePhotographer) ? saved.activePhotographer : people[0].id;
    changed();
  }

  function onChange(fn) { watcher = fn; }
  function changed() { watcher(); }

  FM.people = {
    COLOURS, list, active, byId, setActive, add, rename, remove,
    setFolder, toJSON, load, onChange,
    get activeId() { return activeId; }
  };

})(window.FM);
