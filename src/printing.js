/* FastMike - print rendering, batching and output
 * ---------------------------------------------------------------------------
 * The live preview is a fast approximation sized to the screen. Anything that
 * leaves the app - a print or an exported file - is re-rendered from the
 * original at full print resolution through the same tone engine.
 */

'use strict';

window.FM = window.FM || {};

(function (FM) {

  const DESKTOP = !!(window.fastmike && window.fastmike.isDesktop);
  const BATCH = 10;               // photos per printing group

  let surface = null;             // offscreen Surface used for print renders

  function init(exportSurface) {
    surface = exportSurface;
  }

  /** Render one photo at full print resolution. */
  async function renderToPrint(photo, img) {
    const out = FM.crop.printPixels(photo);
    const mm = FM.crop.pageMm(photo);

    surface.canvas.width = out.w;
    surface.canvas.height = out.h;

    const frame = { x: 0, y: 0, w: out.w, h: out.h };
    const rect = FM.crop.photoRect(photo, frame);

    surface.setImage(img);
    surface.draw(rect, photo.state);

    const blob = await new Promise((resolve) => {
      surface.canvas.toBlob(resolve, 'image/jpeg', 0.95);
    });
    surface.releaseImage();

    return { blob, wMm: mm.w, hMm: mm.h };
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.readAsDataURL(blob);
    });
  }

  /**
   * Split a list into printing groups of ten.
   * 14 photos -> [{from:1,to:10}, {from:11,to:14}]
   */
  function groups(count) {
    const out = [];
    for (let i = 0; i < count; i += BATCH) {
      out.push({ from: i + 1, to: Math.min(i + BATCH, count), start: i, end: Math.min(i + BATCH, count) });
    }
    return out;
  }

  /**
   * Work out the print jobs for a set of photos.
   *
   * Pages of different sizes cannot share one print job, so entries are grouped
   * by page size - in practice at most two, portrait and landscape.
   * Pure and synchronous, so the page counts can be checked without printing.
   */
  function plan(entries) {
    const bySize = new Map();
    for (const e of entries) {
      const key = e.wMm + 'x' + e.hMm;
      if (!bySize.has(key)) bySize.set(key, { wMm: e.wMm, hMm: e.hMm, items: [], pages: 0 });
      const g = bySize.get(key);
      g.items.push(e);
      g.pages += e.copies || 1;
    }
    return Array.from(bySize.values());
  }

  /** Send photos to the printer. */
  async function send(entries, opts) {
    if (!entries.length) return { success: false, reason: 'nothing selected' };

    const bySize = plan(entries);

    if (!DESKTOP) {
      // browser demo path - the browser's own print dialog
      const first = bySize[0];
      const w = window.open('', '_blank');
      const pages = [];
      for (const g of bySize) {
        for (const e of g.items) {
          for (let i = 0; i < (e.copies || 1); i++) {
            pages.push(`<div class="pg" style="width:${g.wMm}mm;height:${g.hMm}mm"><img src="${e.url}"></div>`);
          }
        }
      }
      w.document.write(
        `<style>@page{size:${first.wMm}mm ${first.hMm}mm;margin:0}body{margin:0}
         .pg{page-break-after:always;overflow:hidden}
         .pg img{width:100%;height:100%;object-fit:fill;display:block}</style>` + pages.join('')
      );
      w.document.close();
      w.onload = () => w.print();
      return { success: true };
    }

    let last = { success: true };
    for (const g of bySize) {
      const images = [];
      for (const e of g.items) {
        const dataUrl = await blobToDataUrl(e.blob);
        for (let i = 0; i < (e.copies || 1); i++) images.push(dataUrl);
      }
      last = await window.fastmike.printImages({
        images,
        widthMm: g.wMm,
        heightMm: g.hMm,
        printer: opts.printer || null,
        silent: !!opts.silent && !!opts.printer
      });
      if (!last || !last.success) return last || { success: false };
    }
    return last;
  }

  /** Write print-ready files to a folder the user chooses. */
  async function exportFiles(entries) {
    if (!entries.length) return 0;

    if (!DESKTOP) {
      entries.forEach((e) => {
        const a = document.createElement('a');
        a.href = e.url;
        a.download = e.name;
        a.click();
      });
      return entries.length;
    }

    const folder = await window.fastmike.pickExportFolder();
    if (!folder) return 0;
    for (const e of entries) {
      await window.fastmike.writeExport(folder, e.name, await blobToDataUrl(e.blob));
    }
    return entries.length;
  }

  FM.printing = { BATCH, init, renderToPrint, groups, plan, send, exportFiles, blobToDataUrl };

})(window.FM);
