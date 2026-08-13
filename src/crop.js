/* FastMike - crop positioning
 * ---------------------------------------------------------------------------
 * FastMike works in one print format: 15x20 cm. The frame is fixed on screen
 * and the photograph moves behind it. Rotating switches the FRAME between
 * 15x20 portrait and 20x15 landscape - the photograph itself is never rotated.
 *
 * All geometry lives here so the preview, the print render and the pan limits
 * can never disagree about where the crop is.
 */

'use strict';

window.FM = window.FM || {};

(function (FM) {

  const SHORT_MM = 150;
  const LONG_MM = 200;
  const DPI = 300;
  const MAX_ZOOM = 5;

  /** Page size in millimetres for a photo, honouring its frame rotation. */
  function pageMm(photo) {
    return photo && photo.state.landscape
      ? { w: LONG_MM, h: SHORT_MM }
      : { w: SHORT_MM, h: LONG_MM };
  }

  /** Output size in pixels at print resolution. */
  function printPixels(photo) {
    const mm = pageMm(photo);
    return {
      w: Math.round((mm.w / 25.4) * DPI),
      h: Math.round((mm.h / 25.4) * DPI)
    };
  }

  /** The fixed crop frame, centred in the stage with a little breathing room. */
  function frameIn(stageW, stageH, photo, pad) {
    pad = pad === undefined ? 34 : pad;
    const mm = pageMm(photo);
    const aspect = mm.w / mm.h;

    let h = stageH - pad * 2;
    let w = h * aspect;
    if (w > stageW - pad * 2) {
      w = stageW - pad * 2;
      h = w / aspect;
    }
    return {
      x: Math.round((stageW - w) / 2),
      y: Math.round((stageH - h) / 2),
      w: Math.round(w),
      h: Math.round(h)
    };
  }

  /**
   * Where the photo sits behind the frame.
   * At zoom 1 the photo exactly covers the frame - there is never a gap.
   */
  function photoRect(photo, frame) {
    const cover = Math.max(frame.w / photo.w, frame.h / photo.h);
    const s = cover * photo.state.zoom;
    const w = photo.w * s;
    const h = photo.h * s;
    return {
      x: frame.x + (frame.w - w) / 2 + photo.state.tx * frame.w,
      y: frame.y + (frame.h - h) / 2 + photo.state.ty * frame.h,
      w,
      h
    };
  }

  /** Keep every edge of the photo outside the frame - no white strips. */
  function clampPan(photo, frame) {
    if (!frame || !frame.w) return;
    const r = photoRect(photo, { x: 0, y: 0, w: frame.w, h: frame.h });
    const limX = Math.max(0, (r.w - frame.w) / 2) / frame.w;
    const limY = Math.max(0, (r.h - frame.h) / 2) / frame.h;
    photo.state.tx = Math.min(limX, Math.max(-limX, photo.state.tx));
    photo.state.ty = Math.min(limY, Math.max(-limY, photo.state.ty));
  }

  /**
   * Zoom by `factor`, keeping whatever is under the pointer under the pointer.
   * Pass no pointer to zoom about the centre of the frame.
   */
  function zoomBy(photo, frame, factor, pointer) {
    const before = photoRect(photo, frame);
    const next = Math.min(MAX_ZOOM, Math.max(1, photo.state.zoom * factor));
    if (next === photo.state.zoom) return;

    const px = pointer ? pointer.x : frame.x + frame.w / 2;
    const py = pointer ? pointer.y : frame.y + frame.h / 2;

    // where the pointer sits within the photo, 0..1
    const u = (px - before.x) / before.w;
    const v = (py - before.y) / before.h;

    photo.state.zoom = next;

    const after = photoRect(photo, { x: frame.x, y: frame.y, w: frame.w, h: frame.h });
    // solve for the pan that puts (u, v) back under the pointer
    photo.state.tx += (px - (after.x + u * after.w)) / frame.w;
    photo.state.ty += (py - (after.y + v * after.h)) / frame.h;

    clampPan(photo, frame);
  }

  function fit(photo) {
    photo.state.zoom = 1;
    photo.state.tx = 0;
    photo.state.ty = 0;
  }

  FM.crop = {
    SHORT_MM, LONG_MM, DPI, MAX_ZOOM,
    pageMm, printPixels, frameIn, photoRect, clampPan, zoomBy, fit
  };

})(window.FM);
