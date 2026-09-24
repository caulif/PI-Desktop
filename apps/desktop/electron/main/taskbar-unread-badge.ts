import { app, nativeImage, type BrowserWindow } from "electron";
import {
  IPC,
  type NotificationListResult,
} from "@pi-desktop/shared";
import type { HostProcess } from "./host-process";
import type { Logger } from "./logger";
import {
  buildTaskbarUnreadOverlayPng,
  formatTaskbarUnreadOverlayLabel,
} from "./taskbar-unread-overlay";

const REFRESH_AFTER_INVOKE = new Set<string>([
  IPC.invoke.notificationMarkRead,
  IPC.invoke.notificationMarkAllRead,
  IPC.invoke.notificationClear,
]);

/**
 * Main-owned shell badge for unread durable task notifications.
 * Uses host unreadCount (completed + failed). Does not change D295 bell filtering.
 */
export function createTaskbarUnreadBadge({
  getHost,
  getMainWindow,
  isQuitting,
  logger,
}: {
  getHost: () => HostProcess | null;
  getMainWindow: () => BrowserWindow | null;
  isQuitting: () => boolean;
  logger: Pick<Logger, "app">;
}) {
  let revision = 0;
  let pending: Promise<void> | null = null;
  let appliedCount: number | null = null;

  function apply(count: number): void {
    const next = Math.max(0, Math.floor(count));
    if (appliedCount === next) return;
    appliedCount = next;

    if (process.platform === "win32") {
      const window = getMainWindow();
      if (!window || window.isDestroyed()) return;
      try {
        if (next <= 0) {
          window.setOverlayIcon(null, "");
          return;
        }
        const png = buildTaskbarUnreadOverlayPng(next);
        const label = formatTaskbarUnreadOverlayLabel(next);
        if (!png || !label) {
          window.setOverlayIcon(null, "");
          return;
        }
        const image = nativeImage.createFromBuffer(png);
        if (image.isEmpty()) {
          window.setOverlayIcon(null, "");
          return;
        }
        window.setOverlayIcon(image, label);
      } catch (error) {
        logger.app("diagnostics", "warn", "taskbar overlay icon update failed", {
          data: String(error),
        });
      }
      return;
    }

    try {
      app.setBadgeCount(next);
    } catch (error) {
      logger.app("diagnostics", "warn", "shell badge count update failed", {
        data: String(error),
      });
    }
  }

  function refresh(): Promise<void> {
    revision += 1;
    if (pending) return pending;
    pending = (async () => {
      let observed: number;
      do {
        observed = revision;
        const host = getHost();
        if (!host || isQuitting()) {
          apply(0);
          return;
        }
        try {
          const inbox = await host.call<NotificationListResult>(
            "notification.list",
            { limit: 1 },
          );
          if (isQuitting()) return;
          if (host !== getHost()) {
            revision += 1;
            continue;
          }
          if (observed !== revision) continue;
          apply(inbox.unreadCount ?? 0);
        } catch (error) {
          if (host !== getHost()) {
            revision += 1;
            continue;
          }
          if (observed !== revision || isQuitting()) continue;
          logger.app("diagnostics", "warn", "taskbar unread badge refresh failed", {
            data: String(error),
          });
        }
      } while (observed !== revision);
    })().finally(() => {
      pending = null;
    });
    return pending;
  }

  return {
    refresh,
    observeEvent(channel: string, _payload?: unknown) {
      if (isQuitting()) return;
      if (
        channel === IPC.event.notificationChanged ||
        channel === IPC.event.hostStatus
      ) {
        void refresh();
      }
    },
    observeInvoke(channel: string) {
      if (REFRESH_AFTER_INVOKE.has(channel)) void refresh();
    },
  };
}
