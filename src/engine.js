/* FastMike - preview rendering
 * ---------------------------------------------------------------------------
 * Two interchangeable tone engines and the surface that owns whichever one is
 * currently healthy. Nothing in here knows about photos, crops or printing -
 * it is handed a rectangle and four numbers and draws pixels.
 */

'use strict';

window.FM = window.FM || {};

(function (FM) {

  /* --------------------------------------------------------------- shaders */

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

  /* ------------------------------------------------------------ GPU engine */

  class ToneRenderer {
    /**
     * `readback` is for the offscreen surface the print render uses, which has
     * to read the finished frame back out with toBlob(). It costs a full copy
     * of the drawing buffer on every frame, so the on-screen preview - which is
     * never read back - does without it and simply swaps buffers.
     */
    constructor(canvas, readback) {
      this.canvas = canvas;
      const opts = {
        alpha: true,
        premultipliedAlpha: false,
        preserveDrawingBuffer: !!readback,
        antialias: false
      };
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

    /** Upload an image. Cached, so re-rendering the same photo is free. */
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

    draw(rect, adj) {
      const gl = this.gl;
      const W = this.canvas.width;
      const H = this.canvas.height;

      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!this.texture || !rect.w || !rect.h) return;

      const x0 = (rect.x / W) * 2 - 1;
      const x1 = ((rect.x + rect.w) / W) * 2 - 1;
      const y0 = 1 - (rect.y / H) * 2;
      const y1 = 1 - ((rect.y + rect.h) / H) * 2;

      const pos = new Float32Array([x0, y0, x1, y0, x0, y1, x1, y1]);
      const uv = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);

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

  /* ------------------------------------------------------------ CPU engine */

  function smoothstep(e0, e1, x) {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  }

  /**
   * The safety net. A WebGL context can go away at any time - a driver update,
   * a laptop waking from sleep, a remote desktop session, or a PC with no
   * usable GPU - and Chromium keeps accepting draw calls that quietly do
   * nothing. That would mean blank previews and solid black prints with no
   * error shown anywhere, so the same maths exists here in plain JS.
   */
  class CpuRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { willReadFrequently: true });
      this.img = null;
      this.isCpu = true;
    }

    setImage(img) { this.img = img; }
    releaseImage() { this.img = null; }

    draw(rect, adj) {
      const c = this.canvas;
      const ctx = this.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      if (!this.img || !rect.w || !rect.h) return;

      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.img, rect.x, rect.y, rect.w, rect.h);
      this._tone(rect, adj);
    }

    /** Same maths as the fragment shader, over the drawn region only. */
    _tone(rect, adj) {
      const { brightness, highlights, contrast, shadows } = adj;
      if (!brightness && !highlights && !contrast && !shadows) return;

      const c = this.canvas;
      const x0 = Math.max(0, Math.floor(rect.x));
      const y0 = Math.max(0, Math.floor(rect.y));
      const x1 = Math.min(c.width, Math.ceil(rect.x + rect.w));
      const y1 = Math.min(c.height, Math.ceil(rect.y + rect.h));
      if (x1 <= x0 || y1 <= y0) return;

      const data = this.ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
      const px = data.data;

      // brightness + contrast are per-channel, so they collapse into one lookup
      const k = 1 + contrast * 0.75;
      const lut = new Float32Array(256);
      for (let i = 0; i < 256; i++) {
        lut[i] = (i / 255 + brightness * 0.42 - 0.5) * k + 0.5;
      }

      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] === 0) continue;
        let r = lut[px[i]];
        let g = lut[px[i + 1]];
        let b = lut[px[i + 2]];

        const lum =
          0.299 * Math.min(1, Math.max(0, r)) +
          0.587 * Math.min(1, Math.max(0, g)) +
          0.114 * Math.min(1, Math.max(0, b));

        const lift = shadows * (1 - smoothstep(0, 0.62, lum)) * 0.55 +
                     highlights * smoothstep(0.38, 1, lum) * 0.55;

        r += lift; g += lift; b += lift;

        px[i]     = r <= 0 ? 0 : r >= 1 ? 255 : (r * 255) | 0;
        px[i + 1] = g <= 0 ? 0 : g >= 1 ? 255 : (g * 255) | 0;
        px[i + 2] = b <= 0 ? 0 : b >= 1 ? 255 : (b * 255) | 0;
      }

      this.ctx.putImageData(data, x0, y0);
    }
  }

  /* ---------------------------------------------------------------- surface */

  /**
   * Owns a canvas and whichever engine is currently healthy. A canvas that has
   * ever handed out a WebGL context can never return a 2D one, so dropping to
   * the CPU engine means swapping in a fresh canvas element.
   */
  class Surface {
    constructor(canvas, onDowngrade, readback) {
      this.canvas = canvas;
      this.onDowngrade = onDowngrade || function () {};
      this.readback = !!readback;
      this.image = null;
      this._useGl();
    }

    _useGl() {
      try {
        this.engine = new ToneRenderer(this.canvas, this.readback);
        this.mode = 'gl';
        this.canvas.addEventListener('webglcontextlost', (e) => {
          e.preventDefault();      // required, or the context is never restored
          this.useCpu('lost');
        });
      } catch (err) {
        this.useCpu('unavailable');
      }
    }

    useCpu(reason) {
      if (this.mode === 'cpu') return;
      const fresh = document.createElement('canvas');
      fresh.id = this.canvas.id;
      fresh.className = this.canvas.className;
      fresh.width = this.canvas.width;
      fresh.height = this.canvas.height;
      if (this.canvas.parentNode) this.canvas.replaceWith(fresh);
      this.canvas = fresh;
      this.engine = new CpuRenderer(fresh);
      this.mode = 'cpu';
      if (this.image) this.engine.setImage(this.image);
      this.onDowngrade('cpu', reason);
    }

    setImage(img) {
      this.image = img;
      this.engine.setImage(img);
    }

    releaseImage() {
      this.image = null;
      this.engine.releaseImage();
    }

    draw(rect, adj) {
      this.engine.draw(rect, adj);
      // A lost context reports no error and draws nothing, so check rather
      // than trusting the call to have worked.
      if (this.mode === 'gl' && this.engine.gl.isContextLost()) {
        this.useCpu('lost');
        this.engine.draw(rect, adj);
      }
    }
  }

  FM.ToneRenderer = ToneRenderer;
  FM.CpuRenderer = CpuRenderer;
  FM.Surface = Surface;

})(window.FM);
