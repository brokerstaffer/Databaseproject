// Railway cron-service entrypoint: mirrors Instantly's replied leads by pinging the app's
// /api/cron/instantly-sync endpoint, then exits. Run as a Railway service with a Cron Schedule
// (e.g. "0 */6 * * *"), matching the Bison sync — NOT as a GitHub Action.
//
// Env vars needed on the cron service:
//   CRON_TOKEN  — same value as the web service's CRON_TOKEN
//   APP_URL     — optional; defaults to the production web URL
//
// The web service also needs INSTANTLY_API_KEY (it currently only exists on enrich-worker).
//
// Unlike bison-sync this endpoint runs inline and returns the real counts, so the HTTP body below
// is the actual result rather than "started". The sweep takes well under a minute.

const APP_URL = process.env.APP_URL || "https://web-production-34f4a.up.railway.app";
const token = process.env.CRON_TOKEN;

if (!token) {
  console.error("CRON_TOKEN is not set on this service.");
  process.exit(1);
}

try {
  const res = await fetch(`${APP_URL}/api/cron/instantly-sync`, {
    method: "POST",
    headers: { "x-cron-token": token },
  });
  const body = await res.text();
  console.log(`instantly-sync -> HTTP ${res.status}: ${body}`);
  process.exit(res.ok ? 0 : 1);
} catch (e) {
  console.error("instantly-sync request failed:", e instanceof Error ? e.message : e);
  process.exit(1);
}
