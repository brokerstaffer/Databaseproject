"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
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

export function TopBar({ initials, email }: { initials: string; email: string }) {
  const router = useRouter();

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 bg-neutral-950 px-3 text-white">
      <Link href="/search" className="flex h-9 w-9 items-center justify-center rounded-md bg-neutral-800 text-white" title="Broker Staffer">
        <Building2 className="h-5 w-5" />
      </Link>
      <div className="relative w-full max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
        <input
          placeholder="Search Broker Staffer"
          className="h-9 w-full rounded-lg bg-neutral-800/80 pl-9 pr-3 text-sm text-white placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-600"
        />
      </div>
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
