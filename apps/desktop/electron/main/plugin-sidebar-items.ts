/** Validate untrusted plugin navigation summaries before they reach React. */
export function pluginSidebarItems(value: unknown): Array<{
  id: string; title: string; description?: string; badge?: string; location?: unknown;
}> {
  if (value && typeof value === "object" && !Array.isArray(value) && "ok" in value) {
    if (value.ok !== true || !("data" in value)) throw new Error("INVALID_SIDEBAR_ITEMS: provider failed");
    value = value.data;
  }
  if (!Array.isArray(value) || value.length > 100) throw new Error("INVALID_SIDEBAR_ITEMS: expected at most 100 items");
  if (JSON.stringify(value).length > 65536) throw new Error("INVALID_SIDEBAR_ITEMS: payload too large");
  const ids = new Set<string>();
  const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
  return value.map(item => {
    if (!item || typeof item !== "object") throw new Error("INVALID_SIDEBAR_ITEMS: invalid item");
    if (!text(item.id, 128) || !item.id.trim() || ids.has(item.id)) throw new Error("INVALID_SIDEBAR_ITEMS: invalid or duplicate identity");
    if (!text(item.title, 200) || !item.title.trim()) throw new Error("INVALID_SIDEBAR_ITEMS: invalid title");
    if (item.description !== undefined && !text(item.description, 300)) throw new Error("INVALID_SIDEBAR_ITEMS: invalid description");
    if (item.badge !== undefined && !text(item.badge, 32)) throw new Error("INVALID_SIDEBAR_ITEMS: invalid badge");
    ids.add(item.id);
    return { id: item.id, title: item.title, ...(item.description === undefined ? {} : { description: item.description }), ...(item.badge === undefined ? {} : { badge: item.badge }), ...(item.location === undefined ? {} : { location: item.location }) };
  });
}
