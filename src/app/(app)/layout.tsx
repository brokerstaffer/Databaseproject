export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { TopBar } from "@/components/layout/top-bar";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { RoleProvider } from "@/lib/context/role-context";
import type { UserRole } from "@/types/auth";

function initialsOf(name: string | null, email: string): string {
  if (name && name.trim()) {
    const p = name.trim().split(/\s+/);
    return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || name[0].toUpperCase();
  }
  return (email[0] ?? "?").toUpperCase();
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("full_name, role")
    .eq("id", user.id)
    .single();

  const role = (profile?.role ?? "viewer") as UserRole;

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TopBar initials={initialsOf(profile?.full_name ?? null, user.email ?? "?")} email={user.email ?? ""} />
      <div className="flex min-h-0 flex-1">
        <SidebarNav role={role} />
        <RoleProvider role={role}>
          <main className="flex-1 overflow-auto bg-neutral-100 p-5">{children}</main>
        </RoleProvider>
      </div>
    </div>
  );
}
