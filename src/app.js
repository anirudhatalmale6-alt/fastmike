/* FastMike - application shell
 * ---------------------------------------------------------------------------
 * State, interface and event wiring. The actual work is delegated:
 *   engine.js    preview rendering
 *   crop.js      crop positioning
 *   photos.js    image loading
 *   printing.js  print rendering, batching, output
 */

'use strict';

(function (FM) {

  const DESKTOP = FM.photos.DESKTOP;

  const ADJUSTMENTS = [
    { key: 'brightness', label: 'Brightness' },
    { key: 'highlights', label: 'Highlights' },
    { key: 'contrast',   label: 'Contrast'   },
    { key: 'shadows',    label: 'Shadows'    }
  ];

  const app = {
    clipboard: null,
    image: null,        // the untouched original - printing uses this
    preview: null,      // screen-sized copy of it - the stage uses this
    imageOf: null,
    loadToken: 0,
    frame: { x: 0, y: 0, w: 0, h: 0 },
    settings: {},
    seq: 0
  };

  /**
   * The working set belongs to whichever photographer's tab is open, so these
   * read straight off his record. Everything below carries on using app.photos
   * exactly as before and switching tabs costs nothing - no copying, no reload.
   */
  ['photos', 'selected', 'edited', 'editedSelected'].forEach((k) => {
    Object.defineProperty(app, k, {
      get() { return FM.people.active()[k]; },
      set(v) { FM.people.active()[k] = v; }
    });
  });

  FM.people.load({});   // one photographer until the saved settings arrive

  const nextId = (p) => p + ++app.seq;
  const $ = (id) => document.getElementById(id);

  const el = {
    stage: $('stage'),
    frame: $('frame'),
    hint: $('stageHint'),
    originals: $('originals'),
    edited: $('edited'),
    sliders: $('sliders'),
    origCount: $('origCount'),
    folderTree: $('folderTree'),
    peek: $('peek'),
    peekImg: $('peekImg'),
    peekName: $('peekName'),
    editCount: $('editCount'),
    fileInfo: $('fileInfo'),
    zoom: $('zoom'),
    toast: $('toast'),
    copiedTag: $('copiedTag'),
    printBar: $('printBar'),
    webPicker: $('webFilePicker'),
    frameFormat: $('frameFormat'),
    modal: $('modal'),
    modalTitle: $('modalTitle'),
    modalBody: $('modalBody'),
    tablist: $('tablist'),
    spooler: $('spooler'),
    spoolerBody: $('spoolerBody')
  };

  /* ------------------------------------------------------------- surfaces */

  function onDowngrade() {
    $('gpuNote').hidden = false;
    toast('Graphics acceleration unavailable - switched to software rendering. Same output, a little slower.', true);
  }

  const preview = new FM.Surface($('preview'), onDowngrade);
  const exporter = new FM.Surface(document.createElement('canvas'), onDowngrade, true);
  FM.printing.init(exporter);

  /* --------------------------------------------------------------- toast */

  let toastTimer = null;
  function toast(msg, isErr) {
    el.toast.textContent = msg;
    el.toast.className = 'toast' + (isErr ? ' err' : '');
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, isErr ? 5000 : 2000);
  }

  /* --------------------------------------------------------------- modal */

  function openModal(title, choices) {
    hidePeek();
    el.modalTitle.textContent = title;
    el.modalBody.innerHTML = '';
    el.modal.querySelector('.sheet').classList.remove('wide-sheet');
    choices.forEach((c) => {
      const b = document.createElement('button');
      b.className = 'btn ' + (c.primary ? 'btn-accent' : '') + ' wide';
      b.textContent = c.label;
      b.addEventListener('click', () => { closeModal(); c.run(); });
      el.modalBody.appendChild(b);
    });
    el.modal.hidden = false;
  }

  /** Same sheet, but asking for a word rather than a choice. */
  function openPrompt(title, value, okLabel, run) {
    el.modalTitle.textContent = title;
    el.modal.querySelector('.sheet').classList.remove('wide-sheet');
    el.modalBody.innerHTML =
      '<input type="text" class="sheet-input" id="sheetInput" maxlength="24">';
    const input = $('sheetInput');
    input.value = value || '';

    const ok = document.createElement('button');
    ok.className = 'btn btn-accent wide';
    ok.textContent = okLabel;
    ok.addEventListener('click', () => { const v = input.value; closeModal(); run(v); });
    el.modalBody.appendChild(ok);

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); ok.click(); }
    });

    el.modal.hidden = false;
    input.focus();
    input.select();
  }

  /** Same sheet again, but laid out by the caller rather than as a button list. */
  function openSheet(title, html, wire, wideSheet) {
    hidePeek();
    el.modalTitle.textContent = title;
    el.modalBody.innerHTML = html;
    el.modal.querySelector('.sheet').classList.toggle('wide-sheet', !!wideSheet);
    if (wire) wire(el.modalBody);
    el.modal.hidden = false;
  }

  function closeModal() { el.modal.hidden = true; }

  el.modal.addEventListener('click', (e) => {
    if (e.target === el.modal || e.target.hasAttribute('data-close')) closeModal();
  });

  /* ------------------------------------------------------------- geometry */

  /**
   * How many device pixels the stage canvas is given.
   *
   * Normally one for one with the screen. If a drag turns out to be slow on
   * this particular machine the canvas is quietly given fewer pixels for the
   * duration of the drag and put back at full resolution the moment the mouse
   * is released, so panning stays responsive on weak laptop graphics instead of
   * crawling. Nothing that gets printed is affected.
   */
  const SLOW_FRAME_MS = 26;      // roughly below 38 frames a second
  let interactiveScale = 1;      // stays 1 until this machine proves it is slow
  let renderScale = 1;

  function pixelRatio() {
    return (window.devicePixelRatio || 1) * renderScale;
  }

  function layout() {
    const sw = el.stage.clientWidth;
    const sh = el.stage.clientHeight;
    const f = FM.crop.frameIn(sw, sh, current());
    app.frame = f;

    el.frame.style.left = f.x + 'px';
    el.frame.style.top = f.y + 'px';
    el.frame.style.width = f.w + 'px';
    el.frame.style.height = f.h + 'px';

    const dpr = pixelRatio();
    const w = Math.max(1, Math.round(sw * dpr));
    const h = Math.max(1, Math.round(sh * dpr));
    // resizing a canvas throws away its contents, so only do it when it changed
    if (preview.canvas.width !== w || preview.canvas.height !== h) {
      preview.canvas.width = w;
      preview.canvas.height = h;
    }
  }

  function setRenderScale(s) {
    if (renderScale === s) return;
    renderScale = s;
    layout();
    draw();
  }

  const current = () => (app.selected >= 0 ? app.photos[app.selected] : null);

  /* --------------------------------------------------------------- render */

  let rafPending = false;
  function render() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      draw();
    });
  }

  const perf = { frames: 0, slow: 0, last: 0, fps: 0 };

  function draw() {
    const t0 = performance.now();
    const p = current();
    if (!p || !app.preview) {
      preview.releaseImage();
      preview.draw({ x: 0, y: 0, w: 0, h: 0 }, FM.photos.NEUTRAL);
      return;
    }
    const dpr = pixelRatio();
    const r = FM.crop.photoRect(p, app.frame);
    preview.setImage(app.preview);
    preview.draw({ x: r.x * dpr, y: r.y * dpr, w: r.w * dpr, h: r.h * dpr }, p.state);

    if (perf.last) perf.fps = Math.round(1000 / Math.max(1, t0 - perf.last));
    perf.last = t0;
    perf.frames++;
    if (diag.hidden === false) showDiagnostics();
    return performance.now() - t0;
  }

  /* ---------------------------------------------------------- diagnostics */

  /**
   * F2 shows what the renderer is actually doing. There is no way to guess how
   * a particular laptop behaves from here, so this is the quickest way to find
   * out: drag a photo with it open and read off the frame rate.
   */
  const diag = document.createElement('div');
  diag.className = 'diag';
  diag.hidden = true;
  el.stage.appendChild(diag);

  function showDiagnostics() {
    const p = current();
    const d = app.preview
      ? (app.preview.naturalWidth || app.preview.width) + '×' +
        (app.preview.naturalHeight || app.preview.height)
      : '—';
    diag.textContent =
      'renderer: ' + (preview.mode === 'gl' ? 'graphics card' : 'software (CPU)') +
      '\nframes/sec while moving: ' + (perf.fps || '—') +
      '\ncanvas: ' + preview.canvas.width + '×' + preview.canvas.height +
      '  (scale ' + renderScale.toFixed(2) + ')' +
      '\npreview image: ' + d +
      '\noriginal: ' + (p ? p.w + '×' + p.h : '—') +
      '\nscreen scaling: ' + (window.devicePixelRatio || 1);
  }

  /* --------------------------------------------------------------- import */

  async function addPhotos(entries) {
    if (!entries || !entries.length) return;
    const { made, failed } = await FM.photos.build(entries, () => nextId('p'));
    app.photos.push(...made);
    renderOriginals();
    if (app.selected < 0) {
      const vis = visibleIndexes();
      if (vis.length) selectPhoto(vis[0]);
    }
    toast(made.length + ' photo' + (made.length === 1 ? '' : 's') + ' imported' +
          (failed ? ' (' + failed + ' skipped)' : ''));
  }

  async function importFiles() {
    let picked;
    try {
      picked = await FM.photos.pickFiles(el.webPicker);
    } catch (err) {
      return toast('Import Photos failed: ' + err.message, true);
    }
    if (picked && picked.error) return toast(picked.error, true);
    if (picked) await addPhotos(picked);
  }

  /**
   * Choose this photographer's folder. It is remembered against his tab, so
   * from then on new frames come in with one click and no file browser.
   */
  async function importFolder() {
    let picked;
    try {
      picked = await FM.photos.pickFolder();
    } catch (err) {
      // never leave the button looking dead - say what went wrong
      return toast('Import Folder failed: ' + err.message, true);
    }
    if (!picked) {
      if (!DESKTOP) toast('Folder import is available in the desktop build', true);
      return;                           // on the desktop this is simply Cancel
    }
    if (picked.error) return toast(picked.error, true);

    const who = FM.people.active();
    FM.people.setFolder(who.id, picked.dir);
    who.view = null;                    // a new folder - show all of it first
    syncFolderButton();
    saveSettings();

    if (!picked.files.length) {
      renderOriginals();
      return toast('There are no photos in ' + FM.photos.folderName(picked.dir) +
                   ' or in the folders inside it', true);
    }
    await addPhotos(onlyNew(picked.files));

    const subs = (picked.groups || []).filter((g) => g.name).length;
    if (subs) {
      openAllBranches();              // a folder just picked shows what is in it
      renderFolderTree();
      toast(subs + ' folder' + (subs === 1 ? '' : 's') + ' found - they are listed above the photos');
    }
  }

  /** Everything in the folder that is not already on this photographer's tab. */
  function onlyNew(files) {
    const have = new Set(app.photos.map((p) => p.path).filter(Boolean));
    return (files || []).filter((f) => !have.has(f.path));
  }

  /** Read his folder again - only what has landed in it since last time. */
  async function importAgain() {
    const who = FM.people.active();
    if (!who.folder) return;

    const res = await FM.photos.readFolder(who.folder);
    if (!res || res.missing) {
      return toast('Cannot find ' + who.folder + ' any more - pick the folder again', true);
    }
    const fresh = onlyNew(res.files);
    if (!fresh.length) {
      return toast('Nothing new in ' + FM.photos.folderName(who.folder) + ' yet');
    }
    await addPhotos(fresh);
  }

  function syncFolderButton() {
    const who = FM.people.active();
    const btn = $('btnImportAgain');
    const note = $('folderNote');
    const has = DESKTOP && !!who.folder;

    btn.hidden = !has;
    note.hidden = !has;
    if (has) {
      note.textContent = who.name + "'s folder: " + FM.photos.folderWhere(who.folder);
      note.title = who.folder;
    }
  }

  el.webPicker.addEventListener('change', async () => {
    const files = Array.from(el.webPicker.files || []);
    await addPhotos(files.map((f) => ({ name: f.name, url: URL.createObjectURL(f) })));
    el.webPicker.value = '';
  });

  /* -------------------------------------------------------- photographers */

  /**
   * Spec 17 / 18. The tab strip is the whole feature as far as the operator is
   * concerned: click a name and you are looking at that photographer's photos,
   * and anything you print goes to his printer.
   */
  function renderTabs() {
    const activeId = FM.people.activeId;
    const many = FM.people.list().length > 1;

    el.tablist.innerHTML = FM.people.list().map((p) => {
      const waiting = p.edited.length;
      return `
      <div class="tab${p.id === activeId ? ' on' : ''}" data-id="${p.id}"
           title="${escapeHtml(p.name)}${p.folder ? ' - ' + escapeHtml(FM.photos.folderName(p.folder)) : ''}\nDouble-click to rename">
        <span class="dot" style="background:${p.colour}"></span>
        <span class="tab-name">${escapeHtml(p.name)}</span>
        ${waiting ? `<span class="tab-count">${waiting}</span>` : ''}
        ${many ? `<button class="tab-x" data-remove="${p.id}" title="Remove ${escapeHtml(p.name)}">&times;</button>` : ''}
      </div>`;
    }).join('');

    el.tablist.querySelectorAll('.tab').forEach((n) => {
      n.addEventListener('click', (ev) => {
        if (ev.target.closest('[data-remove]')) return;
        switchTo(n.dataset.id);
      });
      n.addEventListener('dblclick', (ev) => {
        if (ev.target.closest('[data-remove]')) return;
        renamePerson(n.dataset.id);
      });
    });

    el.tablist.querySelectorAll('[data-remove]').forEach((n) => {
      n.addEventListener('click', (ev) => {
        ev.stopPropagation();
        removePerson(n.dataset.remove);
      });
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /**
   * Switch tab. The decoded bitmaps belong to the photo that was on screen, so
   * they are dropped - the new tab loads its own selection from disk.
   */
  function switchTo(id) {
    if (!FM.people.setActive(id)) return;
    app.image = null;
    app.preview = null;
    app.imageOf = null;
    app.loadToken++;
    hidePeek();

    renderTabs();
    renderOriginals();
    renderEdited();
    syncFolderButton();

    // he may have been looking at D3 when he left this tab - go back to it
    const vis = visibleIndexes();
    const i = vis.indexOf(app.selected) >= 0 ? app.selected : (vis.length ? vis[0] : -1);
    if (i >= 0) {
      app.selected = -1;              // force selectPhoto to do its work
      selectPhoto(i);
    } else {
      el.fileInfo.textContent = '—';
      syncSliders();
      syncFrameLabel();
      layout();
      render();
    }
    saveSettings();
  }

  function addPerson() {
    openPrompt('Add photographer', 'Photographer ' + (FM.people.list().length + 1), 'Add', (name) => {
      const p = FM.people.add(name);
      renderTabs();
      switchTo(p.id);
      renderOriginals();
      renderEdited();
      toast(p.name + ' added - point him at his folder on the left');
    });
  }

  function renamePerson(id) {
    const p = FM.people.byId(id);
    if (!p) return;
    openPrompt('Rename photographer', p.name, 'Rename', (name) => {
      if (FM.people.rename(id, name)) { renderTabs(); syncFolderButton(); saveSettings(); }
    });
  }

  function removePerson(id) {
    const p = FM.people.byId(id);
    if (!p) return;
    const n = p.photos.length + p.edited.length;
    openModal('Remove ' + p.name + '?', [
      {
        label: n ? 'Remove and discard his ' + n + ' photo(s)' : 'Remove',
        primary: true,
        run: () => {
          const wasActive = FM.people.activeId === id;
          if (!FM.people.remove(id)) return;
          renderTabs();
          if (wasActive) {
            app.image = null;
            app.preview = null;
            app.imageOf = null;
            app.loadToken++;
            renderOriginals();
            renderEdited();
            syncFolderButton();
            const vis = visibleIndexes();
            if (vis.length) {
              const i = vis.indexOf(app.selected) >= 0 ? app.selected : vis[0];
              app.selected = -1;
              selectPhoto(i);
            }
            else { el.fileInfo.textContent = '—'; syncSliders(); render(); }
          }
          saveSettings();
          toast(p.name + ' removed');
        }
      }
    ]);
  }

  /* ------------------------------------------------------- folders on the left */

  /**
   * The subfolders this photographer's photos came out of, in the order they
   * were read - D1, D2, D3...
   *
   * Worked out from the photos themselves rather than kept as separate state,
   * so pressing Get New Photos halfway through the night cannot leave the two
   * disagreeing with each other.
   */
  function folderGroups() {
    const order = [];
    const count = {};
    app.photos.forEach((p) => {
      const g = p.group || '';
      if (!(g in count)) { count[g] = 0; order.push(g); }
      count[g]++;
    });
    return order.map((g) => ({ name: g, count: count[g] }));
  }

  /** Is this photo inside the folder on show, or inside one of its subfolders? */
  function inView(photo, view) {
    if (view == null) return true;
    const g = photo.group || '';
    return g === view || (view !== '' && g.indexOf(view + '/') === 0);
  }

  /** Absolute positions in app.photos of the photos currently on show. */
  function visibleIndexes() {
    const view = FM.people.active().view;
    const out = [];
    app.photos.forEach((p, i) => { if (inView(p, view)) out.push(i); });
    return out;
  }

  /**
   * The tree of folders his photos came out of.
   *
   * Built from the paths themselves, so a folder that holds nothing but other
   * folders - "Dimitris", with D1..D5 inside it - still gets a branch of its own
   * to open and close, exactly as it looks in a file browser.
   */
  function folderTree() {
    const byPath = {};
    const roots = [];

    const node = (path) => {
      if (byPath[path]) return byPath[path];
      const cut = path.lastIndexOf('/');
      const n = byPath[path] = {
        path,
        label: cut < 0 ? path : path.slice(cut + 1),
        count: 0,                    // photos in it, and in everything under it
        kids: []
      };
      if (cut < 0) roots.push(n);
      else node(path.slice(0, cut)).kids.push(n);
      return n;
    };

    folderGroups().forEach((g) => {
      if (!g.name) return;           // loose photos belong to the folder itself
      node(g.name);
    });

    // counts run upwards - a folder shows everything beneath it, like Explorer
    app.photos.forEach((p) => {
      let at = p.group || '';
      while (at) {
        if (byPath[at]) byPath[at].count++;
        const cut = at.lastIndexOf('/');
        at = cut < 0 ? '' : at.slice(0, cut);
      }
    });
    return roots;
  }

  /**
   * The folder tree down the left, above the photos.
   *
   * A photographer who just points at a plain folder full of photos never sees
   * this at all - there is nothing to navigate.
   */
  function renderFolderTree() {
    const who = FM.people.active();
    const roots = folderTree();

    if (!roots.length) {
      el.folderTree.hidden = true;
      el.folderTree.innerHTML = '';
      return;
    }
    if (!who.closed) who.closed = new Set();

    const loose = app.photos.filter((p) => !p.group).length;
    const rows = [];

    // The folder he picked, at the top - clicking it shows the whole night.
    // It carries its own attribute rather than a reserved path, so a folder of
    // his is free to be named anything at all.
    rows.push(row({
      attr: 'data-all="1"',
      label: FM.photos.folderName(who.folder) || 'All photos',
      count: app.photos.length,
      depth: 0,
      on: who.view == null,
      fixed: true                     // the top of the tree does not fold away
    }));
    if (loose) {
      rows.push(row({
        attr: 'data-folder=""',
        label: 'Loose photos',
        count: loose,
        depth: 1,
        on: who.view === '',
        openable: false
      }));
    }

    const walk = (nodes, depth) => {
      nodes.forEach((n) => {
        const open = !who.closed.has(n.path);
        rows.push(row({
          attr: 'data-folder="' + escapeHtml(n.path) + '"',
          label: n.label,
          count: n.count,
          depth,
          on: who.view === n.path,
          openable: n.kids.length > 0,
          open
        }));
        if (n.kids.length && open) walk(n.kids, depth + 1);
      });
    };
    walk(roots, 1);

    el.folderTree.innerHTML = rows.join('');
    el.folderTree.hidden = false;

    el.folderTree.querySelectorAll('.frow').forEach((n) => {
      n.addEventListener('click', () =>
        switchFolder(n.hasAttribute('data-all') ? null : n.dataset.folder));
    });
    el.folderTree.querySelectorAll('.ftwist:not(.blank):not(.fixed)').forEach((n) => {
      n.addEventListener('click', (e) => {
        e.stopPropagation();          // opening a branch is not choosing it
        toggleBranch(n.parentElement.dataset.folder);
      });
    });
  }

  const FOLDER_ICON =
    '<svg class="fico" viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M1.5 3.2h4.1l1.3 1.6h7.6c.4 0 .7.3.7.7v7.3c0 .4-.3.7-.7.7H1.5a.7.7 0 0 1-.7-.7V3.9c0-.4.3-.7.7-.7z"/></svg>';

  function row(o) {
    const twist = o.fixed
      ? '<span class="ftwist fixed">&#9662;</span>'
      : o.openable
        ? '<span class="ftwist" title="' + (o.open ? 'Close' : 'Open') + '">' +
          (o.open ? '&#9662;' : '&#9656;') + '</span>'
        : '<span class="ftwist blank"></span>';
    return (
      '<div class="frow' + (o.on ? ' on' : '') + '" ' + o.attr +
      ' style="padding-left:' + (4 + o.depth * 14) + 'px"' +
      ' title="' + escapeHtml(o.label) + ' - ' + o.count +
      ' photo' + (o.count === 1 ? '' : 's') + '">' +
      twist + FOLDER_ICON +
      '<span class="fname">' + escapeHtml(o.label) + '</span>' +
      '<span class="fcount">' + o.count + '</span></div>'
    );
  }

  function toggleBranch(path) {
    const who = FM.people.active();
    if (!who.closed) who.closed = new Set();
    if (who.closed.has(path)) who.closed.delete(path);
    else who.closed.add(path);
    renderFolderTree();
  }

  /** Open every branch again - a folder just picked shows all of what is in it. */
  function openAllBranches() {
    FM.people.active().closed = new Set();
  }

  function switchFolder(name) {
    const who = FM.people.active();
    if (who.view === name) return;
    who.view = name;
    hidePeek();
    renderFolderTree();
    renderOriginals();

    // land on something in the folder just opened rather than leaving the
    // editing area showing a photo from the previous one
    const vis = visibleIndexes();
    if (vis.length && vis.indexOf(app.selected) < 0) selectPhoto(vis[0]);
  }

  /* ---------------------------------------------------------- originals UI */

  function renderOriginals() {
    el.origCount.textContent = app.photos.length;
    renderFolderTree();

    if (!app.photos.length) {
      el.originals.innerHTML = '<div class="empty"><p>No photos yet</p></div>';
      return;
    }

    const vis = visibleIndexes();
    if (!vis.length) {
      el.originals.innerHTML = '<div class="empty"><p>Nothing in this folder</p></div>';
      return;
    }

    const done = new Set(app.edited.map((e) => e.srcId));
    el.originals.innerHTML = vis.map((i, at) => {
      const p = app.photos[i];
      return `
      <div class="thumb${i === app.selected ? ' selected' : ''}${done.has(p.id) ? ' edited-done' : ''}"
           data-i="${i}" title="${escapeHtml(p.name)}">
        <img src="${p.thumb}" alt="">
        <span class="no">${at + 1}</span>
        <span class="done">&#10003;</span>
      </div>`;
    }).join('');

    el.originals.querySelectorAll('.thumb').forEach((n) => {
      const i = +n.dataset.i;
      n.addEventListener('click', () => { hidePeek(); selectPhoto(i); });
      n.addEventListener('mouseenter', (e) => peekLater(i, e.clientY));
      n.addEventListener('mousemove', (e) => { if (peekOf === i) placePeek(e.clientY); });
      n.addEventListener('mouseleave', hidePeek);
    });
  }

  /**
   * The list scrolling under a stationary mouse means a different photograph is
   * now beneath it. Re-aiming beats hiding: he wheels down the strip with the
   * pointer resting on it and the preview keeps up instead of going blank.
   */
  let lastPointer = { x: 0, y: 0 };
  el.originals.addEventListener('mousemove', (e) => {
    lastPointer = { x: e.clientX, y: e.clientY };
  });

  el.originals.addEventListener('scroll', () => {
    const under = document.elementFromPoint(lastPointer.x, lastPointer.y);
    const thumb = under && under.closest ? under.closest('.thumb') : null;
    if (!thumb) return hidePeek();

    const i = +thumb.dataset.i;
    if (i === peekOf) return placePeek(lastPointer.y);
    hidePeek();
    peekLater(i, lastPointer.y);
  });

  function markSelection() {
    el.originals.querySelectorAll('.thumb').forEach((n) => {
      n.classList.toggle('selected', +n.dataset.i === app.selected);
    });
    const node = el.originals.querySelector('.thumb.selected');
    if (node) node.scrollIntoView({ block: 'nearest' });
  }

  /* ------------------------------------------------------------ hover peek */

  /**
   * Hovering a thumbnail brings the photograph up large next to the list.
   *
   * A thumbnail is 320 pixels - enough to find a photo you already know, not
   * enough to decide whether the shot is any good. This answers that without
   * selecting the photo and losing the crop that is already set up on screen.
   *
   * The large copy is made once per photograph and kept on its record. The
   * thumbnail goes up immediately so the window never appears empty, and is
   * replaced the moment the real one is ready.
   */
  const PEEK_MAX = 720;        // long edge of the large copy
  const PEEK_DELAY = 160;      // ms - running the mouse down the list must not load anything

  let peekTimer = null;
  let peekToken = 0;
  let peekOf = -1;

  function peekLater(i, y) {
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => showPeek(i, y), PEEK_DELAY);
  }

  function hidePeek() {
    clearTimeout(peekTimer);
    peekToken++;
    peekOf = -1;
    el.peek.hidden = true;
  }

  async function showPeek(i, y) {
    const p = app.photos[i];
    // a sheet is open, or the photo went away while the timer was running
    if (!p || !el.modal.hidden || !el.spooler.hidden) return;

    peekOf = i;
    el.peekImg.src = p.peek || p.thumb;
    el.peekName.textContent = p.name + '  ·  ' + p.w + ' × ' + p.h;
    el.peek.hidden = false;
    placePeek(y);

    if (p.peek) return;

    const token = ++peekToken;
    try {
      const img = await FM.photos.openImage(p);
      if (token !== peekToken) return;          // the mouse has moved on
      p.peek = FM.photos.makeThumb(img, PEEK_MAX, PEEK_MAX);
      if (peekOf === i) { el.peekImg.src = p.peek; placePeek(y); }
    } catch (_) {
      // the thumbnail is already showing - nothing useful to say here
    }
  }

  /** Beside the list, level with the mouse, never off the top or bottom. */
  function placePeek(y) {
    const strip = el.originals.getBoundingClientRect();
    const box = el.peek.getBoundingClientRect();
    const top = Math.max(8, Math.min(window.innerHeight - box.height - 8, y - box.height / 2));
    el.peek.style.left = Math.round(strip.right + 10) + 'px';
    el.peek.style.top = Math.round(top) + 'px';
  }

  async function selectPhoto(i) {
    if (i < 0 || i >= app.photos.length) return;
    app.selected = i;
    markSelection();

    const p = app.photos[i];
    el.fileInfo.textContent = p.name + '  ·  ' + p.w + ' × ' + p.h;
    syncSliders();
    syncFrameLabel();
    el.zoom.value = Math.round(p.state.zoom * 100);
    layout();

    const token = ++app.loadToken;
    try {
      const img = await FM.photos.openImage(p);
      if (token !== app.loadToken) return;   // a newer selection won the race
      app.image = img;
      app.preview = FM.photos.previewCopy(img);
      app.imageOf = p.id;
      FM.crop.clampPan(p, app.frame);
      render();
    } catch (err) {
      toast('Could not open ' + p.name, true);
    }
  }

  /** Next / previous within the folder on show, not across the whole tab. */
  function step(delta) {
    const vis = visibleIndexes();
    if (!vis.length) return;
    const at = vis.indexOf(app.selected);
    const to = at < 0 ? 0 : Math.min(vis.length - 1, Math.max(0, at + delta));
    if (vis[to] !== app.selected) selectPhoto(vis[to]);
  }

  /* ------------------------------------------------------------- sliders */

  const RESET_SVG = '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.5-5.8M4 4v4h4"/></svg>';

  function buildSliders() {
    el.sliders.innerHTML = ADJUSTMENTS.map((a) => `
      <div class="slider-row" data-key="${a.key}">
        <div class="slider-top">
          <span class="name">${a.label}</span>
          <button class="reset-ico" data-reset="${a.key}" title="Reset ${a.label}" aria-label="Reset ${a.label}">${RESET_SVG}</button>
          <span class="val" data-val="${a.key}">0</span>
        </div>
        <input type="range" min="-100" max="100" value="0" step="1" data-slider="${a.key}"
               title="Mouse wheel over this slider also works">
      </div>`).join('');

    el.sliders.querySelectorAll('[data-slider]').forEach((input) => {
      const key = input.dataset.slider;
      input.addEventListener('input', () => setAdjust(key, +input.value));
      input.addEventListener('dblclick', () => setAdjust(key, 0));
      // wheel over the slider adjusts it - no need to grab the handle
      input.addEventListener('wheel', (e) => {
        if (!current()) return;
        e.preventDefault();
        const stepBy = e.shiftKey ? 5 : 1;
        setAdjust(key, +input.value + (e.deltaY < 0 ? stepBy : -stepBy));
      }, { passive: false });
    });

    el.sliders.querySelectorAll('[data-reset]').forEach((btn) => {
      btn.addEventListener('click', () => setAdjust(btn.dataset.reset, 0));
    });
  }

  /** Single place that writes an adjustment, so UI and render never diverge. */
  function setAdjust(key, val) {
    const p = current();
    if (!p) return;
    val = Math.max(-100, Math.min(100, Math.round(val)));
    p.state[key] = val / 100;
    const input = el.sliders.querySelector(`[data-slider="${key}"]`);
    input.value = val;
    updateRow(key, val);
    render();
  }

  function updateRow(key, val) {
    const row = el.sliders.querySelector(`.slider-row[data-key="${key}"]`);
    row.classList.toggle('touched', val !== 0);
    row.querySelector(`[data-val="${key}"]`).textContent = val > 0 ? '+' + val : String(val);
  }

  function syncSliders() {
    const p = current();
    ADJUSTMENTS.forEach((a) => {
      const val = p ? Math.round(p.state[a.key] * 100) : 0;
      el.sliders.querySelector(`[data-slider="${a.key}"]`).value = val;
      updateRow(a.key, val);
    });
  }

  /* -------------------------------------------------- copy / paste (keys) */

  function copySettings() {
    const p = current();
    if (!p) return toast('Select a photo first', true);
    app.clipboard = {};
    ADJUSTMENTS.forEach((a) => { app.clipboard[a.key] = p.state[a.key]; });
    el.copiedTag.hidden = false;
    toast('Adjustments copied');
  }

  function pasteSettings() {
    const p = current();
    if (!p) return;
    if (!app.clipboard) return toast('Nothing copied yet - press Ctrl+C first', true);
    ADJUSTMENTS.forEach((a) => { p.state[a.key] = app.clipboard[a.key]; });
    syncSliders();
    render();
    toast('Adjustments applied');
  }

  /* --------------------------------------------------- pan / zoom / frame */

  let drag = null;

  el.stage.addEventListener('pointerdown', (e) => {
    if (!current()) return;
    el.stage.setPointerCapture(e.pointerId);
    el.stage.classList.add('dragging');
    el.hint.style.opacity = 0;
    const p = current();
    drag = { x: e.clientX, y: e.clientY, tx: p.state.tx, ty: p.state.ty, t: 0, slow: 0 };
    if (interactiveScale !== 1) setRenderScale(interactiveScale);
  });

  el.stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = current();
    p.state.tx = drag.tx + (e.clientX - drag.x) / app.frame.w;
    p.state.ty = drag.ty + (e.clientY - drag.y) / app.frame.h;
    FM.crop.clampPan(p, app.frame);
    render();

    // If this machine cannot keep up, hand the canvas fewer pixels for the
    // rest of the drag rather than letting the photo stutter under the mouse.
    const now = performance.now();
    if (drag.t) {
      const gap = now - drag.t;
      drag.slow = gap > SLOW_FRAME_MS ? drag.slow + 1 : 0;
      if (drag.slow >= 6 && interactiveScale === 1) {
        interactiveScale = 0.6;
        setRenderScale(interactiveScale);
      }
    }
    drag.t = now;
  });

  function endDrag(e) {
    if (!drag) return;
    drag = null;
    el.stage.classList.remove('dragging');
    setRenderScale(1);          // back to full resolution the instant it stops
    try { el.stage.releasePointerCapture(e.pointerId); } catch (_) {}
  }
  el.stage.addEventListener('pointerup', endDrag);
  el.stage.addEventListener('pointercancel', endDrag);

  /**
   * Wheel over the photo. A modifier takes over the wheel completely, so it
   * never zooms and adjusts at the same time. All four adjustments are on the
   * wheel - see WHEEL_KEYS, which is the one place the pairing is decided.
   */
  const WHEEL_KEYS = [
    { ctrl: true,  alt: true,  shift: false, key: 'highlights' },  // Ctrl+Alt
    { ctrl: true,  alt: false, shift: false, key: 'brightness' },  // Ctrl
    { ctrl: false, alt: true,  shift: false, key: 'shadows'    },  // Alt
    { ctrl: false, alt: false, shift: true,  key: 'contrast'   }   // Shift
  ];

  function wheelKeyFor(e) {
    const hit = WHEEL_KEYS.find((m) =>
      m.ctrl === !!(e.ctrlKey || e.metaKey) && m.alt === !!e.altKey && m.shift === !!e.shiftKey);
    return hit ? hit.key : null;
  }

  el.stage.addEventListener('wheel', (e) => {
    const p = current();
    if (!p) return;
    e.preventDefault();
    el.hint.style.opacity = 0;

    const dir = e.deltaY < 0 ? 1 : -1;

    const adjust = wheelKeyFor(e);
    if (adjust) {
      setAdjust(adjust, Math.round(p.state[adjust] * 100) + dir * 2);
      return;
    }

    const box = el.stage.getBoundingClientRect();
    FM.crop.zoomBy(p, app.frame, dir > 0 ? 1.1 : 1 / 1.1,
                   { x: e.clientX - box.left, y: e.clientY - box.top });
    el.zoom.value = Math.round(p.state.zoom * 100);
    render();
  }, { passive: false });

  el.stage.addEventListener('dblclick', fit);

  function setZoom(z) {
    const p = current();
    if (!p) return;
    FM.crop.zoomBy(p, app.frame, z / p.state.zoom, null);
    el.zoom.value = Math.round(p.state.zoom * 100);
    render();
  }

  function fit() {
    const p = current();
    if (!p) return;
    FM.crop.fit(p);
    el.zoom.value = 100;
    render();
  }

  function rotateFrame() {
    const p = current();
    if (!p) return toast('Select a photo first', true);
    p.state.landscape = !p.state.landscape;
    FM.crop.fit(p);
    layout();
    el.zoom.value = 100;
    syncFrameLabel();
    render();
  }

  function syncFrameLabel() {
    const p = current();
    el.frameFormat.textContent = p && p.state.landscape
      ? '20 × 15 landscape'
      : '15 × 20 portrait';
  }

  /* --------------------------------------------------------- edited photos */

  async function addToEdited() {
    const p = current();
    if (!p) return toast('Select a photo first', true);

    // always the untouched original, never the screen-sized preview copy
    const img = app.image && app.imageOf === p.id
      ? app.image
      : await FM.photos.openImage(p);

    const { blob, wMm, hMm } = await FM.printing.renderToPrint(p, img);
    const base = p.name.replace(/\.[^.]+$/, '');

    app.edited.push({
      id: nextId('e'),
      srcId: p.id,
      name: base + '_print.jpg',
      blob,
      url: URL.createObjectURL(blob),
      wMm,
      hMm
    });

    renderEdited();
    renderOriginals();
    toast('Added to edited');

    // straight on to the next photo - this is the whole point of the app
    step(1);
  }

  const PRINT_SVG =
    '<svg viewBox="0 0 24 24"><path d="M7 9V3h10v6M7 19H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M7 15h10v6H7z"/></svg>';

  function renderEdited() {
    el.editCount.textContent = app.edited.length;
    renderTabs();               // the tab badge counts what is waiting to print

    if (!app.edited.length) {
      el.edited.innerHTML = '<div class="empty small"><p>Edited photos appear here &mdash; two rows of five</p></div>';
      return;
    }

    el.edited.innerHTML = app.edited.map((e, i) => `
      <div class="echip${e.id === app.editedSelected ? ' selected' : ''}${e.hMm < e.wMm ? ' land' : ''}"
           data-id="${e.id}" title="${e.name}">
        <img src="${e.url}" alt="">
        <span class="no">${i + 1}</span>
        <button class="chip-btn print" data-print="${e.id}" title="Print this photo">${PRINT_SVG}</button>
        <button class="chip-btn del" data-del="${e.id}" title="Remove">&times;</button>
        <span class="lbl">${e.name}</span>
      </div>`).join('');

    el.edited.querySelectorAll('.echip').forEach((n) => {
      n.addEventListener('click', (ev) => {
        if (ev.target.closest('[data-print]') || ev.target.closest('[data-del]')) return;
        app.editedSelected = n.dataset.id;
        el.edited.querySelectorAll('.echip').forEach((m) =>
          m.classList.toggle('selected', m.dataset.id === app.editedSelected));
      });
    });

    el.edited.querySelectorAll('[data-print]').forEach((n) => {
      n.addEventListener('click', (ev) => {
        ev.stopPropagation();
        askCopies(app.edited.find((x) => x.id === n.dataset.print));
      });
    });

    el.edited.querySelectorAll('[data-del]').forEach((n) => {
      n.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const i = app.edited.findIndex((x) => x.id === n.dataset.del);
        if (i < 0) return;
        URL.revokeObjectURL(app.edited[i].url);
        app.edited.splice(i, 1);
        renderEdited();
        renderOriginals();
      });
    });
  }

  function clearEdited() {
    if (!app.edited.length) return;
    app.edited.forEach((e) => URL.revokeObjectURL(e.url));
    app.edited = [];
    app.editedSelected = null;
    renderEdited();
    renderOriginals();
  }

  function clearAll() {
    if (!app.photos.length && !app.edited.length) return;
    // only the photographer whose tab is open - the others keep working
    openModal('Clear ' + FM.people.active().name + "'s photos?", [
      {
        label: 'Clear them', primary: true, run: () => {
          clearEdited();
          app.photos = [];
          app.selected = -1;
          app.image = null;
          app.preview = null;
          app.imageOf = null;
          FM.people.active().view = null;
          hidePeek();
          renderOriginals();
          el.fileInfo.textContent = '—';
          syncSliders();
          render();
          toast('Session cleared');
        }
      }
    ]);
  }

  /* -------------------------------------------------------------- printing */

  const COPIES = [1, 2, 3, 4, 5];

  /**
   * One photo, sent on its own.
   *
   * Both questions are answered with one click - which machine, and how many.
   * Which machine matters because the DNP may already have ten pages queued
   * while the Citizen is standing idle.
   */
  function askCopies(entry) {
    if (!entry) return;
    const printers = FM.printers.list();

    if (!printers.length) {
      return openModal('Print ' + entry.name, COPIES.map((n) => ({
        label: n === 1 ? '1 copy' : n + ' copies',
        primary: n === 1,
        run: () => doPrint([{ ...entry, copies: n }], n + ' × ' + entry.name, '')
      })));
    }

    const html = printers.map((p, i) => `
      <div class="pick-row">
        <div class="pick-name">${escapeHtml(p.label)}</div>
        <div class="pick-btns">
          ${COPIES.map((n) => `<button class="btn sq${n === 1 ? ' btn-accent' : ''}"
             data-p="${i}" data-n="${n}" title="${n} cop${n === 1 ? 'y' : 'ies'} on ${escapeHtml(p.label)}">${n}</button>`).join('')}
        </div>
      </div>`).join('');

    openSheet('Print ' + entry.name,
      html + '<p class="hint sheet-hint">Pick the printer and the number of copies.</p>',
      (body) => {
        body.querySelectorAll('[data-n]').forEach((b) => {
          b.addEventListener('click', () => {
            const printer = printers[+b.dataset.p];
            const n = +b.dataset.n;
            closeModal();
            doPrint([{ ...entry, copies: n }], n + ' × ' + entry.name, printer.name);
          });
        });
      });
  }

  /** The whole Edited set, to whichever printer's button was pressed. */
  function printAll(printerName) {
    if (!app.edited.length) return toast('Nothing in Edited Photos yet', true);

    const where = FM.printers.count() ? ' on ' + FM.printers.labelFor(printerName) : '';
    const groups = FM.printing.groups(app.edited.length);

    // fewer than a full group - just print, no questions asked
    if (groups.length < 2) {
      return doPrint(app.edited.map((e) => ({ ...e, copies: 1 })),
                     app.edited.length + ' photo(s)', printerName);
    }

    const choices = groups.map((g) => ({
      label: 'Print ' + g.from + '–' + g.to,
      run: () => doPrint(app.edited.slice(g.start, g.end).map((e) => ({ ...e, copies: 1 })),
                         'photos ' + g.from + '–' + g.to, printerName)
    }));
    choices.push({
      label: 'Print All (' + app.edited.length + ')',
      primary: true,
      run: () => doPrint(app.edited.map((e) => ({ ...e, copies: 1 })),
                         'all ' + app.edited.length + ' photos', printerName)
    });

    openModal('Print ' + app.edited.length + ' photos' + where, choices);
  }

  /**
   * Queue and return straight away - the operator keeps editing while pages go
   * out in the background. The job carries the photographer it came from, so
   * the print queue can still say who sent it.
   */
  function doPrint(entries, what, printerName) {
    const who = FM.people.active();
    const res = FM.printing.send(entries, {
      printer: printerName || '',
      silent: printerName ? FM.printers.silentFor(printerName) : false,
      printerLabel: FM.printers.labelFor(printerName),
      photographer: who.name,
      colour: who.colour
    });
    toast('Queued ' + what + ' for ' + who.name +
          (printerName ? ' on ' + FM.printers.labelFor(printerName) : '') +
          (res.queued ? ' (' + res.queued + ' pages)' : ''));
  }

  /* ------------------------------------------------------------- print bar */

  /**
   * A Print button per printer, on every tab. This is the whole change: any
   * photographer can send to either machine at any moment, and because the
   * queues are per printer both machines run at once.
   */
  function renderPrintBar() {
    const printers = FM.printers.list();

    el.printBar.innerHTML = printers.length
      ? printers.map((p) => `
          <button class="btn btn-red" data-print-to="${escapeHtml(p.name)}"
                  title="Send the edited photos to ${escapeHtml(p.name)}">Print ${escapeHtml(p.label)}</button>`).join('')
      : '<button class="btn btn-red" data-print-to="">Print</button>';

    el.printBar.querySelectorAll('[data-print-to]').forEach((b) => {
      b.addEventListener('click', () => printAll(b.dataset.printTo));
    });

    // keep the shortcut list honest about where Ctrl+P actually goes
    const k1 = $('keyPrint1');
    const k2 = $('keyPrint2');
    k1.textContent = printers[0] ? 'print — ' + printers[0].label : 'print';
    k2.parentElement.hidden = !printers[1];
    if (printers[1]) k2.textContent = 'print — ' + printers[1].label;
  }

  FM.printing.onQueueChange((status, problem) => {
    const tag = $('queueTag');
    if (status.pages > 0) {
      tag.hidden = false;
      tag.className = 'queuetag';
      tag.textContent = status.pages;
      tag.title = status.pages + ' page(s) waiting';
    } else if (status.failed) {
      tag.hidden = false;
      tag.className = 'queuetag bad';
      tag.textContent = '!';
      tag.title = status.failed + ' job(s) failed';
    } else {
      tag.hidden = true;
    }
    if (problem && problem.error) {
      toast('Printer' + (problem.job ? ' (' + problem.job.photographer + ')' : '') +
            ': ' + problem.error, true);
    }
    if (!el.spooler.hidden) renderSpooler();
  });

  /* ------------------------------------------------------- print queue UI */

  /**
   * Everything sent to a printer this session, with the photographer it came
   * from. At an event the usual question is "did that one actually come out",
   * and this is the only place that can answer it.
   */
  const STATE_LABEL = {
    queued: 'waiting', printing: 'printing now', done: 'printed', failed: 'failed'
  };

  function clockOf(t) {
    if (!t) return '';
    const d = new Date(t);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  function renderSpooler() {
    const jobs = FM.printing.jobList();
    if (!jobs.length) {
      el.spoolerBody.innerHTML = '<div class="empty small"><p>Nothing has been sent to a printer yet</p></div>';
      return;
    }

    el.spoolerBody.innerHTML = jobs.map((j) => `
      <div class="spool-row ${j.status}">
        <span class="dot" style="background:${j.colour || '#666'}"></span>
        <div class="spool-main">
          <div class="spool-title">${escapeHtml(j.names.slice(0, 3).join(', '))}${j.names.length > 3 ? ' +' + (j.names.length - 3) + ' more' : ''}</div>
          <div class="spool-sub">${escapeHtml(j.photographer || '—')} &middot; ${escapeHtml(j.printerLabel || j.printer)} &middot; ${j.pages} page${j.pages === 1 ? '' : 's'} &middot; ${j.size}</div>
          ${j.error ? `<div class="spool-err">${escapeHtml(j.error)}</div>` : ''}
        </div>
        <div class="spool-right">
          <span class="spool-state">${STATE_LABEL[j.status]}</span>
          <span class="spool-time">${clockOf(j.finishedAt || j.startedAt || j.queuedAt)}</span>
        </div>
        <div class="spool-act">
          ${j.status === 'failed' ? `<button class="btn btn-ghost sm" data-retry="${j.id}">Try again</button>` : ''}
          ${j.status === 'queued' ? `<button class="btn btn-ghost sm" data-cancel="${j.id}">Cancel</button>` : ''}
        </div>
      </div>`).join('');

    el.spoolerBody.querySelectorAll('[data-retry]').forEach((n) =>
      n.addEventListener('click', () => { FM.printing.retry(n.dataset.retry); renderSpooler(); }));
    el.spoolerBody.querySelectorAll('[data-cancel]').forEach((n) =>
      n.addEventListener('click', () => { FM.printing.cancel(n.dataset.cancel); renderSpooler(); }));
  }

  function openSpooler() {
    renderSpooler();
    el.spooler.hidden = false;
  }

  el.spooler.addEventListener('click', (e) => {
    if (e.target === el.spooler || e.target.hasAttribute('data-close')) el.spooler.hidden = true;
  });

  async function exportEdited() {
    const n = await FM.printing.exportFiles(app.edited);
    if (n) toast('Exported ' + n + ' photo(s)');
  }

  /* ------------------------------------------------- printer configuration */

  let printerList = [];           // everything Windows knows about

  async function loadPrinters() {
    if (!DESKTOP) {
      FM.people.load({});
      FM.printers.load({});
      renderTabs();
      renderPrintBar();
      return;
    }

    const saved = (await window.fastmike.getSettings()) || {};
    app.settings = saved;
    FM.people.load(saved);

    printerList = await window.fastmike.listPrinters();

    // nothing saved yet - put the dye-subs on the bar rather than making him
    // set up printers before he can print anything
    if (!FM.printers.load(saved)) {
      FM.printers.discover(printerList);
      saveSettings();
    }

    renderTabs();
    renderPrintBar();
    renderOriginals();
    renderEdited();
    syncFolderButton();
  }

  /**
   * Which printers are standing at this event. Set up once when the machines go
   * on the table, and then never touched again all night.
   */
  function openPrinterSetup() {
    if (!DESKTOP) return toast('Printer setup is in the desktop build', true);

    const inUse = FM.printers.list();
    const rows = inUse.map((p) => `
      <div class="pset-row" data-name="${escapeHtml(p.name)}">
        <div class="pset-main">
          <input type="text" class="sheet-input pset-label" maxlength="22"
                 value="${escapeHtml(p.label)}" title="What the button says">
          <div class="pset-sub" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>
        </div>
        <label class="check" title="Off means the Windows print dialog opens every time">
          <input type="checkbox" class="pset-silent" ${p.silent !== false ? 'checked' : ''}> straight to the printer
        </label>
        <button class="btn btn-ghost sm pset-del">Remove</button>
      </div>`).join('');

    const spare = printerList.filter((q) => !FM.printers.byName(q.name));
    const addBox = spare.length
      ? `<div class="pset-add">
           <select id="psetPick">${spare.map((q) =>
             `<option value="${escapeHtml(q.name)}">${escapeHtml(q.displayName || q.name)}</option>`).join('')}</select>
           <button class="btn" id="psetAdd">Add printer</button>
         </div>`
      : '<p class="hint">Every printer Windows knows about is already on the bar.</p>';

    openSheet('Printers for this event',
      (rows || '<p class="hint">No printers on the bar yet.</p>') + addBox +
      '<p class="hint sheet-hint">Each one gets its own Print button, on every photographer\'s tab. ' +
      'They print at the same time, so a batch on one machine never holds up the other.</p>',
      (body) => {
        body.querySelectorAll('.pset-row').forEach((row) => {
          const name = row.dataset.name;
          row.querySelector('.pset-label').addEventListener('change', (e) => {
            if (FM.printers.rename(name, e.target.value)) { renderPrintBar(); saveSettings(); }
          });
          row.querySelector('.pset-silent').addEventListener('change', (e) => {
            FM.printers.setSilent(name, e.target.checked);
            saveSettings();
          });
          row.querySelector('.pset-del').addEventListener('click', () => {
            FM.printers.remove(name);
            renderPrintBar();
            saveSettings();
            openPrinterSetup();
          });
        });

        const addBtn = body.querySelector('#psetAdd');
        if (addBtn) {
          addBtn.addEventListener('click', () => {
            const pick = body.querySelector('#psetPick').value;
            FM.printers.add(printerList.find((q) => q.name === pick));
            renderPrintBar();
            saveSettings();
            openPrinterSetup();
          });
        }
      }, true);
  }

  function saveSettings() {
    if (!DESKTOP) return;
    app.settings = Object.assign({}, app.settings,
                                 FM.people.toJSON(), FM.printers.toJSON());
    window.fastmike.setSettings(app.settings);
  }

  /* --------------------------------------------------------------- wiring */

  $('btnImportFiles').addEventListener('click', importFiles);
  $('btnImportFolder').addEventListener('click', importFolder);
  $('btnImportAgain').addEventListener('click', importAgain);
  $('btnClearAll').addEventListener('click', clearAll);
  $('btnAdd').addEventListener('click', addToEdited);
  $('btnPrinters').addEventListener('click', openPrinterSetup);
  $('btnFit').addEventListener('click', fit);
  $('btnExport').addEventListener('click', exportEdited);
  $('btnClearEdited').addEventListener('click', clearEdited);
  $('btnRotateFrame').addEventListener('click', rotateFrame);
  $('btnAddPerson').addEventListener('click', addPerson);
  $('btnSpooler').addEventListener('click', openSpooler);
  $('btnClearDone').addEventListener('click', () => { FM.printing.clearFinished(); renderSpooler(); });
  $('zoomIn').addEventListener('click', () => setZoom((current() ? current().state.zoom : 1) * 1.15));
  $('zoomOut').addEventListener('click', () => setZoom((current() ? current().state.zoom : 1) / 1.15));
  el.zoom.addEventListener('input', (e) => setZoom(+e.target.value / 100));

  document.addEventListener('keydown', (e) => {
    // Alt is an editing modifier here. Windows would otherwise treat a bare Alt
    // as "open the menu bar", which steals the keyboard away from the app.
    if (e.key === 'Alt') e.preventDefault();

    if (e.key === 'F2') {
      diag.hidden = !diag.hidden;
      if (!diag.hidden) showDiagnostics();
      return;
    }
    // While a sheet is open it owns the keyboard. Without this, pressing Enter
    // to confirm a photographer's name would also fire the Enter shortcut
    // behind it and push a photo into Edited.
    if (!el.spooler.hidden) {
      if (e.key === 'Escape') el.spooler.hidden = true;
      return;
    }
    if (!el.modal.hidden) {
      if (e.key === 'Escape') closeModal();
      return;
    }

    // Ctrl+1..9 jumps between photographers without reaching for the mouse
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key >= '1' && e.key <= '9') {
      const p = FM.people.list()[+e.key - 1];
      if (p) { e.preventDefault(); switchTo(p.id); }
      return;
    }

    const tag = document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      if (e.key !== 'Enter') return;
    }
    const ctrl = e.ctrlKey || e.metaKey;

    if (ctrl && e.key.toLowerCase() === 'c') { e.preventDefault(); return copySettings(); }
    if (ctrl && e.key.toLowerCase() === 'v') { e.preventDefault(); return pasteSettings(); }
    // Ctrl+P goes to the first printer, Ctrl+Shift+P to the second - the
    // shortcut list on the right always says which is which
    if (ctrl && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      const bar = FM.printers.list();
      const p = bar[e.shiftKey ? 1 : 0] || bar[0];
      return printAll(p ? p.name : '');
    }
    if (ctrl && e.key.toLowerCase() === 'o') { e.preventDefault(); return importFiles(); }

    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowRight': e.preventDefault(); step(1); break;
      case 'ArrowUp':
      case 'ArrowLeft':  e.preventDefault(); step(-1); break;
      case 'Enter':      e.preventDefault(); addToEdited(); break;
      case 'r': case 'R': rotateFrame(); break;
      case '0':          fit(); break;
    }
  });

  // drag photos straight onto the window
  ['dragover', 'drop'].forEach((t) =>
    document.addEventListener(t, (e) => { e.preventDefault(); }));

  document.addEventListener('drop', async (e) => {
    const files = Array.from(e.dataTransfer.files || []).filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    await addPhotos(files.map((f) => {
      const path = DESKTOP ? window.fastmike.pathForFile(f) : null;
      return path ? { name: f.name, path } : { name: f.name, url: URL.createObjectURL(f) };
    }));
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      layout();
      const p = current();
      if (p) FM.crop.clampPan(p, app.frame);
      render();
    }, 60);
  });

  /* ----------------------------------------------------------------- boot */

  buildSliders();
  layout();
  renderTabs();
  renderPrintBar();
  renderEdited();
  renderOriginals();
  syncFrameLabel();
  loadPrinters();
  render();

  // exposed for automated UI checks
  window.__fastmike = app;
  window.__fastmikeImport = addPhotos;
  window.__fastmikeInternals = {
    preview, exporter, layout, render, draw, addToEdited, printAll, rotateFrame,
    setAdjust, wheelKeyFor, WHEEL_KEYS, perf,
    people: FM.people, printers: FM.printers,
    switchTo, renderTabs, renderSpooler, openSpooler,
    importFolder, importAgain, onlyNew, syncFolderButton,
    folderGroups, folderTree, visibleIndexes, switchFolder, renderFolderTree,
    toggleBranch, openAllBranches,
    showPeek, hidePeek, peekOf: () => peekOf,
    renderPrintBar, openPrinterSetup, askCopies, saveSettings, loadPrinters,
    printerList: () => printerList,
    setPrinterList: (l) => { printerList = l; },
    renderScale: () => renderScale,
    setInteractiveScale: (s) => { interactiveScale = s; }
  };

})(window.FM);
