/* FastMike - image loading
 * ---------------------------------------------------------------------------
 * Originals are opened read-only and never written to.
 *
 * On the desktop only the file path and a small thumbnail are kept in memory;
 * the full-size original is re-read from disk when it is actually needed.
 * Holding every original would put a few hundred photos from one event into
 * the gigabytes.
 */

'use strict';

window.FM = window.FM || {};

(function (FM) {

  const DESKTOP = !!(window.fastmike && window.fastmike.isDesktop);

  const NEUTRAL = { brightness: 0, highlights: 0, contrast: 0, shadows: 0 };

  function newState() {
    return {
      brightness: 0,
      highlights: 0,
      contrast: 0,
      shadows: 0,
      zoom: 1,          // 1 = photo exactly covers the crop frame
      tx: 0,            // pan, in frame widths
      ty: 0,
      landscape: false  // frame orientation, not photo rotation
    };
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not read image'));
      img.src = src;
    });
  }

  const dimsOf = (img) => ({
    w: img.naturalWidth || img.width,
    h: img.naturalHeight || img.height
  });

  function scaleTo(img, w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    const cx = c.getContext('2d');
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  function makeThumb(img, maxW, maxH) {
    const d = dimsOf(img);
    const s = Math.min(maxW / d.w, maxH / d.h, 1);
    return scaleTo(img, d.w * s, d.h * s).toDataURL('image/jpeg', 0.72);
  }

  /**
   * A screen-sized copy of the original, used for the live preview only.
   *
   * Panning a 24 megapixel photograph means the graphics card has to shrink a
   * 96 MB texture down to a window-sized rectangle on every single frame, and
   * on laptop graphics that is what makes dragging feel heavy. Reducing it once
   * to something a little larger than the screen can show costs nothing
   * visible - the crop frame is around 600 pixels tall - and every frame after
   * that is cheap. Printing always goes back to the untouched original.
   */
  const PREVIEW_MAX = 2400;

  function previewCopy(img) {
    const d = dimsOf(img);
    const s = Math.min(1, PREVIEW_MAX / Math.max(d.w, d.h));
    return s >= 1 ? img : scaleTo(img, d.w * s, d.h * s);
  }

  /**
   * Open a photo's original at full size.
   *
   * On the desktop the file is read as raw bytes and handed to the decoder
   * through a blob URL, which is revoked as soon as the image is decoded, so
   * nothing is left holding a copy of the file.
   */
  async function openImage(photo) {
    if (!(photo.path && DESKTOP)) return loadImage(photo.url);

    const { bytes, mime } = await window.fastmike.readImageBytes(photo.path);
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    try {
      return await loadImage(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /**
   * Turn import entries into photo records.
   * entry is {name, path} on the desktop or {name, url} in a browser.
   */
  async function build(entries, nextId) {
    const made = [];
    let failed = 0;

    for (const entry of entries) {
      try {
        // decoded once here for the thumbnail, then released - see openImage()
        const img = await openImage(entry);
        const d = dimsOf(img);
        made.push({
          id: nextId(),
          name: entry.name,
          path: entry.path || null,
          url: entry.url || null,
          thumb: makeThumb(img, 320, 320),
          w: d.w,
          h: d.h,
          state: newState()
        });
      } catch (err) {
        failed++;
      }
    }
    return { made, failed };
  }

  /** Ask the OS for files, via the native dialog on the desktop. */
  async function pickFiles(webInput) {
    if (DESKTOP) return window.fastmike.importFiles();
    webInput.click();
    return null;             // the change handler takes over
  }

  async function pickFolder() {
    if (!DESKTOP) return null;
    return window.fastmike.importFolder();
  }

  FM.photos = {
    DESKTOP, NEUTRAL, PREVIEW_MAX, newState, loadImage, makeThumb, dimsOf,
    previewCopy, openImage, build, pickFiles, pickFolder
  };

})(window.FM);
