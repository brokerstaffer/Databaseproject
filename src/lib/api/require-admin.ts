import { createClient } from "@/lib/supabase/server";

// Returns the logged-in user if they're an owner/admin, else null.
// Use in admin API routes: `const admin = await requireAdmin(); if (!admin) return 403`.
export async function requireAdmin(): Promise<{ id: string; email: string; role: string } | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase.from("user_profiles").select("email, role").eq("id", user.id).single();
  if (!profile || !["owner", "admin"].includes(profile.role)) return null;
  return { id: user.id, email: profile.email ?? user.email ?? "", role: profile.role };
}
