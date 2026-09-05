/* FastMike - the page handed to the printer
 * ---------------------------------------------------------------------------
 * Kept out of main.js so the geometry can be rendered in a browser and measured
 * without Electron and without a printer. Getting this wrong is expensive: it
 * is paper and ribbon, and it is only visible after the print has come out.
 *
 * A dye-sub sheet has one shape - 6 inches across, cut to 8 inches long. The
 * driver has no 8x6 form, so asking for one gets the page letterboxed onto 6x8
 * with white bands, which is exactly the fault that started this. A landscape
 * print therefore goes on the SAME 6x8 sheet with the photo turned a quarter
 * turn, which is what a landscape print physically is.
 */

'use strict';

/** The sheet a page of wMm x hMm is printed on - always the upright media. */
function sheetFor(wMm, hMm) {
  const land = wMm > hMm;
  return { land, w: land ? hMm : wMm, h: land ? wMm : hMm };
}

/**
 * Build the print document.
 * askSize false hands the page size back to the driver - see print:images.
 */
function printHtml(images, wMm, hMm, askSize) {
  const s = sheetFor(wMm, hMm);

  // rotating a wMm x hMm box about its centre leaves an s.w x s.h footprint, so
  // the turned photo lands exactly on the sheet with nothing spare on any edge
  const imgCss = s.land
    ? 'width: ' + wMm + 'mm; height: ' + hMm + 'mm;' +
      ' position: absolute; left: 50%; top: 50%;' +
      ' transform: translate(-50%, -50%) rotate(90deg);'
    : 'width: 100%; height: 100%;';

  const pages = images.map((d) => '<div class="page"><img src="' + d + '"></div>').join('');

  return '<!doctype html>\n' +
    '<html><head><meta charset="utf-8"><style>\n' +
    '  @page { size: ' + (askSize === false ? 'auto' : s.w + 'mm ' + s.h + 'mm') + '; margin: 0; }\n' +
    '  html, body { margin: 0; padding: 0; background: #fff; }\n' +
    '  .page {\n' +
    '    width: ' + s.w + 'mm; height: ' + s.h + 'mm;\n' +
    '    page-break-after: always; overflow: hidden; position: relative;\n' +
    '  }\n' +
    '  .page:last-child { page-break-after: auto; }\n' +
    '  .page img { display: block; object-fit: fill; ' + imgCss + ' }\n' +
    '</style></head><body>' + pages + '</body></html>';
}

/** Microns for webContents.print - the sheet, never a rotated one. */
function pageSizeMicrons(wMm, hMm) {
  const s = sheetFor(wMm, hMm);
  return { width: Math.round(s.w * 1000), height: Math.round(s.h * 1000) };
}

module.exports = { sheetFor, printHtml, pageSizeMicrons };
