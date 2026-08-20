import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");

  // Use the public domain, not the internal container origin (localhost:8080).
  // The fallback pointed at database-renaissance-production -- a DIFFERENT project's deployment --
  // so any request arriving without the proxy headers was redirected into someone else's app.
  const origin = request.headers.get("x-forwarded-host")
    ? `${request.headers.get("x-forwarded-proto") || "https"}://${request.headers.get("x-forwarded-host")}`
    : process.env.NEXT_PUBLIC_SITE_URL || request.nextUrl.origin;

  const supabase = await createClient();

  if (code) {
    const { data } = await supabase.auth.exchangeCodeForSession(code);

    // If type=invite in query params, redirect to accept-invite
    if (type === "invite") {
      return NextResponse.redirect(new URL("/accept-invite", origin));
    }

    // If type=recovery, redirect to set-password
    if (type === "recovery") {
      return NextResponse.redirect(new URL("/set-password", origin));
    }

    // Check if this is an invited user who hasn't set up their account
    // (user_metadata.role exists but they came through an invite link)
    if (data?.user?.user_metadata?.role && !data?.user?.user_metadata?.setup_complete) {
      return NextResponse.redirect(new URL("/accept-invite", origin));
    }
  } else if (tokenHash && type) {
    await supabase.auth.verifyOtp({ token_hash: tokenHash, type: type as "invite" | "recovery" | "email" });

    if (type === "invite") {
      return NextResponse.redirect(new URL("/accept-invite", origin));
    }
    if (type === "recovery") {
      return NextResponse.redirect(new URL("/set-password", origin));
    }
  }

  // IMPLICIT FLOW. A Supabase recovery/invite email sends the browser to /auth/v1/verify, which
  // redirects here with the tokens in the URL FRAGMENT (#access_token=...). A fragment is never
  // sent to a server, so neither `code` nor `token_hash` is present and both branches above are
  // skipped -- which used to drop the user on /search, a gated route, which bounced to /login,
  // which happened to parse the fragment and then sent them to /accept-invite. A password reset
  // ending on "accept your invitation" is the visible symptom of that accident.
  //
  // Route on `type` alone instead and let the client page read the fragment; the browser carries
  // it across these redirects. /set-password and /accept-invite are both exempt from the session
  // gate (lib/supabase/middleware.ts:38-41), which is what makes this safe without a session.
  if (type === "recovery") {
    return NextResponse.redirect(new URL("/set-password", origin));
  }
  if (type === "invite") {
    return NextResponse.redirect(new URL("/accept-invite", origin));
  }

  return NextResponse.redirect(new URL("/search", origin));
}
