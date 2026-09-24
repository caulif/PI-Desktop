import { deflateSync } from "node:zlib";

/**
 * OS shell badge for durable task outcomes.
 *
 * Count = ALL unread `task.completed` + `task.failed` rows (host
 * `notification.list` unreadCount). This is intentionally different from the
 * D295 bell inbox in `notification-inbox.ts`, which still lists and badges
 * failures only.
 *
 * Display policy: counts 1–9 show the digit; counts ≥10 show "9+" so a 16×16
 * Windows overlay stays readable.
 */

const OVERLAY_SIZE = 16;

/** 3×5 bitmap glyphs; bit 0 is the leftmost pixel of each row. */
const GLYPHS: Record<string, number[]> = {
  "0": [0b111, 0b101, 0b101, 0b101, 0b111],
  "1": [0b010, 0b110, 0b010, 0b010, 0b111],
  "2": [0b111, 0b001, 0b111, 0b100, 0b111],
  "3": [0b111, 0b001, 0b111, 0b001, 0b111],
  "4": [0b101, 0b101, 0b111, 0b001, 0b001],
  "5": [0b111, 0b100, 0b111, 0b001, 0b111],
  "6": [0b111, 0b100, 0b111, 0b101, 0b111],
  "7": [0b111, 0b001, 0b001, 0b001, 0b001],
  "8": [0b111, 0b101, 0b111, 0b101, 0b111],
  "9": [0b111, 0b101, 0b111, 0b001, 0b111],
  "+": [0b000, 0b010, 0b111, 0b010, 0b000],
};

/**
 * Format the overlay accessibility label / drawn text for an unread count.
 * Returns null when the overlay should be cleared.
 */
export function formatTaskbarUnreadOverlayLabel(count: number): string | null {
  const n = Math.floor(Number(count));
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 10) return "9+";
  return String(n);
}

/**
 * Build a deterministic 16×16 PNG (black circle, white digits) for
 * `BrowserWindow.setOverlayIcon`. Returns null when count clears the overlay.
 */
export function buildTaskbarUnreadOverlayPng(count: number): Buffer | null {
  const label = formatTaskbarUnreadOverlayLabel(count);
  if (!label) return null;
  const rgba = new Uint8Array(OVERLAY_SIZE * OVERLAY_SIZE * 4);
  const cx = (OVERLAY_SIZE - 1) / 2;
  const cy = (OVERLAY_SIZE - 1) / 2;
  const radius = OVERLAY_SIZE / 2 - 0.5;
  for (let y = 0; y < OVERLAY_SIZE; y += 1) {
    for (let x = 0; x < OVERLAY_SIZE; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > radius * radius) continue;
      const i = (y * OVERLAY_SIZE + x) * 4;
      rgba[i] = 0;
      rgba[i + 1] = 0;
      rgba[i + 2] = 0;
      rgba[i + 3] = 255;
    }
  }
  paintLabel(rgba, label);
  return encodeRgbaPng(OVERLAY_SIZE, OVERLAY_SIZE, rgba);
}

function paintLabel(rgba: Uint8Array, label: string): void {
  const glyphW = 3;
  const glyphH = 5;
  const gap = 1;
  const totalW = label.length * glyphW + (label.length - 1) * gap;
  let originX = Math.floor((OVERLAY_SIZE - totalW) / 2);
  const originY = Math.floor((OVERLAY_SIZE - glyphH) / 2);
  for (const ch of label) {
    const rows = GLYPHS[ch];
    if (!rows) continue;
    for (let gy = 0; gy < glyphH; gy += 1) {
      const row = rows[gy] ?? 0;
      for (let gx = 0; gx < glyphW; gx += 1) {
        if (((row >> (glyphW - 1 - gx)) & 1) !== 1) continue;
        const x = originX + gx;
        const y = originY + gy;
        if (x < 0 || y < 0 || x >= OVERLAY_SIZE || y >= OVERLAY_SIZE) continue;
        const i = (y * OVERLAY_SIZE + x) * 4;
        rgba[i] = 255;
        rgba[i + 1] = 255;
        rgba[i + 2] = 255;
        rgba[i + 3] = 255;
      }
    }
    originX += glyphW + gap;
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
