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
 *
 * `desiredCount` is what we last learned from the host; `appliedCount` is what we
 * successfully painted onto the OS shell. Windows overlay needs a live BrowserWindow,
 * so a host update that arrives before the window exists must not mark the count as
 * applied — otherwise a later refresh with the same count early-returns and the
 * overlay never appears.
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
  let desiredCount: number | null = null;
  let appliedCount: number | null = null;

  function apply(count: number, options?: { force?: boolean }): void {
    const next = Math.max(0, Math.floor(count));
    desiredCount = next;
    if (!options?.force && appliedCount === next) return;

    if (process.platform === "win32") {
      const window = getMainWindow();
      if (!window || window.isDestroyed()) {
        // Remember desiredCount but do not advance appliedCount.
        return;
      }
      try {
        if (next <= 0) {
          window.setOverlayIcon(null, "");
          appliedCount = next;
          return;
        }
        const png = buildTaskbarUnreadOverlayPng(next);
        const label = formatTaskbarUnreadOverlayLabel(next);
        if (!png || !label) {
          window.setOverlayIcon(null, "");
          appliedCount = 0;
          return;
        }
        const image = nativeImage.createFromBuffer(png);
        if (image.isEmpty()) {
          window.setOverlayIcon(null, "");
          appliedCount = 0;
          return;
        }
        window.setOverlayIcon(image, label);
        appliedCount = next;
      } catch (error) {
        logger.app("diagnostics", "warn", "taskbar overlay icon update failed", {
          data: String(error),
        });
      }
      return;
    }

    try {
      app.setBadgeCount(next);
      appliedCount = next;
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

  /** Re-paint the last desired count (e.g. main window / tray just became ready). */
  function replay(): void {
    if (desiredCount === null) {
      void refresh();
      return;
    }
    apply(desiredCount, { force: true });
  }

  return {
    refresh,
    replay,
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
