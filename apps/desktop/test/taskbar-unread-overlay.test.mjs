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

test("clears the overlay label and png when count is zero or negative", () => {
  assert.equal(formatTaskbarUnreadOverlayLabel(0), null);
  assert.equal(formatTaskbarUnreadOverlayLabel(-3), null);
  assert.equal(buildTaskbarUnreadOverlayPng(0), null);
  assert.equal(buildTaskbarUnreadOverlayPng(-1), null);
});

test("formats single-digit unread counts as themselves", () => {
  assert.equal(formatTaskbarUnreadOverlayLabel(1), "1");
  assert.equal(formatTaskbarUnreadOverlayLabel(5), "5");
  assert.equal(formatTaskbarUnreadOverlayLabel(9), "9");
});

test("caps overlay text at 9+ for counts of 10 or more", () => {
  assert.equal(formatTaskbarUnreadOverlayLabel(10), "9+");
  assert.equal(formatTaskbarUnreadOverlayLabel(99), "9+");
  assert.equal(formatTaskbarUnreadOverlayLabel(100), "9+");
});

test("builds a deterministic PNG with the PNG signature for positive counts", () => {
  const one = buildTaskbarUnreadOverlayPng(1);
  const again = buildTaskbarUnreadOverlayPng(1);
  const ten = buildTaskbarUnreadOverlayPng(10);
  assert.ok(Buffer.isBuffer(one));
  assert.ok(Buffer.isBuffer(ten));
  assert.deepEqual([...one.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual([...ten.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual(one, again);
  assert.notDeepEqual(one, ten);
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
