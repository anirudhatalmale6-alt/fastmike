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
    editCount: $('editCount'),
    fileInfo: $('fileInfo'),
    zoom: $('zoom'),
    toast: $('toast'),
    copiedTag: $('copiedTag'),
    printerSelect: $('printerSelect'),
    silent: $('silentPrint'),
    webPicker: $('webFilePicker'),
    frameFormat: $('frameFormat'),
    modal: $('modal'),
    modalTitle: $('modalTitle'),
    modalBody: $('modalBody'),
    tablist: $('tablist'),
    printerLabel: $('printerLabel'),
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
    el.modalTitle.textContent = title;
    el.modalBody.innerHTML = '';
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
    if (app.selected < 0 && app.photos.length) selectPhoto(0);
    toast(made.length + ' photo' + (made.length === 1 ? '' : 's') + ' imported' +
          (failed ? ' (' + failed + ' skipped)' : ''));
  }

  async function importFiles() {
    const picked = await FM.photos.pickFiles(el.webPicker);
    if (picked) await addPhotos(picked);
  }

  /**
   * Choose this photographer's folder. It is remembered against his tab, so
   * from then on new frames come in with one click and no file browser.
   */
  async function importFolder() {
    const picked = await FM.photos.pickFolder();
    if (!picked) {
      if (!DESKTOP) toast('Folder import is available in the desktop build', true);
      return;
    }
    FM.people.setFolder(FM.people.active().id, picked.dir);
    syncFolderButton();
    saveSettings();
    await addPhotos(onlyNew(picked.files));
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
      note.textContent = who.name + "'s folder: " + FM.photos.folderName(who.folder);
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
           title="${escapeHtml(p.name)}${p.printer ? ' - ' + escapeHtml(p.printer) : ' - no printer set'}\nDouble-click to rename">
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

    const who = FM.people.active();
    el.printerLabel.textContent = 'Printer for ' + who.name;
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

    renderTabs();
    renderOriginals();
    renderEdited();
    syncPrinterForActive();
    syncFolderButton();

    const i = app.selected;
    if (i >= 0 && i < app.photos.length) {
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
      toast(p.name + ' added - set his printer top right');
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
            syncPrinterForActive();
            syncFolderButton();
            if (app.photos.length) {
              const i = Math.min(app.photos.length - 1, Math.max(0, app.selected));
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

  /* ---------------------------------------------------------- originals UI */

  function renderOriginals() {
    el.origCount.textContent = app.photos.length;

    if (!app.photos.length) {
      el.originals.innerHTML = '<div class="empty"><p>No photos yet</p></div>';
      return;
    }

    const done = new Set(app.edited.map((e) => e.srcId));
    el.originals.innerHTML = app.photos.map((p, i) => `
      <div class="thumb${i === app.selected ? ' selected' : ''}${done.has(p.id) ? ' edited-done' : ''}"
           data-i="${i}" title="${p.name}">
        <img src="${p.thumb}" alt="">
        <span class="no">${i + 1}</span>
        <span class="done">&#10003;</span>
      </div>`).join('');

    el.originals.querySelectorAll('.thumb').forEach((n) => {
      n.addEventListener('click', () => selectPhoto(+n.dataset.i));
    });
  }

  function markSelection() {
    el.originals.querySelectorAll('.thumb').forEach((n) => {
      n.classList.toggle('selected', +n.dataset.i === app.selected);
    });
    const node = el.originals.querySelector('.thumb.selected');
    if (node) node.scrollIntoView({ block: 'nearest' });
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

  function step(delta) {
    if (!app.photos.length) return;
    const i = Math.min(app.photos.length - 1, Math.max(0, app.selected + delta));
    if (i !== app.selected) selectPhoto(i);
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
    { ctrl: true,  alt: true,  shift: false, key: 'shadows'    },  // Ctrl+Alt
    { ctrl: true,  alt: false, shift: false, key: 'brightness' },  // Ctrl
    { ctrl: false, alt: true,  shift: false, key: 'highlights' },  // Alt
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
    if (app.selected < app.photos.length - 1) step(1);
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

  function askCopies(entry) {
    if (!entry) return;
    const choices = [1, 2, 3, 4, 5].map((n) => ({
      label: n === 1 ? '1 copy' : n + ' copies',
      primary: n === 1,
      run: () => doPrint([{ ...entry, copies: n }], n + ' × ' + entry.name)
    }));
    openModal('Print ' + entry.name, choices);
  }

  function printAll() {
    if (!app.edited.length) return toast('Nothing in Edited Photos yet', true);

    const groups = FM.printing.groups(app.edited.length);

    // fewer than a full group - just print, no questions asked
    if (groups.length < 2) {
      return doPrint(app.edited.map((e) => ({ ...e, copies: 1 })),
                     app.edited.length + ' photo(s)');
    }

    const choices = groups.map((g) => ({
      label: 'Print ' + g.from + '–' + g.to,
      run: () => doPrint(app.edited.slice(g.start, g.end).map((e) => ({ ...e, copies: 1 })),
                         'photos ' + g.from + '–' + g.to)
    }));
    choices.push({
      label: 'Print All (' + app.edited.length + ')',
      primary: true,
      run: () => doPrint(app.edited.map((e) => ({ ...e, copies: 1 })),
                         'all ' + app.edited.length + ' photos')
    });

    openModal('Print ' + app.edited.length + ' photos', choices);
  }

  /**
   * Queue and return straight away - the operator keeps editing while pages go
   * out in the background.
   */
  function doPrint(entries, what) {
    // whoever's tab is open owns this job, and it goes to his printer
    const who = FM.people.active();
    const res = FM.printing.send(entries, {
      printer: who.printer || '',
      silent: who.silent !== false,
      photographer: who.name,
      colour: who.colour
    });
    toast('Queued ' + what + ' for ' + who.name +
          (res.queued ? ' (' + res.queued + ' pages)' : ''));
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
          <div class="spool-sub">${escapeHtml(j.photographer || '—')} &middot; ${escapeHtml(j.printer)} &middot; ${j.pages} page${j.pages === 1 ? '' : 's'} &middot; ${j.size}</div>
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

  let printerList = [];

  async function loadPrinters() {
    if (!DESKTOP) {
      FM.people.load({});
      renderTabs();
      el.printerSelect.innerHTML = '<option value="__dialog__">Browser print dialog</option>';
      el.silent.checked = false;
      el.silent.disabled = true;
      return;
    }

    const saved = (await window.fastmike.getSettings()) || {};
    app.settings = saved;
    FM.people.load(saved);

    printerList = await window.fastmike.listPrinters();
    buildPrinterOptions();

    renderTabs();
    renderOriginals();
    renderEdited();
    syncPrinterForActive();
    syncFolderButton();
  }

  /**
   * With nothing saved yet, pick the event printer rather than whatever Windows
   * has set as default - that is usually an office laser or a PDF writer.
   */
  function defaultPrinterFor(index) {
    const isPhotoPrinter = (p) =>
      /\b(dnp|citizen|ds620|ds820|rx1|cx-?0?2|cy-?0?2|qw410|sinfonia|mitsubishi)\b/i
        .test((p.displayName || '') + ' ' + p.name);
    const photo = printerList.filter(isPhotoPrinter);

    // several photographers, several dye-subs: hand them out one each rather
    // than pointing everybody at the same machine
    if (photo.length) return (photo[index % photo.length] || photo[0]).name;
    const def = printerList.find((p) => p.isDefault);
    return def ? def.name : '';
  }

  function buildPrinterOptions() {
    if (!printerList.length) {
      el.printerSelect.innerHTML = '<option value="__dialog__">No printers found</option>';
      return;
    }
    const opts = ['<option value="__dialog__">Ask each time (system dialog)</option>'];
    printerList.forEach((p) => {
      opts.push(`<option value="${escapeHtml(p.name)}">${escapeHtml(p.displayName || p.name)}</option>`);
    });
    el.printerSelect.innerHTML = opts.join('');
  }

  /** Point the printer control at whoever's tab is open. */
  function syncPrinterForActive() {
    if (!DESKTOP) return;
    const who = FM.people.active();
    const index = FM.people.list().indexOf(who);

    if (!who.printer) {
      const guess = defaultPrinterFor(index);
      if (guess) FM.people.setPrinter(who.id, guess);
    }

    const has = Array.from(el.printerSelect.options).some((o) => o.value === who.printer);
    el.printerSelect.value = has && who.printer ? who.printer : '__dialog__';
    el.silent.checked = who.silent !== false;
    el.printerLabel.textContent = 'Printer for ' + who.name;
  }

  function saveSettings() {
    if (!DESKTOP) return;
    app.settings = Object.assign({}, app.settings, FM.people.toJSON());
    window.fastmike.setSettings(app.settings);
  }

  el.printerSelect.addEventListener('change', () => {
    const who = FM.people.active();
    FM.people.setPrinter(who.id, el.printerSelect.value === '__dialog__' ? '' : el.printerSelect.value);
    renderTabs();
    saveSettings();
  });

  el.silent.addEventListener('change', () => {
    FM.people.setSilent(FM.people.active().id, el.silent.checked);
    saveSettings();
  });

  /* --------------------------------------------------------------- wiring */

  $('btnImportFiles').addEventListener('click', importFiles);
  $('btnImportFolder').addEventListener('click', importFolder);
  $('btnImportAgain').addEventListener('click', importAgain);
  $('btnClearAll').addEventListener('click', clearAll);
  $('btnAdd').addEventListener('click', addToEdited);
  $('btnPrint').addEventListener('click', printAll);
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
    if (ctrl && e.key.toLowerCase() === 'p') { e.preventDefault(); return printAll(); }
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
    people: FM.people, switchTo, renderTabs, renderSpooler, openSpooler,
    importFolder, importAgain, onlyNew, syncFolderButton,
    syncPrinterForActive, saveSettings,
    renderScale: () => renderScale,
    setInteractiveScale: (s) => { interactiveScale = s; }
  };

})(window.FM);
