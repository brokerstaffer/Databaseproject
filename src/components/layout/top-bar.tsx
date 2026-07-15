"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { Search, ClipboardList, Bell, Building2, LogOut } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { createClient } from "@/lib/supabase/client";
import { useNameSearch } from "@/lib/stores/name-search";

export function TopBar({ initials, email }: { initials: string; email: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [q, setQ] = useNameSearch();
  const [options, setOptions] = useState<string[]>([]);
  const [focus, setFocus] = useState(false);
  const optTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Make sure we're on the search screen so the results react to the term. We DON'T pass the
  // term in the URL — it flows through the shared store, which keeps the current filters intact.
  function ensureOnSearch() {
    if (pathname !== "/search") router.push("/search");
  }

  function onType(v: string) {
    setQ(v); // updates the shared store -> Agent Search narrows live, filters preserved
    ensureOnSearch();
  }

  // As-you-type suggestions of matching agent names (same source as the Name filter typeahead).
  useEffect(() => {
    if (optTimer.current) clearTimeout(optTimer.current);
    if (!q.trim()) {
      setOptions([]);
      return;
    }
    optTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search/options?type=name&q=${encodeURIComponent(q.trim())}`);
        const json = await res.json();
        setOptions(Array.isArray(json.options) ? (json.options as string[]) : []);
      } catch {
        /* ignore */
      }
    }, 200);
    return () => {
      if (optTimer.current) clearTimeout(optTimer.current);
    };
  }, [q]);

  async function signOut() {
    setQ(""); // clear the shared search term so it doesn't carry into the next session in this tab
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 bg-neutral-950 px-3 text-white">
      <Link href="/search" className="flex h-9 w-9 items-center justify-center rounded-md bg-neutral-800 text-white" title="BrokerStaffer">
        <Building2 className="h-5 w-5" />
      </Link>
      <form
        className="relative w-full max-w-sm"
        onSubmit={(e) => {
          e.preventDefault();
          ensureOnSearch();
          setFocus(false);
        }}
      >
        <Search className="absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-neutral-400" />
        <input
          value={q}
          onChange={(e) => onType(e.target.value)}
          onFocus={() => setFocus(true)}
          onBlur={() => setTimeout(() => setFocus(false), 120)}
          placeholder="Search agents by name…"
          className="h-9 w-full rounded-lg bg-neutral-800/80 pl-9 pr-3 text-sm text-white placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-600"
        />
        {focus && q.trim().length > 0 && options.length > 0 && (
          <div className="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-neutral-200 bg-white py-1 text-neutral-900 shadow-lg">
            {options.map((o) => (
              <button
                key={o}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setQ(o);
                  ensureOnSearch();
                  setFocus(false);
                }}
                className="block w-full px-3 py-2 text-left text-sm hover:bg-neutral-50"
              >
                {o}
              </button>
            ))}
          </div>
        )}
      </form>
      <div className="ml-auto flex items-center gap-4">
        <button type="button" className="text-neutral-300 hover:text-white" title="Lists">
          <ClipboardList className="h-5 w-5" />
        </button>
        <button type="button" className="text-neutral-300 hover:text-white" title="Notifications">
          <Bell className="h-5 w-5" />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-600 text-xs font-semibold text-white">
              {initials}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground">{email}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={signOut}>
              <LogOut className="mr-2 h-4 w-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
