import { useRenderedBlockingOverlayActive } from "../lib/blocking-overlay";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../stores/app-store";
import { PluginViewTab } from "./workpanel/PluginViewTab";
import { Button } from "./ui";

/** Reuse the bounded isolated view host; a route does not become a session. */
export function PluginMainSurface({ blocked }: { blocked: boolean }) {
  const { t } = useTranslation();
  const target = useAppStore(state => state.pluginTarget);
  const sections = useAppStore(state => state.pluginSidebarSections);
  const summaryScope = useAppStore(state => state.pluginSidebarScope);
  const workspacePath = useAppStore(state => state.workspace?.path);
  const activationRevision = useAppStore(state => state.pluginActivationRevision);
  const overlay = useRenderedBlockingOverlayActive();
  if (!target) return null;
  const section = summaryScope === (workspacePath ?? null) ? sections.find(section => section.pluginId === target.pluginId && section.sectionId === target.sectionId && section.viewId === target.viewId) : undefined;
  const item = section?.items.find(item => item.id === target.itemId);
  return <div className="plugin-main-surface" data-plugin-main-surface={target.pluginId}>
    {item ? <PluginViewTab pluginId={target.pluginId} viewId={target.viewId} title={item.title} placement="main" blocked={blocked || overlay} location={JSON.stringify({ placement: "main", sectionId: target.sectionId, itemId: target.itemId, activationRevision, location: item.location })} /> : <div className="plugin-main-unavailable" role="status"><p>{target.title}</p><p>{t("panel.pluginView.failed")}</p><Button aria-label={t("settings.shortcutAction.navigateBack")} onClick={() => useAppStore.getState().setPage("chat")}>←</Button></div>}
  </div>;
}
