"use client";

import { useSyncExternalStore } from "react";

// A15.B: "Match my filters" — do the Location / MLS / Office-Search dropdowns show only the
// options your other active filters allow, or the complete list?
//
// One shared setting rather than one per popover: the three filters are used together and it
// would be confusing for Location to be scoped while MLS is not. ON by default, because a
// dropdown offering 17,000 cities that mostly return nothing is the problem we are fixing —
// but it can be turned off to browse everything.
//
// Persisted in localStorage so the choice survives a reload, like the column layout does.
// Same tiny useSyncExternalStore pattern as the top-bar search store.

const KEY = "bs_match_filters";
let value = true;
let loaded = false;
const listeners = new Set<() => void>();

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw !== null) value = raw === "1";
  } catch {
    /* private mode / storage disabled — keep the default */
  }
}

export const matchFiltersStore = {
  get: () => {
    load();
    return value;
  },
  set: (v: boolean) => {
    load();
    if (v === value) return;
    value = v;
    try {
      window.localStorage.setItem(KEY, v ? "1" : "0");
    } catch {
      /* ignore */
    }
    listeners.forEach((l) => l());
  },
  subscribe: (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

// Returns [enabled, setEnabled]. The SSR snapshot is the default (true) so the server render
// matches the first client render and React does not warn about a hydration mismatch.
export function useMatchFilters(): readonly [boolean, (v: boolean) => void] {
  const v = useSyncExternalStore(matchFiltersStore.subscribe, matchFiltersStore.get, () => true);
  return [v, matchFiltersStore.set] as const;
}
