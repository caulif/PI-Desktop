import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { pluginViewIcon } from "../../lib/plugin-view-icons";
import { IconPlug } from "../icons";
import { WorkTabEmpty } from "./WorkTabEmpty";

/**
 * A plugin-contributed work panel view (ADR 0104).
 *
 * The surface itself is a main-process `WebContentsView`, the same isolated
 * page a `ui.panel` window hosts; this component renders nothing into it. It
 * measures the placeholder rect and drives visibility. The view composites
 * above renderer content, so a panel-wide blocking overlay still hides it.
 * The work-panel menu temporarily blocks the active view while open, which
 * keeps the menu inside the dock without changing plugin bounds or pushing the
 * plugin body down.
 */
export function PluginViewTab({
  pluginId,
  viewId,
  title,
  icon,
  blocked = false,
  sessionId,
  location,
  tabId,
  placement = "workpanel",
}: {
  pluginId: string;
  viewId: string;
  title: string;
  icon?: string;
  blocked?: boolean;
  sessionId?: string;
  location?: string;
  tabId?: string;
  placement?: "main" | "workpanel";
}) {
  const { t } = useTranslation();
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const locationRef = useRef(location);
  locationRef.current = location;
  const viewLocation = pluginId === "pi.browser" && viewId === "browser" ? undefined : location;
  const [failed, setFailed] = useState(false);
  const [openedRevision, setOpenedRevision] = useState(0);

  // Create the view, and re-create it whenever the plugin's lifecycle changed
  // underneath us: a crash, a development reload, or a re-enable all destroy
  // the previous web contents while this tab stays open.
  useEffect(() => {
    let current = true;
    const open = () => {
      void api.pluginViewOpen(pluginId, viewId, { sessionId, location: locationRef.current, tabId, placement }).then(
        () => {
          if (current) {
            setFailed(false);
            // Opening and showing cross separate asynchronous IPC boundaries.
            // Reapply visibility/bounds after the entry actually exists, also
            // when a development reload replaces an already-mounted view.
            setOpenedRevision((revision) => revision + 1);
          }
        },
        () => {
          if (current) setFailed(true);
        },
      );
    };
    open();
    const off = api.onPluginChanged((event) => {
      if (event?.pluginId && event.pluginId !== pluginId) return;
      open();
    });
    return () => {
      current = false;
      off();
    };
  }, [pluginId, viewId, sessionId, viewLocation, tabId, placement]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || failed) return;
    let current = true;
    void api.pluginViewSetVisible(pluginId, viewId, !blocked, sessionId).catch(() => { if (current) setFailed(true); });
    return () => {
      current = false;
      void api.pluginViewSetVisible(pluginId, viewId, false).catch(() => {});
    };
  }, [pluginId, viewId, blocked, failed, sessionId, openedRevision]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || failed) return;
    let frame = 0;
    const report = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = surface.getBoundingClientRect();
        void api.pluginViewSetBounds({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        });
      });
    };
    const observer = new ResizeObserver(report);
    observer.observe(surface);
    window.addEventListener("resize", report);
    report();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", report);
      cancelAnimationFrame(frame);
    };
  }, [pluginId, viewId, failed, openedRevision]);

  if (failed) {
    return (
      <div className="work-plugin-view">
        <WorkTabEmpty
          icon={pluginViewIcon(icon) ?? IconPlug}
          title={title}
          body={t("panel.pluginView.failed")}
        />
      </div>
    );
  }

  return (
    <div className="work-plugin-view">
      <div ref={surfaceRef} className="work-plugin-view-surface" />
    </div>
  );
}
