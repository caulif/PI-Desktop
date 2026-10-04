import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Views must remain inside their declared package after following symlinks. */
export function resolvePluginViewEntry(pluginPath: string, entry: string): string | null {
  const contained = (root: string, target: string) => {
    const child = relative(root, target);
    return Boolean(child) && !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
  };
  const root = resolve(pluginPath);
  const target = resolve(root, entry);
  if (!contained(root, target)) return null;
  try {
    const rootReal = realpathSync(root);
    const targetReal = realpathSync(target);
    return contained(rootReal, targetReal) ? targetReal : null;
  } catch { return null; }
}
