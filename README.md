# FastMike

Edit fast. Print fast. Keep working.

High-speed photo editing and printing for photographers working events, venues,
parties and performances — anywhere photographs have to be processed and printed
quickly.

**Import → Select → Crop → Adjust → Copy Settings → Print → Continue**

Originals are opened read-only and are never modified.

---

## Running it

### Windows

Download the portable build and double-click it — no installation. Or run the
installer for a desktop shortcut.

Neither build is code-signed, so Windows SmartScreen shows an "unrecognised app"
warning the first time: **More info → Run anyway**.

### From source

```bash
npm install
npm start           # run
npm run dist        # build the Windows installer + portable .exe into dist/
```

### Quick look in a browser

The interface is plain HTML/CSS/JS, so it also runs without Electron:

```bash
npx http-server . -p 8080
# open http://localhost:8080/src/index.html
```

In browser mode there is no folder import and no direct printer selection — the
browser's own print dialog is used, and printing is not split per printer.
Everything else is identical.

---

## Interface

| Area | What it does |
|---|---|
| **Left — Actions** | Get New Photos (once a folder is set), Import Photos, Import Folder, Clear Session. Nothing that belongs on a keyboard shortcut. |
| **Left — Original Photos** | Imported photos as thumbnails. Click to select; the selected one gets a red border. A tick marks photos already sent to Edited. |
| **Centre — Editing Area** | Large preview with the **fixed** 15×20 crop frame. The frame never moves — the photo moves behind it, and everything outside it is hidden, so what you see is exactly what prints. |
| **Bottom — Edited Photos** | Print-ready versions, five across, two rows. Each has its own print button. |
| **Right — Adjustments** | Brightness, Highlights, Contrast, Shadows. Each has a slider and its own circular reset icon. |
| **Right — Frame** | Rotate Frame 90°, switching between 15×20 portrait and 20×15 landscape. |

## Crop

The frame is fixed at the 15×20 ratio and never moves. The photograph does.

- **Left-drag** to reposition
- **Mouse wheel** to zoom — the photo zooms **around the pointer**, so you scroll
  in on a face rather than on the middle of the frame
- **Double-click** or **Fit** to reset
- **Rotate Frame 90°** switches the frame between portrait and landscape. The
  frame rotates; the photograph is never rotated.

The photo can never be panned or zoomed out far enough to expose an edge, so prints
never come out with a white strip.

## Adjustments

Brightness, Highlights, Contrast and Shadows, all non-destructive. Three ways to
set each one:

- drag its slider
- **roll the mouse wheel over the slider** — no need to grab the handle
- roll the wheel over the photo itself, holding a key:

| Held key | Wheel over the photo |
|---|---|
| Ctrl | Brightness |
| Alt | Highlights |
| Shift | Contrast |
| Ctrl + Alt | Shadows |

While a key is held the wheel *only* adjusts — it never zooms at the same time.
The pairing lives in one place in the code (`WHEEL_KEYS` in `src/app.js`); moving
an adjustment onto a different key is one line.

Pressing Alt never opens a Windows menu bar — the app has no menu at all, so Alt
belongs to the editing.

Each adjustment has its own reset icon (a symbol, never the word "Reset"), and its
value turns amber when it is off zero. Double-clicking a slider also resets it.

## Copying adjustments between photos

Keyboard only — there are deliberately no Copy/Paste buttons in the interface.

- **Ctrl + C** copies the four adjustment values from the current photo
- **Ctrl + V** applies them to the selected photo

Only the settings are copied, never the image or the crop — framing differs on
every shot.

## Printing

**Individual** — every edited photo has its own print button. It asks how many
copies (1–5) and sends them straight out, without interrupting what you are editing.

**Batch** — the main Print button. Photos are organised into groups of ten:

- 7 photos → prints all seven immediately, no dialog
- 14 photos → offers exactly three choices: *Print 1–10*, *Print 11–14*, *Print All (14)*

Each photo is laid out on its own page at exactly its own size with zero margins, so
the printer driver never rescales the crop. Portrait and landscape photos are sent as
separate jobs, because a single job cannot mix page sizes.

Printing never blocks editing. Jobs go onto a queue and are handed out in the
background while you carry on editing.

There is **one queue per printer**. Two dye-subs run at the same time — a job for the
DNP never sits waiting behind a job for the Citizen. Two photographers pointed at the
*same* printer take turns, because a printer can only do one thing at a time.

## Paper

FastMike prints one format: **6 × 8 inch — the media sold in Europe as 15 × 20 cm**,
and what DNP (DS620, RX1HS, DS820) and Citizen (CX-02) dye-sub printers actually load.

Pages are handed to the driver as exactly 152.4 × 203.2 mm and rendered at
**1800 × 2400 px at 300 dpi**, which is the native page of those printers. Sending a
rounded 150 × 200 mm page instead would make the driver rescale the image and can
leave a sliver of unprinted paper along one edge.

6:8 is the same 3:4 ratio as 15:20, so the crop frame on screen is unaffected.

## Several photographers on one laptop

Each photographer gets a tab along the top. A tab holds **his own imported photos, his
own edited set, and his own printer** — clicking a name swaps the whole working view
instantly, and nothing is copied or reloaded.

- **+ Photographer** adds one. Double-click a tab to rename, the `×` removes.
- `Ctrl+1` … `Ctrl+9` jump between them without touching the mouse.
- The number on a tab is how many of that photographer's photos are sitting in Edited,
  waiting to go out.
- **Clear Session** only clears the photographer whose tab is open. The others keep
  working.

### His own folder

Each photographer shoots into his own folder. **Import Folder** picks it once and the
tab remembers it; from then on **Get New Photos** reads that folder again with one
click — no dialog, no chance of opening the wrong folder at eleven at night with a
queue of people waiting.

It only brings in what is not already on the tab, so it can be pressed as often as you
like as new frames land. If the folder has been moved or unplugged it says so rather
than quietly importing nothing.

Anything printed goes to the printer belonging to whoever's tab is open, so two
photographers can be sending pages at the same time and each set comes out of the
right machine.

The photographers and their printers are written to disk, not the photographs. If the
app is restarted in the middle of an event, the setup is still there.

## Printer setup

Choose the printer once per photographer, in the top right, and tick **Print without
asking**. The choice is saved to disk and restored next time, so nothing has to be
picked again mid-event.

On first run, if no printer has been chosen yet, FastMike looks for DNP, Citizen,
Sinfonia or Mitsubishi units rather than the Windows default — which at a venue is
usually an office laser or a PDF writer. With several dye-subs attached and several
photographers set up, they are handed out one each rather than all pointing at the
same machine. Two photographers can share one printer — that is normal with three
photographers and two printers, and the queue handles it.

## Print queue

The **Print Queue** button opens everything sent to a printer this session — the
photographs, the photographer they came from, the printer, the page size and whether
it actually printed.

At an event the usual question is *"did that one come out?"*, and this is the only
place that can answer it. A job that failed — paper out, printer asleep — is shown in
red with the reason and a **Try again** button; a job that has not started yet can be
cancelled. The badge on the button turns red when something has failed.

## Keyboard

| Key | Action |
|---|---|
| `↑ ↓ ← →` | previous / next photo |
| `Enter` | add current photo to Edited and jump to the next |
| `Ctrl+C` / `Ctrl+V` | copy / paste adjustments |
| `Ctrl+P` | print |
| `Ctrl+O` | import photos |
| `Ctrl+1` … `Ctrl+9` | switch photographer |
| `R` | rotate frame 90° |
| `0` | fit |
| `F2` | speed and graphics readout |

---

## How the rendering works

Adjustments run as a single GPU fragment shader, not a chain of 2D canvas passes.
That is what keeps the preview instant while a slider moves on a 24-megapixel file.
The live preview is rendered at screen size; the full-resolution file is only
processed when it actually leaves the app.

Highlights and shadows are masked by luminance, so lifting shadows does not wash out
a bright sky and pulling highlights down does not muddy the dark tones.

When a photo is added to Edited it is re-rendered through the same maths at true
print resolution — 1800 × 2400 px for 6 × 8 in at 300 dpi — so the print is a real
full-resolution render, not an upscaled preview.

### Keeping the drag smooth

Panning a 24-megapixel photograph means shrinking a 96 MB texture down to a
window-sized rectangle on every frame, and on laptop graphics that is what makes
dragging feel heavy. Four things prevent it:

- the preview draws from a **screen-sized copy** of the original (long edge 2400 px),
  made once when the photo is opened. Printing always goes back to the untouched
  original, so nothing that leaves the app is affected
- the on-screen WebGL context does **not** preserve its drawing buffer — that is only
  needed by the offscreen surface the print render reads back from, and it costs a
  full copy of the buffer every frame
- the stage background is a flat colour. While dragging, the mask over the photo is
  semi-transparent, so whatever sits underneath is repainted every frame; a repeating
  gradient there costs real frames per second
- if a drag is still slow on a particular machine, the canvas is quietly given fewer
  pixels **for the duration of that drag** and put back to full resolution the moment
  the mouse is released

`F2` shows what is actually happening: graphics card or software rendering, the frame
rate while the photo is moving, the canvas size, and the screen scaling factor.

Originals are read off disk as raw bytes rather than as base64 text. On a 24-megapixel
JPEG that is the difference between roughly 600 ms and 200 ms from clicking a photo to
seeing it.

### When the graphics card gives up

There is a second, CPU implementation of exactly the same maths. A WebGL context can
disappear at any time — a driver update, a laptop waking from sleep, a remote desktop
session, or a PC with no usable GPU — and when it does, Chromium keeps accepting draw
calls that quietly do nothing. That would mean blank previews and solid black prints
with no error shown anywhere. FastMike detects the loss and switches to the CPU path,
showing a "software rendering" badge next to the filename. Output is identical; a full
15×20 print render takes roughly 220 ms instead of 170 ms.

## Layout

```
main.js          Electron main process - file dialogs, settings, export, printing
preload.js       the only bridge between the interface and the machine

src/engine.js    preview rendering (GPU shader + CPU fallback + surface swap)
src/crop.js      crop positioning, frame geometry, zoom-about-pointer
src/photos.js    image loading and thumbnails
src/printing.js  full-resolution print render, batching, print jobs, export
src/app.js       interface, state and event wiring
```

Each concern lives in its own file so a change to, say, batching cannot disturb the
crop maths.

## Not built yet

Sections 17–18 of the specification (multiple photographers, one tab each, a printer
assigned per photographer) are now implemented — see *Several photographers on one
laptop* above.

Nothing else in the specification is outstanding. What is deliberately left out:
photographs themselves are never written to the settings file, and there is no
cross-photographer view — each tab is its own workspace, which is the point.
