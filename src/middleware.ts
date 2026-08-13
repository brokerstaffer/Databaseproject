import { updateSession } from "@/lib/supabase/middleware";
import { type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public files
     * - api/uploads/process (large file uploads bypass middleware)
     *
     * The api/* entries below are the TOKEN-authed routes: they authenticate themselves against
     * INGEST_TOKEN or api_keys, so the session gate here would only ever redirect a valid machine
     * caller to /login. api/agents/contact is listed by its full path on purpose -- api/agents
     * also holds `profile`, which is session-authed and must stay behind this gate.
     */
    "/((?!_next/static|_next/image|favicon.ico|api/uploads/process|api/enrich_email|api/ingest|api/cron|api/agents/contact|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
