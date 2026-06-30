"use client";

import { useSyncExternalStore } from "react";

// Tiny shared store for the top-bar name search. The top bar (in the app layout) and the
// Agent Search screen (a page) live in different parts of the tree; this lets them share the
// search term WITHOUT navigating — so typing in the top bar narrows the current filtered list
// instead of re-mounting the search screen and wiping the applied filters.
let value = "";
const listeners = new Set<() => void>();

export const nameSearchStore = {
  get: () => value,
  set: (v: string) => {
    if (v === value) return;
    value = v;
    listeners.forEach((l) => l());
  },
  subscribe: (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

// Returns [value, setValue]. SSR snapshot is the empty string.
export function useNameSearch(): readonly [string, (v: string) => void] {
  const v = useSyncExternalStore(nameSearchStore.subscribe, nameSearchStore.get, () => "");
  return [v, nameSearchStore.set] as const;
}
