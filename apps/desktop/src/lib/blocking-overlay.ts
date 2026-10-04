import { useLayoutEffect, useState, useSyncExternalStore } from "react";

// Native plugin views composite above the renderer, including its top layer.
// Count owners so dismissing one overlay cannot reveal a view under another.
const owners = new Set<symbol>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const isBlockingOverlayActive = () => owners.size > 0;

export function useBlockingOverlay() {
  useLayoutEffect(() => {
    const owner = Symbol();
    owners.add(owner);
    notify();
    return () => { owners.delete(owner); notify(); };
  }, []);
}

export function useBlockingOverlayActive() {
  return useSyncExternalStore(subscribe, isBlockingOverlayActive, () => false);
}

/** Also cover existing host menus/dialogs which predate explicit overlay owners. */
export function useRenderedBlockingOverlayActive() {
  const owned = useBlockingOverlayActive();
  const [rendered, setRendered] = useState(false);
  useLayoutEffect(() => {
    const check = () => setRendered([...document.querySelectorAll('[role="dialog"], [role="menu"], [aria-modal="true"]')].some(node => node instanceof HTMLElement && node.getBoundingClientRect().width > 0 && getComputedStyle(node).visibility !== "hidden"));
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "hidden", "role", "aria-modal"] });
    check();
    return () => observer.disconnect();
  }, []);
  return owned || rendered;
}
