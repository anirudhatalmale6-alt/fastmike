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
browser's own print dialog is used. Everything else is identical.

---

## Interface

| Area | What it does |
|---|---|
| **Left — Actions** | Import Photos, Import Folder, Clear Session. Nothing that belongs on a keyboard shortcut. |
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
- for the two most-used controls, roll the wheel over the photo itself:
  **Ctrl + Wheel → Brightness**, **Alt + Wheel → Highlights**

Hold Shift with any of those for larger steps.

While Ctrl or Alt is held the wheel *only* adjusts — it never zooms at the same time.

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

## Printer setup

Choose the printer once, in the top right, and tick **Print without asking**. The
choice is saved to disk and restored next time, so nothing has to be picked again
mid-event. Target printers are dye-sublimation units such as DNP and Citizen CX.

## Keyboard

| Key | Action |
|---|---|
| `↑ ↓ ← →` | previous / next photo |
| `Enter` | add current photo to Edited and jump to the next |
| `Ctrl+C` / `Ctrl+V` | copy / paste adjustments |
| `Ctrl+P` | print |
| `Ctrl+O` | import photos |
| `R` | rotate frame 90° |
| `0` | fit |

---

## How the rendering works

Adjustments run as a single GPU fragment shader, not a chain of 2D canvas passes.
That is what keeps the preview instant while a slider moves on a 24-megapixel file.
The live preview is rendered at screen size; the full-resolution file is only
processed when it actually leaves the app.

Highlights and shadows are masked by luminance, so lifting shadows does not wash out
a bright sky and pulling highlights down does not muddy the dark tones.

When a photo is added to Edited it is re-rendered through the same maths at true
print resolution — 1772 × 2362 px for 15×20 cm at 300 dpi — so the print is a real
full-resolution render, not an upscaled preview.

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

Section 17–18 of the specification (multiple photographers, one tab each, a printer
assigned per photographer) is marked as a future version and is **not** implemented.
Printer configuration is already stored in a settings file, which is where
per-photographer printers would hang off.
