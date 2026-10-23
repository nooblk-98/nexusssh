"use client";
import { useSyncExternalStore } from "react";
// "/" is the workspace and "/settings/<page>" are settings pages; next.config.mjs
// rewrites them all to the single app page.
const listeners = new Set<() => void>();
const subscribe = (f: () => void) => {
  listeners.add(f);
  window.addEventListener("popstate", f);
  return () => {
    listeners.delete(f);
    window.removeEventListener("popstate", f);
  };
};
export function navigate(path: string) {
  if (location.pathname !== path) history.pushState(null, "", path);
  listeners.forEach((f) => f());
}
export const usePath = () =>
  useSyncExternalStore(
    subscribe,
    () => location.pathname,
    () => "/",
  );
