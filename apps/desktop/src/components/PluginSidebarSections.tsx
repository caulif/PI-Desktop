import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { useAppStore } from "../stores/app-store";
import { Button } from "./ui";

/** Host chrome consumes validated summaries, never plugin markup or business state. */
export function PluginSidebarSections() {
  const { t } = useTranslation();
  const summaries = useAppStore(state => state.pluginSidebarSections);
  const summaryScope = useAppStore(state => state.pluginSidebarScope);
  const selected = useAppStore(state => state.pluginTarget);
  const open = useAppStore(state => state.openPluginTarget);
  const workspacePath = useAppStore(state => state.workspace?.path);
  const sections = summaryScope === (workspacePath ?? null) ? summaries : [];
  const [loadError, setLoadError] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  useEffect(() => {
    useAppStore.setState({ pluginSidebarSections: [], pluginSidebarScope: workspacePath ?? null });
    let alive = true;
    let pending = false;
    const refresh = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const pluginSidebarSections = await api.listPluginSidebarSections();
        if (alive) { useAppStore.setState({ pluginSidebarSections, pluginSidebarScope: workspacePath ?? null }); setLoadError(false); }
      } catch {
        if (alive) setLoadError(true);
      } finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10000);
    window.addEventListener("focus", refresh);
    const off = api.onPluginChanged(() => void refresh());
    return () => { alive = false; window.clearInterval(timer); window.removeEventListener("focus", refresh); off(); };
  }, [workspacePath]);
  return <>{loadError && <span role="status" className="plugin-sidebar-error">{t("panel.pluginView.failed")}</span>}{sections.map(section => {
    const key = `${section.pluginId}/${section.sectionId}`;
    return <section key={key} className="plugin-sidebar-section" data-plugin-sidebar-section={key}>
      <Button className="sidebar-list-toolbar plugin-sidebar-heading" aria-expanded={!collapsed[key]} onClick={() => setCollapsed(value => ({ ...value, [key]: !value[key] }))}>
        <span className="sidebar-list-label">{section.title}</span>
      </Button>
      {!collapsed[key] && <div className="plugin-sidebar-items">
        {section.error && <span role="status" className="plugin-sidebar-error">{t("panel.pluginView.failed")}</span>}
        {section.items.map(item => <Button key={item.id} className={`plugin-sidebar-item ${selected?.pluginId === section.pluginId && selected.sectionId === section.sectionId && selected.itemId === item.id ? "is-active" : ""}`} aria-current={selected?.pluginId === section.pluginId && selected.sectionId === section.sectionId && selected.itemId === item.id ? "page" : undefined} onClick={() => open({ pluginId: section.pluginId, sectionId: section.sectionId, viewId: section.viewId, itemId: item.id, title: item.title, location: item.location })}>
          <span className="plugin-sidebar-item-title">{item.title}</span>
          {item.description && <span className="plugin-sidebar-item-description">{item.description}</span>}
          {item.badge && <span className="plugin-sidebar-item-badge">{item.badge}</span>}
        </Button>)}
      </div>}
    </section>;
  })}</>;
}
