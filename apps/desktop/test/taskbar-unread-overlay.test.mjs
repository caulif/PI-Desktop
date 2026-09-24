import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  TASKBAR_UNREAD_OVERLAY_SIZE,
  buildTaskbarUnreadOverlayCanvasScript,
  buildTaskbarUnreadOverlayPng,
  formatTaskbarUnreadOverlayLabel,
  renderTaskbarUnreadOverlayPng,
} from "../electron/main/taskbar-unread-overlay.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Read PNG IHDR width/height (big-endian) after the 8-byte signature + 4-byte length + "IHDR". */
function readPngIhdrSize(png) {
  assert.ok(Buffer.isBuffer(png));
  assert.ok(png.length >= 24);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.toString("ascii", 12, 16), "IHDR");
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  };
}

test("clears the overlay label and png when count is zero or negative", () => {
  assert.equal(formatTaskbarUnreadOverlayLabel(0), null);
  assert.equal(formatTaskbarUnreadOverlayLabel(-3), null);
  assert.equal(buildTaskbarUnreadOverlayPng(0), null);
  assert.equal(buildTaskbarUnreadOverlayPng(-1), null);
  assert.equal(buildTaskbarUnreadOverlayCanvasScript(0), null);
  assert.equal(buildTaskbarUnreadOverlayCanvasScript(-1), null);
});

test("formats unread counts 1–99 as their real digit string", () => {
  assert.equal(formatTaskbarUnreadOverlayLabel(1), "1");
  assert.equal(formatTaskbarUnreadOverlayLabel(5), "5");
  assert.equal(formatTaskbarUnreadOverlayLabel(9), "9");
  assert.equal(formatTaskbarUnreadOverlayLabel(10), "10");
  assert.equal(formatTaskbarUnreadOverlayLabel(36), "36");
  assert.equal(formatTaskbarUnreadOverlayLabel(99), "99");
});

test("caps overlay text at 99+ for counts of 100 or more", () => {
  assert.equal(formatTaskbarUnreadOverlayLabel(100), "99+");
  assert.equal(formatTaskbarUnreadOverlayLabel(101), "99+");
  assert.equal(formatTaskbarUnreadOverlayLabel(999), "99+");
});

test("exports overlay size of at least 96", () => {
  assert.ok(TASKBAR_UNREAD_OVERLAY_SIZE >= 96);
});

test("builds a deterministic ≥96 PNG with the PNG signature for positive counts", () => {
  const one = buildTaskbarUnreadOverlayPng(1);
  const again = buildTaskbarUnreadOverlayPng(1);
  const hundred = buildTaskbarUnreadOverlayPng(100);
  assert.ok(Buffer.isBuffer(one));
  assert.ok(Buffer.isBuffer(hundred));
  assert.deepEqual([...one.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual([...hundred.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual(one, again);
  assert.notDeepEqual(one, hundred);

  const oneSize = readPngIhdrSize(one);
  const hundredSize = readPngIhdrSize(hundred);
  assert.ok(oneSize.width >= 96);
  assert.ok(oneSize.height >= 96);
  assert.equal(oneSize.width, TASKBAR_UNREAD_OVERLAY_SIZE);
  assert.equal(oneSize.height, TASKBAR_UNREAD_OVERLAY_SIZE);
  assert.equal(hundredSize.width, TASKBAR_UNREAD_OVERLAY_SIZE);
  assert.equal(hundredSize.height, TASKBAR_UNREAD_OVERLAY_SIZE);
});

test("single-digit, two-digit, and 99+ overlays produce different PNG buffers", () => {
  const five = buildTaskbarUnreadOverlayPng(5);
  const thirtysix = buildTaskbarUnreadOverlayPng(36);
  const hundred = buildTaskbarUnreadOverlayPng(100);
  assert.ok(Buffer.isBuffer(five));
  assert.ok(Buffer.isBuffer(thirtysix));
  assert.ok(Buffer.isBuffer(hundred));
  assert.notDeepEqual(five, thirtysix);
  assert.notDeepEqual(thirtysix, hundred);
  assert.notDeepEqual(five, hundred);
});

test("canvas script contains fillText and arc for positive counts", () => {
  const script = buildTaskbarUnreadOverlayCanvasScript(36);
  assert.equal(typeof script, "string");
  assert.match(script, /fillText/);
  assert.match(script, /\.arc\(/);
  assert.match(script, /toDataURL/);
  assert.match(script, /99\+|Segoe UI|#000|#fff/);
  const capped = buildTaskbarUnreadOverlayCanvasScript(100);
  assert.match(capped, /99\+/);
  assert.match(capped, /fillText/);
});

test("renderTaskbarUnreadOverlayPng uses executeJavaScript and decodes data URL", async () => {
  const tinyPng = buildTaskbarUnreadOverlayPng(1);
  assert.ok(tinyPng);
  const dataUrl = `data:image/png;base64,${tinyPng.toString("base64")}`;
  let ran = null;
  const webContents = {
    isDestroyed: () => false,
    async executeJavaScript(code) {
      ran = code;
      return dataUrl;
    },
  };
  const buf = await renderTaskbarUnreadOverlayPng(webContents, 7);
  assert.ok(Buffer.isBuffer(buf));
  assert.deepEqual(buf, tinyPng);
  assert.match(ran, /fillText/);
  assert.match(ran, /"7"/);

  assert.equal(await renderTaskbarUnreadOverlayPng(null, 1), null);
  assert.equal(
    await renderTaskbarUnreadOverlayPng(
      { isDestroyed: () => true, executeJavaScript: async () => dataUrl },
      1,
    ),
    null,
  );
  assert.equal(await renderTaskbarUnreadOverlayPng(webContents, 0), null);
});

test("documents the D295 bell vs shell-badge count split", () => {
  const overlaySource = readFileSync(
    join(root, "electron/main/taskbar-unread-overlay.ts"),
    "utf8",
  );
  const inboxSource = readFileSync(
    join(root, "src/lib/notification-inbox.ts"),
    "utf8",
  );
  assert.match(overlaySource, /D295/);
  assert.match(overlaySource, /failures only|failure-only|failures-only/i);
  assert.match(inboxSource, /task\.completed/);
  assert.match(inboxSource, /notification\.kind !== "task\.completed"/);
});
