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

  const round1 = (n) => String(Math.round(n * 10) / 10);

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

  /* ---------------------------------------------------------------- queue */

  /**
   * Printing must never hold up editing. Jobs go on a queue and are handed to
   * the printer one at a time in the background while the operator carries on
   * with the next photograph.
   *
   * Every job keeps the photographer it came from and the printer it is bound
   * for, so several photographers can be sending pages at once and each page
   * still comes out of the right machine. The finished jobs are kept as well -
   * that is what the print queue window shows, and it is the only way to tell
   * afterwards whether a photograph actually went out.
   */
  const jobs = [];                // every job this session, oldest first
  let running = null;
  let watcher = function () {};
  let jobSeq = 0;

  function onQueueChange(fn) { watcher = fn; }

  const isPending = (j) => j.status === 'queued' || j.status === 'printing';

  function queueStatus() {
    const waiting = jobs.filter(isPending);
    return {
      jobs: waiting.length,
      pages: waiting.reduce((n, j) => n + j.pages, 0),
      busy: !!running,
      failed: jobs.filter((j) => j.status === 'failed').length,
      done: jobs.filter((j) => j.status === 'done').length
    };
  }

  /** Job list for the print queue window, newest first. */
  function jobList() { return jobs.slice().reverse(); }

  /** Hand one page-size group to the printer. Replaceable for testing. */
  async function dispatch(group, opts) {
    const images = [];
    for (const e of group.items) {
      const dataUrl = await blobToDataUrl(e.blob);
      for (let i = 0; i < (e.copies || 1); i++) images.push(dataUrl);
    }
    return window.fastmike.printImages({
      images,
      widthMm: group.wMm,
      heightMm: group.hMm,
      printer: opts.printer || null,
      silent: !!opts.silent && !!opts.printer
    });
  }

  async function pump() {
    if (running) return;
    let job;
    while ((job = jobs.find((j) => j.status === 'queued'))) {
      running = job;
      job.status = 'printing';
      job.startedAt = Date.now();
      watcher(queueStatus());
      try {
        const res = await FM.printing.dispatch(job.group, job.opts);
        if (res && res.success) {
          job.status = 'done';
        } else {
          job.status = 'failed';
          job.error = (res && res.reason) || 'print cancelled';
          watcher(queueStatus(), { error: job.error, job });
        }
      } catch (err) {
        job.status = 'failed';
        job.error = err.message;
        watcher(queueStatus(), { error: job.error, job });
      }
      job.finishedAt = Date.now();
      running = null;
      watcher(queueStatus());
    }
  }

  /** Queue photos for printing and return immediately. */
  function send(entries, opts) {
    if (!entries.length) return { queued: 0 };
    opts = opts || {};

    if (!DESKTOP) return sendNow(entries, opts);

    const made = plan(entries).map((group) => ({
      id: 'j' + (++jobSeq),
      group,
      opts,
      pages: group.pages,
      photographer: opts.photographer || '',
      colour: opts.colour || '',
      printer: opts.printer || 'system dialog',
      names: group.items.map((e) => e.name),
      // 152.4 rather than 152.39999999999998 - it is a label, not a measurement
      size: round1(group.wMm) + ' × ' + round1(group.hMm) + ' mm',
      status: 'queued',
      queuedAt: Date.now()
    }));

    jobs.push(...made);
    watcher(queueStatus());
    pump();
    return { queued: made.reduce((n, j) => n + j.pages, 0) };
  }

  /** Put a failed job back on the queue - usually the printer just ran out. */
  function retry(id) {
    const j = jobs.find((x) => x.id === id && x.status === 'failed');
    if (!j) return false;
    j.status = 'queued';
    j.error = null;
    j.queuedAt = Date.now();
    watcher(queueStatus());
    pump();
    return true;
  }

  /** Drop a job that has not started yet. */
  function cancel(id) {
    const i = jobs.findIndex((x) => x.id === id && x.status === 'queued');
    if (i < 0) return false;
    jobs.splice(i, 1);
    watcher(queueStatus());
    return true;
  }

  /** Clear the finished and failed rows so the window stays readable. */
  function clearFinished() {
    for (let i = jobs.length - 1; i >= 0; i--) {
      if (!isPending(jobs[i])) jobs.splice(i, 1);
    }
    watcher(queueStatus());
  }

  /** Browser demo path - straight to the browser's own print dialog. */
  function sendNow(entries) {
    const bySize = plan(entries);
    const first = bySize[0];
    const pages = [];
    for (const g of bySize) {
      for (const e of g.items) {
        for (let i = 0; i < (e.copies || 1); i++) {
          pages.push(`<div class="pg" style="width:${g.wMm}mm;height:${g.hMm}mm"><img src="${e.url}"></div>`);
        }
      }
    }
    const w = window.open('', '_blank');
    w.document.write(
      `<style>@page{size:${first.wMm}mm ${first.hMm}mm;margin:0}body{margin:0}
       .pg{page-break-after:always;overflow:hidden}
       .pg img{width:100%;height:100%;object-fit:fill;display:block}</style>` + pages.join('')
    );
    w.document.close();
    w.onload = () => w.print();
    return { queued: pages.length };
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

  FM.printing = {
    BATCH, init, renderToPrint, groups, plan, send, dispatch,
    onQueueChange, queueStatus, jobList, retry, cancel, clearFinished,
    exportFiles, blobToDataUrl
  };

})(window.FM);
