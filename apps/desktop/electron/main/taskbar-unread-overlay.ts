import { deflateSync } from "node:zlib";
import type { WebContents } from "electron";

/**
 * OS shell badge for durable task outcomes.
 *
 * Count = ALL unread `task.completed` + `task.failed` rows (host
 * `notification.list` unreadCount). This is intentionally different from the
 * D295 bell inbox in `notification-inbox.ts`, which still lists and badges
 * failures only.
 *
 * Display policy: counts 1–99 show the real digit string; counts ≥100 show
 * "99+" so a Windows overlay stays readable.
 *
 * Primary paint path: renderer Canvas via `webContents.executeJavaScript`
 * (Segoe UI fillText, system anti-aliasing) → PNG → setOverlayIcon.
 * Sync main-process SDF PNG is kept for unit tests and as a fallback when
 * webContents is unavailable.
 *
 * Shape: always a perfect black circle (ctx.arc / circle SDF). Multi-digit
 * and "99+" fit by shrinking font size inside the circle — never a pill,
 * capsule, roundRect, or ellipse. Black (#000) fill, white (#fff) text.
 */

/** Canvas / sync overlay raster size (px). Prefer ≥96 for taskbar scaling. */
export const TASKBAR_UNREAD_OVERLAY_SIZE = 96;

const OVERLAY_SIZE = TASKBAR_UNREAD_OVERLAY_SIZE;

/** 5×7 bitmap glyphs; bit 0 is the leftmost pixel of each row. */
const GLYPHS: Record<string, number[]> = {
  "0": [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  "1": [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  "2": [0b01110, 0b10001, 0b00001, 0b00110, 0b01000, 0b10000, 0b11111],
  "3": [0b01110, 0b10001, 0b00001, 0b00110, 0b00001, 0b10001, 0b01110],
  "4": [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  "5": [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  "6": [0b01110, 0b10000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  "7": [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  "8": [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  "9": [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00001, 0b01110],
  "+": [0b00000, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0b00000],
};

const GLYPH_W = 5;
const GLYPH_H = 7;

/**
 * Format the overlay accessibility label / drawn text for an unread count.
 * Returns null when the overlay should be cleared.
 */
export function formatTaskbarUnreadOverlayLabel(count: number): string | null {
  const n = Math.floor(Number(count));
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 100) return "99+";
  return String(n);
}

/**
 * Self-contained renderer script: draws the badge with Canvas fillText and
 * returns a PNG data URL (or null). Safe to pass to executeJavaScript.
 */
export function buildTaskbarUnreadOverlayCanvasScript(
  count: number,
): string | null {
  const label = formatTaskbarUnreadOverlayLabel(count);
  if (!label) return null;
  const size = OVERLAY_SIZE;
  const labelLit = JSON.stringify(label);
  // IIFE evaluates to a PNG data URL string (or null).
  return `(() => {
  const size = ${size};
  const label = ${labelLit};
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.clearRect(0, 0, size, size);
  const cx = size / 2;
  const cy = size / 2;
  const inset = size * 0.015;
  const r = size / 2 - inset;
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  let fontSize;
  if (label.length <= 1) fontSize = size * 0.65;
  else if (label.length === 2) fontSize = size * 0.48;
  else fontSize = size * 0.36;
  const fontFamily = "\\"Segoe UI Semibold\\", \\"Segoe UI\\", sans-serif";
  const maxTextW = r * 2 * 0.85;
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (;;) {
    ctx.font = "700 " + fontSize + "px " + fontFamily;
    if (ctx.measureText(label).width <= maxTextW || fontSize <= size * 0.18) break;
    fontSize -= size * 0.01;
  }
  ctx.fillText(label, cx, cy + fontSize * 0.03);
  return canvas.toDataURL("image/png");
})()`;
}

/**
 * Render the overlay PNG via renderer Canvas (executeJavaScript).
 * Returns null when count clears the overlay or webContents cannot paint.
 */
export async function renderTaskbarUnreadOverlayPng(
  webContents: Pick<WebContents, "isDestroyed" | "executeJavaScript"> | null | undefined,
  count: number,
): Promise<Buffer | null> {
  const label = formatTaskbarUnreadOverlayLabel(count);
  if (!label) return null;
  if (!webContents || webContents.isDestroyed()) return null;
  const script = buildTaskbarUnreadOverlayCanvasScript(count);
  if (!script) return null;
  const result = await webContents.executeJavaScript(script, true);
  if (typeof result !== "string" || result.length === 0) return null;
  if (result.startsWith("data:image/png;base64,")) {
    return Buffer.from(result.slice("data:image/png;base64,".length), "base64");
  }
  // Bare base64 fallback
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(result.slice(0, 64))) {
    try {
      return Buffer.from(result, "base64");
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Build a deterministic sync PNG (SDF anti-aliased black circle, white
 * bitmap digits) for unit tests and as a fallback when Canvas is unavailable.
 * Returns null when count clears the overlay.
 */
export function buildTaskbarUnreadOverlayPng(count: number): Buffer | null {
  const label = formatTaskbarUnreadOverlayLabel(count);
  if (!label) return null;
  const rgba = new Uint8Array(OVERLAY_SIZE * OVERLAY_SIZE * 4);
  paintBadgeShape(rgba);
  paintLabel(rgba, label);
  return encodeRgbaPng(OVERLAY_SIZE, OVERLAY_SIZE, rgba);
}

function clamp01(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

/** Coverage alpha from signed distance (positive = inside). ~1px AA rim. */
function coverageFromSdf(dist: number): number {
  return clamp01(0.5 + dist);
}

function paintBadgeShape(rgba: Uint8Array): void {
  const size = OVERLAY_SIZE;
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  // Match Canvas recipe: circle inset ~1.5% of SIZE (near edge-to-edge).
  const inset = size * 0.015;
  const radius = size / 2 - inset;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x - cx;
      const py = y - cy;
      const dist = radius - Math.sqrt(px * px + py * py);
      const alpha = coverageFromSdf(dist);
      if (alpha <= 0) continue;
      const i = (y * size + x) * 4;
      rgba[i] = 0;
      rgba[i + 1] = 0;
      rgba[i + 2] = 0;
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
}

/** Pixel scale and gap so the label fits inside the badge with padding. */
function layoutForLabel(label: string): { scale: number; gap: number } {
  const n = label.length;
  // Max usable content width ~82% of circle diameter (match Canvas maxTextW).
  const diameter = OVERLAY_SIZE - 2 * (OVERLAY_SIZE * 0.015);
  const maxW = diameter * 0.85;
  // Prefer larger glyphs when few characters.
  const preferred = n <= 1 ? 10 : n === 2 ? 7 : 5;
  const gapPreferred = n <= 1 ? 0 : n === 2 ? 4 : 2;
  for (let scale = preferred; scale >= 2; scale -= 0.5) {
    const gap = scale >= 4 ? gapPreferred : Math.max(1, Math.floor(scale / 2));
    const totalW = n * GLYPH_W * scale + (n - 1) * gap;
    if (totalW <= maxW) return { scale, gap };
  }
  return { scale: 2, gap: 1 };
}

function paintLabel(rgba: Uint8Array, label: string): void {
  const size = OVERLAY_SIZE;
  const { scale, gap } = layoutForLabel(label);
  const totalW = label.length * GLYPH_W * scale + (label.length - 1) * gap;
  const totalH = GLYPH_H * scale;
  let originX = (size - totalW) / 2;
  const originY = (size - totalH) / 2;

  for (const ch of label) {
    const rows = GLYPHS[ch];
    if (!rows) continue;
    for (let gy = 0; gy < GLYPH_H; gy += 1) {
      const row = rows[gy] ?? 0;
      for (let gx = 0; gx < GLYPH_W; gx += 1) {
        if (((row >> (GLYPH_W - 1 - gx)) & 1) !== 1) continue;
        paintSoftBlock(
          rgba,
          originX + gx * scale,
          originY + gy * scale,
          scale,
        );
      }
    }
    originX += GLYPH_W * scale + gap;
  }
}

/**
 * Draw a filled white block with ~1px coverage AA on the edges, blended over
 * the existing black badge (preserving shape alpha).
 */
function paintSoftBlock(
  rgba: Uint8Array,
  ox: number,
  oy: number,
  cell: number,
): void {
  const size = OVERLAY_SIZE;
  // Inset slightly so adjacent cells don't fuse into a blob; AA on the rim.
  const pad = Math.min(0.4, cell * 0.08);
  const x0 = ox + pad;
  const y0 = oy + pad;
  const x1 = ox + cell - pad;
  const y1 = oy + cell - pad;

  const minX = Math.max(0, Math.floor(x0 - 1));
  const maxX = Math.min(size - 1, Math.ceil(x1 + 1));
  const minY = Math.max(0, Math.floor(y0 - 1));
  const maxY = Math.min(size - 1, Math.ceil(y1 + 1));

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const dx = Math.max(x0 - px, 0, px - x1);
      const dy = Math.max(y0 - py, 0, py - y1);
      const outside = Math.sqrt(dx * dx + dy * dy);
      const insideX = Math.min(px - x0, x1 - px);
      const insideY = Math.min(py - y0, y1 - py);
      const inside = Math.min(insideX, insideY);
      const dist = outside > 0 ? -outside : inside;
      const cov = coverageFromSdf(dist);
      if (cov <= 0) continue;

      const i = (y * size + x) * 4;
      const shapeA = rgba[i + 3]! / 255;
      if (shapeA <= 0) continue;
      const t = cov;
      rgba[i] = Math.round(255 * t);
      rgba[i + 1] = Math.round(255 * t);
      rgba[i + 2] = Math.round(255 * t);
      rgba[i + 3] = Math.round(shapeA * 255);
    }
  }
}

function encodeRgbaPng(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < stride; x += 1) {
      raw[rowStart + 1 + x] = rgba[y * stride + x]!;
    }
  }
  const compressed = deflateSync(raw, { level: 9 });
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
