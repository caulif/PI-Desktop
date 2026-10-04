import type { AppState } from "../stores/app-state";

const key = "pi-desktop.plugin-navigation.v1";
/** Only navigation identity is durable; execution and opaque subject are not. */
export function savePluginNavigation(target: AppState["pluginTarget"]): void {
  try {
    if (!target) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ pluginId: target.pluginId, sectionId: target.sectionId, itemId: target.itemId, viewId: target.viewId, title: target.title }));
  } catch { /* Unavailable browser persistence does not block navigation. */ }
}

export function loadPluginNavigation(): AppState["pluginTarget"] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!value || ["pluginId", "sectionId", "itemId", "viewId", "title"].some(field => typeof value[field] !== "string" || !value[field].trim() || value[field].length > 200)) return null;
    return { pluginId: value.pluginId, sectionId: value.sectionId, itemId: value.itemId, viewId: value.viewId, title: value.title };
  } catch { return null; }
}
