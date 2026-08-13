# FastMike

Fast photo editing and instant printing for event photographers.

**Import → Select → Crop → Adjust → Copy Settings → Print → Continue**

Built for speed at an event, not for being a general-purpose editor. Originals are
opened read-only and are never modified.

---

## Running it

### Desktop (Windows / macOS / Linux)

```bash
npm install
npm start
```

### Windows installer + portable .exe

```bash
npm run dist
```

Output lands in `dist/`.

### Quick look in a browser

The interface is plain HTML/CSS/JS, so it also runs without Electron:

```bash
npx http-server . -p 8080
# open http://localhost:8080/src/index.html
```

In browser mode, folder import and direct printer selection are unavailable
(the browser's own print dialog is used instead). Everything else is identical.

---

## Interface

| Area | What it does |
|---|---|
| **Left — Original Photos** | Imported photos as thumbnails. Click to select; the selected one gets a red border. A tick badge marks photos already added to the print queue. |
| **Centre — Editing Area** | Large preview with a **fixed** 15×20 crop frame. The frame never moves — the photo moves behind it. Everything outside the frame is hidden, so what you see is exactly what prints. |
| **Bottom — Edited Photos** | Print-ready versions, laid out five across, two rows. Tick the ones to print or export. |
| **Right — Adjustments** | Brightness, Highlights, Contrast, Shadows. Each has a slider and its own circular reset icon. Changes render immediately. |

## Cropping

- **Drag** the photo to reposition it behind the frame
- **Scroll** (or the zoom slider) to zoom, 100–400%
- **Double-click** or **Fit** to reset the crop
- **↺ / ↻** rotate in 90° steps

The photo can never be panned far enough to leave a gap inside the frame, so
prints never come out with a white edge.

## Copy Settings

`Copy Settings` stores the four adjustment values from the current photo.

- **Ctrl+V** applies them to the selected photo
- **Paste to All** applies them to every imported photo

Crop position is deliberately *not* copied — the framing is different for every shot.

## Printing

Choose the printer and copy count in the top-right, then `Print`. Each photo is
laid out on its own page at exactly the chosen paper size with zero margins, so
the printer driver never rescales the crop.

`Skip printer dialog` sends jobs straight to the selected printer — the setting to
use once the printer is dialled in and the queue is moving.

Print size and quality are on the right: 15×20, 10×15, 13×18 and 20×30 cm, at
300 / 240 / 200 dpi. Changing the print size changes the crop frame's shape to match.

## Keyboard

| Key | Action |
|---|---|
| `↑ ↓ ← →` | previous / next photo |
| `Enter` | add current photo to the print queue and jump to the next |
| `Ctrl+C` | copy settings |
| `Ctrl+V` | paste settings onto the selected photo |
| `Ctrl+P` | print |
| `Ctrl+O` | import photos |
| `R` / `Shift+R` | rotate right / left |
| `0` | fit |

---

## How the rendering works

Adjustments run as a single GPU fragment shader (`src/renderer.js`), not as a chain
of 2D canvas passes. That is what keeps the preview responsive while dragging a
slider on a 24-megapixel file.

Highlights and shadows are masked by luminance, so lifting shadows does not wash out
a bright sky and pulling highlights down does not muddy the dark tones.

There is a second, CPU implementation of exactly the same maths. A WebGL context can
disappear at any time — a driver update, a laptop waking from sleep, a remote desktop
session, or a PC with no usable GPU at all — and when it does, Chromium keeps accepting
draw calls that quietly do nothing. That would mean blank previews and solid black
prints with no error shown anywhere. FastMike detects the loss and switches to the CPU
path, showing a "software rendering" badge next to the filename. Output is identical;
a full 15×20 print render takes roughly 220 ms instead of 170 ms.

When a photo is added to the print queue it is re-rendered through the same shader
at full print resolution (1772 × 2362 px for 15×20 cm at 300 dpi), so the print is a
true full-resolution render and not an upscaled preview.

## Layout

```
main.js       Electron main process - file dialogs, export to disk, printing
preload.js    the only bridge between the UI and the filesystem
src/index.html
src/styles.css
src/renderer.js   UI, crop geometry, WebGL tone engine, print render
samples/      a few generated test images
```
