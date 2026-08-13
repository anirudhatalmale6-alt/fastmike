/* FastMike - renderer
 * ---------------------------------------------------------------------------
 * Everything the photographer touches lives here. Two rules drive the design:
 *   1. originals are never modified - we only ever read them
 *   2. every adjustment must land on screen in the same frame it was made,
 *      so the preview is a WebGL shader, not a chain of 2D canvas passes.
 */

'use strict';

/* ===========================================================================
 * Desktop bridge (Electron) with a browser fallback so the same build can be
 * demoed in a plain browser.
 * ======================================================================== */

const DESKTOP = !!(window.fastmike && window.fastmike.isDesktop);

/* ===========================================================================
 * Adjustment definitions
 * ======================================================================== */

const ADJUSTMENTS = [
  { key: 'brightness', label: 'Brightness' },
  { key: 'highlights', label: 'Highlights' },
  { key: 'contrast',   label: 'Contrast'   },
  { key: 'shadows',    label: 'Shadows'    }
];

const NEUTRAL = { brightness: 0, highlights: 0, contrast: 0, shadows: 0 };

const newState = () => ({
  ...NEUTRAL,
  zoom: 1,      // 1 = photo exactly fills the crop frame
  tx: 0,        // pan, in frame-widths
  ty: 0,
  rot: 0        // 0..3, quarter turns clockwise
});

/* ===========================================================================
 * WebGL tone engine - one program, used for both the live preview and the
 * full-resolution print render.
 * ======================================================================== */

const VERT = `
attribute vec2 a_pos;
attribute vec2 a_uv;
varying vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_img;
uniform float u_brightness;
uniform float u_highlights;
uniform float u_contrast;
uniform float u_shadows;

void main() {
  vec4 src = texture2D(u_img, v_uv);
  vec3 c = src.rgb;

  // brightness - straight lift, kept gentle so skin does not blow out
  c += u_brightness * 0.42;

  // contrast around mid grey
  float k = 1.0 + u_contrast * 0.75;
  c = (c - 0.5) * k + 0.5;

  float lum = dot(clamp(c, 0.0, 1.0), vec3(0.299, 0.587, 0.114));

  // shadows act on the lower tones only, highlights on the upper tones only
  float shadowMask    = 1.0 - smoothstep(0.0, 0.62, lum);
  float highlightMask = smoothstep(0.38, 1.0, lum);

  c += u_shadows    * shadowMask    * 0.55;
  c += u_highlights * highlightMask * 0.55;

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), src.a);
}`;

class ToneRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const opts = { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false };
    this.gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
    if (!this.gl) throw new Error('WebGL is not available');
    this._build();
    this.texture = null;
    this.texSource = null;
  }

  _compile(type, src) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('shader: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  _build() {
    const gl = this.gl;
    const prog = gl.createProgram();
    gl.attachShader(prog, this._compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, this._compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('link: ' + gl.getProgramInfoLog(prog));
    }
    gl.useProgram(prog);
    this.prog = prog;

    this.posBuf = gl.createBuffer();
    this.uvBuf = gl.createBuffer();
    this.aPos = gl.getAttribLocation(prog, 'a_pos');
    this.aUv = gl.getAttribLocation(prog, 'a_uv');
    this.u = {};
    ['u_brightness', 'u_highlights', 'u_contrast', 'u_shadows', 'u_img'].forEach((n) => {
      this.u[n] = gl.getUniformLocation(prog, n);
    });
    gl.uniform1i(this.u.u_img, 0);
  }

  /** Upload an image. Cached so repeated renders of the same photo are free. */
  setImage(img) {
    const gl = this.gl;
    if (this.texSource === img) return;
    if (this.texture) gl.deleteTexture(this.texture);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    this.texture = tex;
    this.texSource = img;
  }

  releaseImage() {
    if (this.texture) {
      this.gl.deleteTexture(this.texture);
      this.texture = null;
      this.texSource = null;
    }
  }

  /**
   * Draw the photo into the canvas.
   * rect  - {x, y, w, h} in canvas pixels (top-left origin) for the photo quad
   * rot   - quarter turns clockwise
   * adj   - {brightness, highlights, contrast, shadows}
   */
  draw(rect, rot, adj) {
    const gl = this.gl;
    const W = this.canvas.width;
    const H = this.canvas.height;

    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.texture) return;

    const x0 = (rect.x / W) * 2 - 1;
    const x1 = ((rect.x + rect.w) / W) * 2 - 1;
    const y0 = 1 - (rect.y / H) * 2;
    const y1 = 1 - ((rect.y + rect.h) / H) * 2;

    // TL, TR, BL, BR
    const pos = new Float32Array([x0, y0, x1, y0, x0, y1, x1, y1]);

    const A = [0, 0], B = [1, 0], C = [0, 1], D = [1, 1];
    const UV = [
      [A, B, C, D], // 0
      [C, A, D, B], // 90 cw
      [D, C, B, A], // 180
      [B, D, A, C]  // 270 cw
    ][((rot % 4) + 4) % 4];
    const uv = new Float32Array([].concat(UV[0], UV[1], UV[2], UV[3]));

    gl.useProgram(this.prog);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STREAM_DRAW);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STREAM_DRAW);
    gl.enableVertexAttribArray(this.aUv);
    gl.vertexAttribPointer(this.aUv, 2, gl.FLOAT, false, 0, 0);

    gl.uniform1f(this.u.u_brightness, adj.brightness);
    gl.uniform1f(this.u.u_highlights, adj.highlights);
    gl.uniform1f(this.u.u_contrast, adj.contrast);
    gl.uniform1f(this.u.u_shadows, adj.shadows);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

/* ===========================================================================
 * App state
 * ======================================================================== */

const app = {
  photos: [],        // {id, name, src, thumb, w, h, state}
  selected: -1,
  edited: [],        // {id, name, blob, url, srcId}
  clipboard: null,   // copied adjustments
  image: null,       // decoded HTMLImageElement for the selected photo
  loadToken: 0,
  frame: { x: 0, y: 0, w: 0, h: 0 },
  print: { wMm: 150, hMm: 200, dpi: 300 },
  seq: 0
};

const $ = (id) => document.getElementById(id);

const el = {
  stage: $('stage'),
  canvas: $('preview'),
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
  webPicker: $('webFilePicker')
};

let tone;
try {
  tone = new ToneRenderer(el.canvas);
} catch (err) {
  document.body.innerHTML =
    '<div style="padding:40px;font:14px sans-serif;color:#e8e8e8">' +
    'FastMike needs hardware graphics acceleration (WebGL).<br>' + err.message + '</div>';
  throw err;
}

// second, offscreen engine used only for full-resolution print renders
const exportCanvas = document.createElement('canvas');
const exportTone = new ToneRenderer(exportCanvas);

/* ===========================================================================
 * Helpers
 * ======================================================================== */

let toastTimer = null;
function toast(msg, isErr) {
  el.toast.textContent = msg;
  el.toast.className = 'toast' + (isErr ? ' err' : '');
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, isErr ? 5000 : 2200);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read image'));
    img.src = src;
  });
}

function makeThumb(img, maxW, maxH) {
  const s = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * s));
  c.height = Math.max(1, Math.round(img.naturalHeight * s));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.72);
}

const current = () => (app.selected >= 0 ? app.photos[app.selected] : null);

/* ===========================================================================
 * Crop frame geometry
 *
 * The frame is fixed. The photo moves behind it. All of the sizing below is
 * derived from the selected print size so what you see is exactly what prints.
 * ======================================================================== */

function layoutFrame() {
  const pad = 34;
  const sw = el.stage.clientWidth;
  const sh = el.stage.clientHeight;
  const aspect = app.print.wMm / app.print.hMm;

  let h = sh - pad * 2;
  let w = h * aspect;
  if (w > sw - pad * 2) {
    w = sw - pad * 2;
    h = w / aspect;
  }
  const f = {
    x: Math.round((sw - w) / 2),
    y: Math.round((sh - h) / 2),
    w: Math.round(w),
    h: Math.round(h)
  };
  app.frame = f;

  el.frame.style.left = f.x + 'px';
  el.frame.style.top = f.y + 'px';
  el.frame.style.width = f.w + 'px';
  el.frame.style.height = f.h + 'px';

  const dpr = window.devicePixelRatio || 1;
  el.canvas.width = Math.round(sw * dpr);
  el.canvas.height = Math.round(sh * dpr);
}

/** Photo dimensions as displayed, accounting for quarter-turn rotation. */
function displayDims(photo) {
  const swap = photo.state.rot % 2 === 1;
  return {
    w: swap ? photo.h : photo.w,
    h: swap ? photo.w : photo.h
  };
}

/**
 * Where the photo quad sits, in units of the crop frame.
 * cover() is the scale at which the photo exactly fills the frame - zoom 1.
 */
function photoRect(photo, frame) {
  const d = displayDims(photo);
  const cover = Math.max(frame.w / d.w, frame.h / d.h);
  const s = cover * photo.state.zoom;
  const w = d.w * s;
  const h = d.h * s;
  return {
    x: frame.x + (frame.w - w) / 2 + photo.state.tx * frame.w,
    y: frame.y + (frame.h - h) / 2 + photo.state.ty * frame.h,
    w,
    h
  };
}

/** Never let an edge of the photo drift inside the frame - no white gaps. */
function clampPan(photo) {
  const f = app.frame;
  if (!f.w) return;
  const r = photoRect(photo, { x: 0, y: 0, w: f.w, h: f.h });
  const limX = Math.max(0, (r.w - f.w) / 2) / f.w;
  const limY = Math.max(0, (r.h - f.h) / 2) / f.h;
  photo.state.tx = Math.min(limX, Math.max(-limX, photo.state.tx));
  photo.state.ty = Math.min(limY, Math.max(-limY, photo.state.ty));
}

/* ===========================================================================
 * Preview render
 * ======================================================================== */

let rafPending = false;
function render() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    drawNow();
  });
}

function drawNow() {
  const p = current();
  if (!p || !app.image) {
    tone.releaseImage();
    tone.draw({ x: 0, y: 0, w: 0, h: 0 }, 0, NEUTRAL);
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  const r = photoRect(p, app.frame);
  tone.setImage(app.image);
  tone.draw(
    { x: r.x * dpr, y: r.y * dpr, w: r.w * dpr, h: r.h * dpr },
    p.state.rot,
    p.state
  );
}

/* ===========================================================================
 * Import
 * ======================================================================== */

async function addPhotos(entries) {
  if (!entries.length) return;
  let added = 0;
  let failed = 0;

  for (const entry of entries) {
    try {
      const img = await loadImage(entry.src);
      app.photos.push({
        id: 'p' + ++app.seq,
        name: entry.name,
        src: entry.src,
        thumb: makeThumb(img, 320, 320),
        w: img.naturalWidth,
        h: img.naturalHeight,
        state: newState()
      });
      added++;
    } catch (err) {
      failed++;
    }
  }

  renderOriginals();
  if (app.selected < 0 && app.photos.length) selectPhoto(0);
  toast(added + ' photo' + (added === 1 ? '' : 's') + ' imported' + (failed ? ' (' + failed + ' skipped)' : ''));
}

async function importFiles() {
  if (DESKTOP) {
    const picked = await window.fastmike.importFiles();
    await addPhotos(picked.map((f) => ({ name: f.name, src: window.fastmike.readImage(f.path) })));
  } else {
    el.webPicker.click();
  }
}

async function importFolder() {
  if (DESKTOP) {
    const picked = await window.fastmike.importFolder();
    await addPhotos(picked.map((f) => ({ name: f.name, src: window.fastmike.readImage(f.path) })));
  } else {
    toast('Folder import is available in the desktop build', true);
  }
}

el.webPicker.addEventListener('change', async () => {
  const files = Array.from(el.webPicker.files || []);
  await addPhotos(files.map((f) => ({ name: f.name, src: URL.createObjectURL(f) })));
  el.webPicker.value = '';
});

/* ===========================================================================
 * Originals strip
 * ======================================================================== */

function renderOriginals() {
  el.origCount.textContent = app.photos.length;

  if (!app.photos.length) {
    el.originals.innerHTML =
      '<div class="empty"><p>No photos yet</p><button id="btnImportEmpty" class="btn btn-accent">Import Photos</button></div>';
    $('btnImportEmpty').addEventListener('click', importFiles);
    return;
  }

  const done = new Set(app.edited.map((e) => e.srcId));
  el.originals.innerHTML = app.photos
    .map(
      (p, i) => `
      <div class="thumb${i === app.selected ? ' selected' : ''}${done.has(p.id) ? ' edited-done' : ''}" data-i="${i}" title="${p.name}">
        <img src="${p.thumb}" alt="">
        <span class="no">${i + 1}</span>
        <span class="done">&#10003;</span>
      </div>`
    )
    .join('');

  el.originals.querySelectorAll('.thumb').forEach((node) => {
    node.addEventListener('click', () => selectPhoto(+node.dataset.i));
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
  el.zoom.value = Math.round(p.state.zoom * 100);

  const token = ++app.loadToken;
  try {
    const img = await loadImage(p.src);
    if (token !== app.loadToken) return; // a newer selection won the race
    app.image = img;
    clampPan(p);
    render();
  } catch (err) {
    toast('Could not open ' + p.name, true);
  }
}

function step(delta) {
  if (!app.photos.length) return;
  let i = app.selected + delta;
  if (i < 0) i = 0;
  if (i > app.photos.length - 1) i = app.photos.length - 1;
  if (i !== app.selected) selectPhoto(i);
}

/* ===========================================================================
 * Adjustment sliders
 * ======================================================================== */

const RESET_SVG =
  '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.5-5.8M4 4v4h4"/></svg>';

function buildSliders() {
  el.sliders.innerHTML = ADJUSTMENTS.map(
    (a) => `
    <div class="slider-row" data-key="${a.key}">
      <div class="slider-top">
        <span class="name">${a.label}</span>
        <button class="reset-ico" data-reset="${a.key}" title="Reset ${a.label}" aria-label="Reset ${a.label}">${RESET_SVG}</button>
        <span class="val" data-val="${a.key}">0</span>
      </div>
      <input type="range" min="-100" max="100" value="0" step="1" data-slider="${a.key}">
    </div>`
  ).join('');

  el.sliders.querySelectorAll('[data-slider]').forEach((input) => {
    const key = input.dataset.slider;
    const apply = () => {
      const p = current();
      if (!p) { input.value = 0; return; }
      p.state[key] = +input.value / 100;
      updateRow(key, +input.value);
      render();
    };
    input.addEventListener('input', apply);
    input.addEventListener('dblclick', () => resetOne(key));
  });

  el.sliders.querySelectorAll('[data-reset]').forEach((btn) => {
    btn.addEventListener('click', () => resetOne(btn.dataset.reset));
  });
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

function resetOne(key) {
  const p = current();
  if (!p) return;
  p.state[key] = 0;
  el.sliders.querySelector(`[data-slider="${key}"]`).value = 0;
  updateRow(key, 0);
  render();
}

function resetAll() {
  const p = current();
  if (!p) return;
  ADJUSTMENTS.forEach((a) => { p.state[a.key] = 0; });
  syncSliders();
  render();
}

/* ===========================================================================
 * Copy settings
 * ======================================================================== */

function copySettings() {
  const p = current();
  if (!p) return toast('Select a photo first', true);
  app.clipboard = {};
  ADJUSTMENTS.forEach((a) => { app.clipboard[a.key] = p.state[a.key]; });
  $('btnPasteAll').disabled = false;
  el.copiedTag.hidden = false;
  toast('Settings copied - paste onto the next photo with Ctrl+V');
}

function pasteSettings(target) {
  if (!app.clipboard) return toast('Nothing copied yet', true);
  ADJUSTMENTS.forEach((a) => { target.state[a.key] = app.clipboard[a.key]; });
}

function pasteToSelected() {
  const p = current();
  if (!p) return;
  pasteSettings(p);
  syncSliders();
  render();
  toast('Settings applied');
}

function pasteToAll() {
  if (!app.clipboard) return toast('Nothing copied yet', true);
  app.photos.forEach(pasteSettings);
  syncSliders();
  render();
  toast('Settings applied to all ' + app.photos.length + ' photos');
}

/* ===========================================================================
 * Pan / zoom / rotate
 * ======================================================================== */

let drag = null;

el.stage.addEventListener('pointerdown', (e) => {
  const p = current();
  if (!p) return;
  el.stage.setPointerCapture(e.pointerId);
  el.stage.classList.add('dragging');
  el.hint.style.opacity = 0;
  drag = { x: e.clientX, y: e.clientY, tx: p.state.tx, ty: p.state.ty };
});

el.stage.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const p = current();
  p.state.tx = drag.tx + (e.clientX - drag.x) / app.frame.w;
  p.state.ty = drag.ty + (e.clientY - drag.y) / app.frame.h;
  clampPan(p);
  render();
});

function endDrag(e) {
  if (!drag) return;
  drag = null;
  el.stage.classList.remove('dragging');
  try { el.stage.releasePointerCapture(e.pointerId); } catch (_) {}
}
el.stage.addEventListener('pointerup', endDrag);
el.stage.addEventListener('pointercancel', endDrag);

el.stage.addEventListener('wheel', (e) => {
  const p = current();
  if (!p) return;
  e.preventDefault();
  setZoom(p.state.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08));
}, { passive: false });

el.stage.addEventListener('dblclick', () => fit());

function setZoom(z) {
  const p = current();
  if (!p) return;
  p.state.zoom = Math.min(4, Math.max(1, z));
  el.zoom.value = Math.round(p.state.zoom * 100);
  clampPan(p);
  render();
}

function fit() {
  const p = current();
  if (!p) return;
  p.state.zoom = 1;
  p.state.tx = 0;
  p.state.ty = 0;
  el.zoom.value = 100;
  render();
}

function rotate(dir) {
  const p = current();
  if (!p) return;
  p.state.rot = (p.state.rot + dir + 4) % 4;
  p.state.tx = 0;
  p.state.ty = 0;
  clampPan(p);
  render();
}

/* ===========================================================================
 * Render to print resolution
 * ======================================================================== */

function printPixels() {
  const { wMm, hMm, dpi } = app.print;
  return {
    w: Math.round((wMm / 25.4) * dpi),
    h: Math.round((hMm / 25.4) * dpi)
  };
}

function renderToPrint(photo, img) {
  const out = printPixels();
  exportCanvas.width = out.w;
  exportCanvas.height = out.h;

  const frame = { x: 0, y: 0, w: out.w, h: out.h };
  const r = photoRect(photo, frame);

  exportTone.setImage(img);
  exportTone.draw(r, photo.state.rot, photo.state);

  return new Promise((resolve) => {
    exportCanvas.toBlob((b) => resolve(b), 'image/jpeg', 0.95);
  });
}

/* ===========================================================================
 * Edited photos
 * ======================================================================== */

async function addToEdited() {
  const p = current();
  if (!p) return toast('Select a photo first', true);

  const img = app.image && app.image.src === p.src ? app.image : await loadImage(p.src);
  const blob = await renderToPrint(p, img);
  exportTone.releaseImage();

  const base = p.name.replace(/\.[^.]+$/, '');
  const entry = {
    id: 'e' + ++app.seq,
    srcId: p.id,
    name: base + '_print.jpg',
    blob,
    url: URL.createObjectURL(blob),
    checked: true
  };
  app.edited.push(entry);

  renderEdited();
  renderOriginals();
  toast('Added to print queue');

  // straight on to the next photo - this is the whole point of the app
  if (app.selected < app.photos.length - 1) step(1);
}

function renderEdited() {
  el.editCount.textContent = app.edited.length;

  if (!app.edited.length) {
    el.edited.innerHTML = '<div class="empty small"><p>Edited photos appear here &mdash; two rows of five</p></div>';
    return;
  }

  el.edited.innerHTML = app.edited
    .map(
      (e) => `
      <div class="echip${e.checked ? ' checked' : ''}" data-id="${e.id}" title="${e.name}">
        <img src="${e.url}" alt="">
        <span class="tick">&#10003;</span>
        <span class="x" data-del="${e.id}">&times;</span>
        <span class="lbl">${e.name}</span>
      </div>`
    )
    .join('');

  el.edited.querySelectorAll('.echip').forEach((node) => {
    node.addEventListener('click', (ev) => {
      if (ev.target.dataset.del) return;
      const e = app.edited.find((x) => x.id === node.dataset.id);
      e.checked = !e.checked;
      node.classList.toggle('checked', e.checked);
    });
  });

  el.edited.querySelectorAll('[data-del]').forEach((node) => {
    node.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = node.dataset.del;
      const i = app.edited.findIndex((x) => x.id === id);
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
  renderEdited();
  renderOriginals();
}

function selectAllEdited() {
  const allOn = app.edited.every((e) => e.checked);
  app.edited.forEach((e) => { e.checked = !allOn; });
  renderEdited();
}

const checkedEdited = () => app.edited.filter((e) => e.checked);

/* ===========================================================================
 * Export
 * ======================================================================== */

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.readAsDataURL(blob);
  });
}

async function exportEdited() {
  const list = checkedEdited();
  if (!list.length) return toast('Tick the photos you want to export', true);

  if (!DESKTOP) {
    list.forEach((e) => {
      const a = document.createElement('a');
      a.href = e.url;
      a.download = e.name;
      a.click();
    });
    return toast('Downloading ' + list.length + ' file(s)');
  }

  const folder = await window.fastmike.pickExportFolder();
  if (!folder) return;
  for (const e of list) {
    await window.fastmike.writeExport(folder, e.name, await blobToDataUrl(e.blob));
  }
  toast('Exported ' + list.length + ' photo(s)');
}

/* ===========================================================================
 * Print
 * ======================================================================== */

async function doPrint() {
  const list = checkedEdited();
  if (!list.length) return toast('Tick the photos you want to print', true);

  const copies = Math.max(1, Math.min(99, +$('copies').value || 1));

  if (!DESKTOP) {
    const w = window.open('', '_blank');
    const imgs = list.map((e) => `<div class="pg"><img src="${e.url}"></div>`).join('').repeat(copies);
    w.document.write(
      `<style>@page{size:${app.print.wMm}mm ${app.print.hMm}mm;margin:0}
       body{margin:0}
       .pg{width:${app.print.wMm}mm;height:${app.print.hMm}mm;page-break-after:always;overflow:hidden}
       .pg img{width:100%;height:100%;object-fit:fill;display:block}</style>${imgs}`
    );
    w.document.close();
    w.onload = () => w.print();
    return;
  }

  toast('Sending ' + list.length + ' photo(s) to the printer…');
  const images = [];
  for (const e of list) images.push(await blobToDataUrl(e.blob));

  const printer = el.printerSelect.value;
  const res = await window.fastmike.printImages({
    images,
    widthMm: app.print.wMm,
    heightMm: app.print.hMm,
    printer: printer === '__dialog__' ? null : printer,
    silent: $('silentPrint').checked && printer !== '__dialog__',
    copies
  });

  if (res && res.success) toast('Sent to printer');
  else toast('Print cancelled' + (res && res.reason ? ': ' + res.reason : ''), true);
}

async function loadPrinters() {
  if (!DESKTOP) {
    el.printerSelect.innerHTML = '<option value="__dialog__">Browser print dialog</option>';
    return;
  }
  const printers = await window.fastmike.listPrinters();
  const opts = ['<option value="__dialog__">Ask each time (system dialog)</option>'];
  printers.forEach((p) => {
    opts.push(
      `<option value="${p.name}"${p.isDefault ? ' selected' : ''}>${p.displayName || p.name}</option>`
    );
  });
  el.printerSelect.innerHTML = opts.join('');
}

/* ===========================================================================
 * Output settings
 * ======================================================================== */

$('printSize').addEventListener('change', (e) => {
  const [w, h] = e.target.value.split('x').map(Number);
  app.print.wMm = w;
  app.print.hMm = h;
  layoutFrame();
  app.photos.forEach(clampPan);
  render();
});

$('dpi').addEventListener('change', (e) => {
  app.print.dpi = +e.target.value;
});

/* ===========================================================================
 * Wiring
 * ======================================================================== */

$('btnImportFiles').addEventListener('click', importFiles);
$('btnImportFolder').addEventListener('click', importFolder);
$('btnImportEmpty').addEventListener('click', importFiles);
$('btnCopy').addEventListener('click', copySettings);
$('btnPasteAll').addEventListener('click', pasteToAll);
$('btnAdd').addEventListener('click', addToEdited);
$('btnPrint').addEventListener('click', doPrint);
$('btnResetAll').addEventListener('click', resetAll);
$('btnFit').addEventListener('click', fit);
$('btnExport').addEventListener('click', exportEdited);
$('btnClearEdited').addEventListener('click', clearEdited);
$('btnSelectAll').addEventListener('click', selectAllEdited);
$('zoomIn').addEventListener('click', () => setZoom((current() ? current().state.zoom : 1) * 1.15));
$('zoomOut').addEventListener('click', () => setZoom((current() ? current().state.zoom : 1) / 1.15));
$('rotL').addEventListener('click', () => rotate(-1));
$('rotR').addEventListener('click', () => rotate(1));
el.zoom.addEventListener('input', (e) => setZoom(+e.target.value / 100));

document.addEventListener('keydown', (e) => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl && e.key.toLowerCase() === 'c') { e.preventDefault(); return copySettings(); }
  if (ctrl && e.key.toLowerCase() === 'v') { e.preventDefault(); return pasteToSelected(); }
  if (ctrl && e.key.toLowerCase() === 'p') { e.preventDefault(); return doPrint(); }
  if (ctrl && e.key.toLowerCase() === 'o') { e.preventDefault(); return importFiles(); }

  switch (e.key) {
    case 'ArrowDown':
    case 'ArrowRight': e.preventDefault(); step(1); break;
    case 'ArrowUp':
    case 'ArrowLeft':  e.preventDefault(); step(-1); break;
    case 'Enter':      e.preventDefault(); addToEdited(); break;
    case 'r': case 'R': rotate(e.shiftKey ? -1 : 1); break;
    case '0':          fit(); break;
  }
});

// drag photos straight onto the window
['dragover', 'drop'].forEach((t) =>
  document.addEventListener(t, (e) => { e.preventDefault(); })
);
document.addEventListener('drop', async (e) => {
  const files = Array.from(e.dataTransfer.files || []).filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  await addPhotos(files.map((f) => ({
    name: f.name,
    src: DESKTOP && f.path ? window.fastmike.readImage(f.path) : URL.createObjectURL(f)
  })));
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    layoutFrame();
    app.photos.forEach(clampPan);
    render();
  }, 60);
});

/* ===========================================================================
 * Boot
 * ======================================================================== */

buildSliders();
layoutFrame();
renderEdited();
renderOriginals();
loadPrinters();
render();

// exposed for automated UI checks
window.__fastmike = app;
