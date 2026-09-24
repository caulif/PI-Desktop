import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildTaskbarUnreadOverlayPng,
  formatTaskbarUnreadOverlayLabel,
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

test("builds a deterministic 64×64 PNG with the PNG signature for positive counts", () => {
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
  assert.equal(oneSize.width, 64);
  assert.equal(oneSize.height, 64);
  assert.equal(hundredSize.width, 64);
  assert.equal(hundredSize.height, 64);
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
