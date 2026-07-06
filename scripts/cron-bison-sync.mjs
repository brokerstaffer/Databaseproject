// Railway cron-service entrypoint: refreshes each client's EmailBison campaigns by pinging
// the app's /api/cron/bison-sync endpoint, then exits. Run this as a separate Railway service
// with a Cron Schedule (e.g. "0 */6 * * *") — NOT as a GitHub Action.
//
// Env vars needed on the cron service:
//   CRON_TOKEN  — same value as the web service's CRON_TOKEN
//   APP_URL     — optional; defaults to the production web URL

const APP_URL = process.env.APP_URL || "https://web-production-34f4a.up.railway.app";
const token = process.env.CRON_TOKEN;

if (!token) {
  console.error("CRON_TOKEN is not set on this service.");
  process.exit(1);
}

try {
  const res = await fetch(`${APP_URL}/api/cron/bison-sync`, {
    method: "POST",
    headers: { "x-cron-token": token },
  });
  const body = await res.text();
  console.log(`bison-sync -> HTTP ${res.status}: ${body}`);
  process.exit(res.ok ? 0 : 1);
} catch (e) {
  console.error("bison-sync request failed:", e instanceof Error ? e.message : e);
  process.exit(1);
}
