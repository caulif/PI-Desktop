import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const IPC = {
  invoke: {
    notificationMarkRead: "pi-desktop/notification/markRead",
    notificationMarkAllRead: "pi-desktop/notification/markAllRead",
    notificationClear: "pi-desktop/notification/clear",
  },
  event: {
    notificationChanged: "pi-desktop/notification/event/changed",
    hostStatus: "pi-desktop/app/event/hostStatus",
  },
};

function loadBadgeModule() {
  const file = new URL("../electron/main/taskbar-unread-badge.ts", import.meta.url);
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
    fileName: file.pathname,
  });

  const badgeCounts = [];
  const electron = {
    app: {
      setBadgeCount(count) {
        badgeCounts.push(count);
      },
    },
    nativeImage: {
      createFromBuffer(buffer) {
        return {
          isEmpty: () => !buffer || buffer.length === 0,
          buffer,
        };
      },
    },
  };

  const overlay = {
    buildTaskbarUnreadOverlayPng(count) {
      if (count <= 0) return null;
      return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, count & 0xff]);
    },
    formatTaskbarUnreadOverlayLabel(count) {
      if (count <= 0) return null;
      return count >= 10 ? "9+" : String(count);
    },
  };

  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      if (id === "electron") return electron;
      if (id === "@pi-desktop/shared") return { IPC };
      if (id === "./taskbar-unread-overlay") return overlay;
      throw new Error(`unexpected dependency: ${id}`);
    },
    module.exports,
    module,
  );

  return {
    createTaskbarUnreadBadge: module.exports.createTaskbarUnreadBadge,
    badgeCounts,
  };
}

function harness({ platform = "linux", unreadCount = 0 } = {}) {
  const previousPlatform = process.platform;
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });

  const loaded = loadBadgeModule();
  const listCalls = [];
  const overlayIcons = [];
  let currentUnread = unreadCount;
  let hostRef = {
    call: async (method, input) => {
      listCalls.push({ method, input });
      assert.equal(method, "notification.list");
      return { notifications: [], unreadCount: currentUnread };
    },
  };
  let mainWindow = {
    isDestroyed: () => false,
    setOverlayIcon(image, description) {
      overlayIcons.push({ image, description });
    },
  };

  const badge = loaded.createTaskbarUnreadBadge({
    getHost: () => hostRef,
    getMainWindow: () => mainWindow,
    isQuitting: () => false,
    logger: { app() {} },
  });

  return {
    badge,
    listCalls,
    badgeCounts: loaded.badgeCounts,
    overlayIcons,
    setUnreadCount(next) {
      currentUnread = next;
    },
    dispose() {
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: previousPlatform,
      });
    },
  };
}

async function waitFor(predicate, { timeoutMs = 1000 } = {}) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("observeInvoke on markRead triggers notification.list refresh", async () => {
  const h = harness({ platform: "linux", unreadCount: 3 });
  try {
    h.badge.observeInvoke(IPC.invoke.notificationMarkRead);
    await waitFor(() => h.listCalls.length >= 1);
    assert.equal(h.listCalls[0].method, "notification.list");
    assert.deepEqual(h.listCalls[0].input, { limit: 1 });
    await waitFor(() => h.badgeCounts.includes(3));
    assert.equal(h.badgeCounts.at(-1), 3);
  } finally {
    h.dispose();
  }
});

test("observeInvoke on markAllRead and clear also refresh", async () => {
  for (const channel of [
    IPC.invoke.notificationMarkAllRead,
    IPC.invoke.notificationClear,
  ]) {
    const h = harness({ platform: "linux", unreadCount: 1 });
    try {
      h.badge.observeInvoke(channel);
      await waitFor(() => h.listCalls.length >= 1);
      assert.equal(h.listCalls[0].method, "notification.list");
      await waitFor(() => h.badgeCounts.length >= 1);
      assert.equal(h.badgeCounts.at(-1), 1);
    } finally {
      h.dispose();
    }
  }
});

test("observeInvoke ignores unrelated channels", async () => {
  const h = harness({ platform: "linux", unreadCount: 9 });
  try {
    h.badge.observeInvoke("pi-desktop/session/list");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(h.listCalls.length, 0);
    assert.equal(h.badgeCounts.length, 0);
  } finally {
    h.dispose();
  }
});

test("refresh applies host unreadCount to the shell badge", async () => {
  const h = harness({ platform: "linux", unreadCount: 7 });
  try {
    await h.badge.refresh();
    assert.equal(h.listCalls.length, 1);
    assert.equal(h.badgeCounts.at(-1), 7);
  } finally {
    h.dispose();
  }
});

test("refresh with unreadCount 0 clears the shell badge", async () => {
  const h = harness({ platform: "linux", unreadCount: 4 });
  try {
    await h.badge.refresh();
    assert.equal(h.badgeCounts.at(-1), 4);
    h.setUnreadCount(0);
    await h.badge.refresh();
    assert.equal(h.badgeCounts.at(-1), 0);
  } finally {
    h.dispose();
  }
});

test("refresh with unreadCount 0 clears the Windows overlay icon", async () => {
  const h = harness({ platform: "win32", unreadCount: 2 });
  try {
    await h.badge.refresh();
    assert.ok(h.overlayIcons.length >= 1);
    assert.notEqual(h.overlayIcons.at(-1).image, null);
    assert.equal(h.overlayIcons.at(-1).description, "2");

    h.setUnreadCount(0);
    await h.badge.refresh();
    assert.equal(h.overlayIcons.at(-1).image, null);
    assert.equal(h.overlayIcons.at(-1).description, "");
  } finally {
    h.dispose();
  }
});

test("observeEvent(notificationChanged) refreshes from host unreadCount", async () => {
  const h = harness({ platform: "linux", unreadCount: 5 });
  try {
    h.badge.observeEvent(IPC.event.notificationChanged, {});
    await waitFor(() => h.listCalls.length >= 1);
    await waitFor(() => h.badgeCounts.includes(5));
    assert.equal(h.badgeCounts.at(-1), 5);
  } finally {
    h.dispose();
  }
});
