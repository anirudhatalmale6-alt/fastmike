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

  function makeThumb(img, maxW, maxH) {
    const s = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * s));
    c.height = Math.max(1, Math.round(img.naturalHeight * s));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.72);
  }

  /** Resolve a photo to something an <img> can load. */
  function srcFor(photo) {
    if (photo.path && DESKTOP) return window.fastmike.readImage(photo.path);
    return Promise.resolve(photo.url);
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
        // decoded once here for the thumbnail, then released - see srcFor()
        const src = entry.path && DESKTOP
          ? await window.fastmike.readImage(entry.path)
          : entry.url;
        const img = await loadImage(src);
        made.push({
          id: nextId(),
          name: entry.name,
          path: entry.path || null,
          url: entry.url || null,
          thumb: makeThumb(img, 320, 320),
          w: img.naturalWidth,
          h: img.naturalHeight,
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
    DESKTOP, NEUTRAL, newState, loadImage, makeThumb, srcFor, build, pickFiles, pickFolder
  };

})(window.FM);
