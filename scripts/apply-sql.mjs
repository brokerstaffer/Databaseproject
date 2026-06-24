// Apply a .sql file to the database in DATABASE_URL (.env.local).
// Usage: node scripts/apply-sql.mjs supabase/migrations/0001_init_broker_staffer.sql
import { readFileSync } from "node:fs";
import { config } from "dotenv";
import pg from "pg";

config({ path: ".env.local" });

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/apply-sql.mjs <file.sql>");
  process.exit(1);
}

const sql = readFileSync(file, "utf8");
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const t0 = Date.now();
try {
  await client.connect();
  await client.query(sql);
  console.log(`Applied ${file} in ${Date.now() - t0}ms`);
} catch (e) {
  console.error(`Error applying ${file}:`, e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
