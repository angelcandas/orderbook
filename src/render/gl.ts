/**
 * Minimal WebGL2 batch renderer: two streamed batches, one draw call each per
 * pane, buffers preallocated and updated in place with bufferSubData.
 * Coordinates are CSS pixels; the shaders map to clip space.
 *   shapes: x, y, rgba per vertex    (rects, lines, areas; rects expand to 2 triangles)
 *   glyphs: x, y, u, v, rgba         (text from a monospace glyph atlas)
 *
 * Why not instancing: we measured instanced quads at ~25 us per instance on
 * SwiftShader (the software GL used by headless CI), 3,000 instances = 83 ms
 * per frame, while 20,000 plain triangles drew in one 16.7 ms frame. Expanding
 * quads to vertices on the CPU costs ~100 KB of upload per frame, which is
 * nothing on a real GPU, and keeps CI numbers meaningful.
 */

export type RGBA = number; // packed 0xAABBGGRR (little endian bytes r,g,b,a)
export const rgba = (r: number, g: number, b: number, a = 1): RGBA =>
  ((Math.round(a * 255) << 24) | (b << 16) | (g << 8) | r) >>> 0;
export const hex = (h: string, a = 1): RGBA => {
  const n = parseInt(h.slice(1), 16);
  return rgba((n >> 16) & 255, (n >> 8) & 255, n & 255, a);
};
export const withAlpha = (c: RGBA, a: number): RGBA => ((c & 0x00ffffff) | (Math.round(a * 255) << 24)) >>> 0;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
  return p;
}

const SHAPE_VS = `#version 300 es
layout(location=0) in vec2 pos;
layout(location=1) in vec4 color;
uniform vec2 res;
out vec4 vColor;
void main(){
  gl_Position = vec4(pos.x / res.x * 2.0 - 1.0, 1.0 - pos.y / res.y * 2.0, 0.0, 1.0);
  vColor = color;
}`;
const SHAPE_FS = `#version 300 es
precision mediump float;
in vec4 vColor;
out vec4 o;
void main(){ o = vec4(vColor.rgb * vColor.a, vColor.a); }`;

const GLYPH_VS = `#version 300 es
layout(location=0) in vec2 pos;
layout(location=1) in vec2 uvIn;
layout(location=2) in vec4 color;
uniform vec2 res;
out vec2 uv;
out vec4 vColor;
void main(){
  gl_Position = vec4(pos.x / res.x * 2.0 - 1.0, 1.0 - pos.y / res.y * 2.0, 0.0, 1.0);
  uv = uvIn;
  vColor = color;
}`;
const GLYPH_FS = `#version 300 es
precision mediump float;
in vec2 uv;
in vec4 vColor;
uniform sampler2D atlas;
out vec4 o;
void main(){
  float a = texture(atlas, uv).a * vColor.a;
  o = vec4(vColor.rgb * a, a);
}`;

class Batch {
  data: ArrayBuffer;
  f32: Float32Array;
  u32: Uint32Array;
  n = 0;
  buf: WebGLBuffer;
  constructor(gl: WebGL2RenderingContext, readonly strideWords: number, readonly cap: number) {
    this.data = new ArrayBuffer(strideWords * 4 * cap);
    this.f32 = new Float32Array(this.data);
    this.u32 = new Uint32Array(this.data);
    this.buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
  }
  upload(gl: WebGL2RenderingContext): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.f32, 0, this.n * this.strideWords);
  }
}

export interface Atlas {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  cols: number;
  rows: number;
  cellW: number; // css px
  cellH: number;
}

export function buildAtlas(fontPx: number, dpr: number): Atlas {
  const cols = 16;
  const rows = 6; // ASCII 32..127
  const probe = new OffscreenCanvas(8, 8).getContext('2d')!;
  const font = `${Math.round(fontPx * dpr)}px ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace`;
  probe.font = font;
  const cw = Math.ceil(probe.measureText('0').width);
  const ch = Math.ceil(fontPx * dpr * 1.3);
  const canvas = new OffscreenCanvas(cols * cw, rows * ch);
  const ctx = canvas.getContext('2d')!;
  ctx.font = font;
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  for (let c = 32; c < 128; c++) {
    const i = c - 32;
    ctx.fillText(String.fromCharCode(c), (i % cols) * cw, Math.floor(i / cols) * ch + ch / 2);
  }
  return { canvas, cols, rows, cellW: cw / dpr, cellH: ch / dpr };
}

export class Gfx {
  readonly gl: WebGL2RenderingContext;
  private shapeProg: WebGLProgram;
  private glyphProg: WebGLProgram;
  private shapeVao: WebGLVertexArrayObject;
  private glyphVao: WebGLVertexArrayObject;
  /** x, y, rgba per vertex */
  readonly shapes: Batch;
  /** x, y, u, v, rgba per vertex */
  readonly glyphs: Batch;
  private atlasTex: WebGLTexture;
  atlas!: Atlas;
  w = 1;
  h = 1;
  dpr = 1;
  /** EXT_disjoint_timer_query_webgl2, when exposed */
  private timer: any;
  private queries: WebGLQuery[] = [];
  gpuMs = -1;

  constructor(readonly canvas: OffscreenCanvas | HTMLCanvasElement, fontPx: number) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: true, desynchronized: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    this.shapeProg = compile(gl, SHAPE_VS, SHAPE_FS);
    this.glyphProg = compile(gl, GLYPH_VS, GLYPH_FS);

    this.shapes = new Batch(gl, 3, 240_000);
    this.shapeVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.shapeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.shapes.buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 12, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 12, 8);

    this.glyphs = new Batch(gl, 5, 60_000);
    this.glyphVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.glyphVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphs.buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 20, 16);
    gl.bindVertexArray(null);

    this.atlasTex = gl.createTexture()!;
    this.setFont(fontPx, 1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  }

  private locs = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  private loc(p: WebGLProgram, name: string): WebGLUniformLocation | null {
    let m = this.locs.get(p);
    if (!m) this.locs.set(p, (m = new Map()));
    let l = m.get(name);
    if (l === undefined) m.set(name, (l = this.gl.getUniformLocation(p, name)));
    return l;
  }

  setFont(fontPx: number, dpr: number): void {
    const gl = this.gl;
    this.atlas = buildAtlas(fontPx, dpr);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.atlas.canvas as any);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** Change the text size, keeping the current device pixel ratio. */
  setFontPx(fontPx: number): void { this.setFont(fontPx, this.dpr); }

  resize(w: number, h: number, dpr: number, fontPx: number): void {
    this.w = w;
    this.h = h;
    if (dpr !== this.dpr) {
      this.dpr = dpr;
      this.setFont(fontPx, dpr);
    }
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
  }

  /** css px² of rects submitted since the last reset, for overdraw checks */
  area = 0;
  begin(): void {
    this.shapes.n = 0;
    this.glyphs.n = 0;
  }

  private vtx(x: number, y: number, c: RGBA): void {
    const b = this.shapes;
    const o = b.n++ * 3;
    b.f32[o] = x; b.f32[o + 1] = y; b.u32[o + 2] = c;
  }

  rect(x: number, y: number, w: number, h: number, c: RGBA): void {
    if (this.shapes.n + 6 > this.shapes.cap) return;
    this.area += Math.abs(w * h);
    const x1 = x + w, y1 = y + h;
    this.vtx(x, y, c); this.vtx(x1, y, c); this.vtx(x, y1, c);
    this.vtx(x1, y, c); this.vtx(x1, y1, c); this.vtx(x, y1, c);
  }

  tri(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, c: RGBA): void {
    if (this.shapes.n + 3 > this.shapes.cap) return;
    this.vtx(x0, y0, c); this.vtx(x1, y1, c); this.vtx(x2, y2, c);
  }

  line(x0: number, y0: number, x1: number, y1: number, width: number, c: RGBA): void {
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * width * 0.5, ny = (dx / len) * width * 0.5;
    this.tri(x0 + nx, y0 + ny, x1 + nx, y1 + ny, x0 - nx, y0 - ny, c);
    this.tri(x1 + nx, y1 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny, c);
  }

  dashed(x0: number, y0: number, x1: number, y1: number, width: number, dash: number, c: RGBA): void {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.floor(len / (dash * 2)));
    for (let i = 0; i < n; i++) {
      const a = (i * 2 * dash) / len, b = Math.min(1, ((i * 2 + 1) * dash) / len);
      this.line(x0 + (x1 - x0) * a, y0 + (y1 - y0) * a, x0 + (x1 - x0) * b, y0 + (y1 - y0) * b, width, c);
    }
  }

  glyph(x: number, y: number, code: number, c: RGBA): void {
    const b = this.glyphs;
    if (b.n + 6 > b.cap) return;
    const a = this.atlas;
    // snap to device pixels so the atlas is sampled 1:1
    const d = this.dpr;
    x = Math.round(x * d) / d;
    y = Math.round(y * d) / d;
    const g = code - 32;
    const u0 = (g % a.cols) / a.cols, v0 = Math.floor(g / a.cols) / a.rows;
    const u1 = u0 + 1 / a.cols, v1 = v0 + 1 / a.rows;
    const x1 = x + a.cellW, y1 = y + a.cellH;
    const f = b.f32, u = b.u32;
    let o = b.n * 5;
    f[o] = x; f[o + 1] = y; f[o + 2] = u0; f[o + 3] = v0; u[o + 4] = c; o += 5;
    f[o] = x1; f[o + 1] = y; f[o + 2] = u1; f[o + 3] = v0; u[o + 4] = c; o += 5;
    f[o] = x; f[o + 1] = y1; f[o + 2] = u0; f[o + 3] = v1; u[o + 4] = c; o += 5;
    f[o] = x1; f[o + 1] = y; f[o + 2] = u1; f[o + 3] = v0; u[o + 4] = c; o += 5;
    f[o] = x1; f[o + 1] = y1; f[o + 2] = u1; f[o + 3] = v1; u[o + 4] = c; o += 5;
    f[o] = x; f[o + 1] = y1; f[o + 2] = u0; f[o + 3] = v1; u[o + 4] = c;
    b.n += 6;
  }

  /** draw ASCII text; returns its width */
  text(x: number, y: number, s: string, c: RGBA): number {
    const cw = this.atlas.cellW;
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code > 32 && code < 128) this.glyph(x + i * cw, y, code, c);
    }
    return s.length * cw;
  }

  textRight(xRight: number, y: number, s: string, c: RGBA): void {
    this.text(xRight - s.length * this.atlas.cellW, y, s, c);
  }

  /**
   * Draw a fixed-point number right-aligned at xRight without allocating a string.
   * Thousands separators on the integer part when `sep` is true.
   */
  private digits = new Uint8Array(40);
  number(xRight: number, y: number, value: number, decimals: number, c: RGBA, sep = true): number {
    const d = this.digits;
    let n = 0;
    const neg = value < 0;
    let v = Math.round(Math.abs(value) * 10 ** decimals);
    let pos = 0;
    // fractional digits
    for (let i = 0; i < decimals; i++) { d[n++] = 48 + (v % 10); v = Math.floor(v / 10); }
    if (decimals > 0) d[n++] = 46; // '.'
    do {
      if (sep && pos > 0 && pos % 3 === 0) d[n++] = 44; // ','
      d[n++] = 48 + (v % 10);
      v = Math.floor(v / 10);
      pos++;
    } while (v > 0 && n < 38);
    if (neg) d[n++] = 45;
    const cw = this.atlas.cellW;
    let x = xRight - n * cw;
    const x0 = x;
    for (let i = n - 1; i >= 0; i--) { this.glyph(x, y, d[i], c); x += cw; }
    return xRight - x0;
  }

  /**
   * Flush the batches. With `clip`, only that rectangle (css px) is cleared and
   * drawn: the drawing buffer is preserved, so panes that did not change keep
   * last frame's pixels and cost nothing.
   */
  end(bg: RGBA, clip?: { x: number; y: number; w: number; h: number }): void {
    const gl = this.gl;
    let q: WebGLQuery | null = null;
    if (this.timer) {
      // read back the oldest finished query, then start a new one
      if (this.queries.length > 2) {
        const old = this.queries[0];
        if (gl.getQueryParameter(old, gl.QUERY_RESULT_AVAILABLE)) {
          if (!gl.getParameter(this.timer.GPU_DISJOINT_EXT)) this.gpuMs = gl.getQueryParameter(old, gl.QUERY_RESULT) / 1e6;
          gl.deleteQuery(old);
          this.queries.shift();
        }
      }
      if (this.queries.length < 4) {
        q = gl.createQuery();
        gl.beginQuery(this.timer.TIME_ELAPSED_EXT, q!);
      }
    }
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    if (clip) {
      const d = this.dpr;
      const x = Math.floor(clip.x * d), y = Math.floor(clip.y * d);
      const w = Math.ceil((clip.x + clip.w) * d) - x, h = Math.ceil((clip.y + clip.h) * d) - y;
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(x, gl.drawingBufferHeight - y - h, w, h);
    }
    gl.clearColor(((bg) & 255) / 255, ((bg >> 8) & 255) / 255, ((bg >> 16) & 255) / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (this.shapes.n) {
      gl.useProgram(this.shapeProg);
      gl.uniform2f(this.loc(this.shapeProg, 'res'), this.w, this.h);
      this.shapes.upload(gl);
      gl.bindVertexArray(this.shapeVao);
      gl.drawArrays(gl.TRIANGLES, 0, this.shapes.n);
    }
    if (this.glyphs.n) {
      const p = this.glyphProg;
      gl.useProgram(p);
      gl.uniform2f(this.loc(p, 'res'), this.w, this.h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
      gl.uniform1i(this.loc(p, 'atlas'), 0);
      this.glyphs.upload(gl);
      gl.bindVertexArray(this.glyphVao);
      gl.drawArrays(gl.TRIANGLES, 0, this.glyphs.n);
    }
    gl.bindVertexArray(null);
    if (clip) gl.disable(gl.SCISSOR_TEST);
    if (q) {
      gl.endQuery(this.timer.TIME_ELAPSED_EXT);
      this.queries.push(q);
    }
  }
}
