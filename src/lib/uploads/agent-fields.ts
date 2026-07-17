// Field definitions for the CSV agent import. `key` is the EXACT row key the ingest pipeline
// (src/lib/ingest/upsert-agents.ts) reads — the Courted export column names — so mapped CSV
// rows feed the same upsert path as the scraper webhook (match waterfall, source stats,
// office aggregates, city/county triggers all included).
export interface AgentField {
  key: string;
  label: string;
  aliases: string[];
}

export const AGENT_FIELDS: AgentField[] = [
  // identity — the match waterfall uses license -> email -> phone (name+zip as low-confidence fallback)
  { key: "Name", label: "Full name", aliases: ["name", "full name", "agent name", "agent"] },
  { key: "First Name", label: "First name", aliases: ["first name", "firstname", "fname"] },
  { key: "Last Name", label: "Last name", aliases: ["last name", "lastname", "lname", "surname"] },
  { key: "Nickname", label: "Nickname", aliases: ["nickname", "preferred name"] },
  { key: "State License", label: "License number", aliases: ["state license", "license", "license number", "license #", "lic", "license num"] },
  { key: "Email", label: "Email", aliases: ["email", "email address", "e-mail", "preferred email"] },
  { key: "Phone", label: "Phone", aliases: ["phone", "phone number", "direct phone", "preferred phone", "telephone"] },
  { key: "Mobile Phone", label: "Mobile phone", aliases: ["mobile phone", "mobile", "cell", "cell phone"] },
  // office / brokerage
  { key: "Brand", label: "Brand", aliases: ["brand", "franchise", "brand name"] },
  { key: "Office", label: "Office name", aliases: ["office", "office name", "brokerage", "company", "brokerage name"] },
  { key: "Custom Office Name", label: "Custom office name", aliases: ["custom office name"] },
  { key: "Office Address", label: "Office address", aliases: ["office address"] },
  { key: "Office City", label: "Office city", aliases: ["office city", "city"] },
  { key: "Office State", label: "Office state", aliases: ["office state", "state"] },
  { key: "Office Zip", label: "Office zip", aliases: ["office zip", "office zip code", "zip", "zip code", "zipcode", "postal code"] },
  // home
  { key: "Home Address", label: "Home address", aliases: ["home address"] },
  { key: "Home City", label: "Home city", aliases: ["home city"] },
  { key: "Home State", label: "Home state", aliases: ["home state"] },
  { key: "Home Zip", label: "Home zip", aliases: ["home zip", "home zip code"] },
  // most transacted
  { key: "Most Transacted City", label: "Most transacted city", aliases: ["most transacted city", "top producing city", "transacted city"] },
  { key: "Most Transacted State", label: "Most transacted state", aliases: ["most transacted state", "transacted state"] },
  { key: "Most Transacted Zip", label: "Most transacted zip", aliases: ["most transacted zip", "transacted zip"] },
  // MLS
  { key: "MLS", label: "MLS name", aliases: ["mls", "mls name", "mls affiliation"] },
  { key: "MLS ID", label: "MLS code", aliases: ["mls id", "mls code"] },
  { key: "Member MLS ID", label: "Agent's MLS member ID", aliases: ["member mls id", "mls member id", "agent mls id", "member id"] },
  // tenure
  { key: "Agent Tenure (mos)", label: "Time in industry (months)", aliases: ["agent tenure (mos)", "agent tenure", "tenure", "time in industry", "months in industry"] },
  { key: "Years Of Experience", label: "Years of experience", aliases: ["years of experience", "experience", "years experience"] },
  { key: "Time At Current Office (mos)", label: "Time at office (months)", aliases: ["time at current office (mos)", "time at office", "months at office"] },
  { key: "Avg Time At Office (mos)", label: "Avg time at office (months)", aliases: ["avg time at office (mos)", "avg time at office"] },
  // last-12-months stats
  { key: "LTM Sales Volume", label: "Sales volume (LTM)", aliases: ["ltm sales volume", "sales volume", "volume", "total volume"] },
  { key: "Prev LTM Sales Volume", label: "Prev sales volume (LTM)", aliases: ["prev ltm sales volume", "previous sales volume"] },
  { key: "Sales Volume Change %", label: "Sales volume change %", aliases: ["sales volume change %", "pct change", "% change", "percent change"] },
  { key: "LTM Sales Volume Buy-Side", label: "Buy-side $ (LTM)", aliases: ["ltm sales volume buy-side", "buy side dollar", "buy-side $", "buy side volume"] },
  { key: "LTM Sales Volume List-Side", label: "List-side $ (LTM)", aliases: ["ltm sales volume list-side", "list side dollar", "list-side $", "list side volume"] },
  { key: "LTM Est GCI", label: "Approx. GCI (LTM)", aliases: ["ltm est gci", "gci", "approx gci", "estimated gci"] },
  { key: "LTM Avg Sale Price", label: "Avg sale price (LTM)", aliases: ["ltm avg sale price", "avg sale price", "average sale price"] },
  { key: "LTM Closed Transactions", label: "Closed transactions (LTM)", aliases: ["ltm closed transactions", "closed transactions", "transactions"] },
  { key: "LTM Closed Units", label: "Closed units (LTM)", aliases: ["ltm closed units", "closed units", "units"] },
  { key: "LTM Units Buy-Side", label: "Buy-side # (LTM)", aliases: ["ltm units buy-side", "buy side count", "buy-side #", "buy side units"] },
  { key: "LTM Units List-Side", label: "List-side # (LTM)", aliases: ["ltm units list-side", "list side count", "list-side #", "list side units"] },
  { key: "LTM Rental Count", label: "Closed rentals (LTM)", aliases: ["ltm rental count", "closed rentals", "rentals"] },
  { key: "LTM Avg Rental Price", label: "Avg rental price (LTM)", aliases: ["ltm avg rental price", "avg rental price", "average rental price"] },
  { key: "LTM Avg Sale Price Buy-Side", label: "Avg sale price buy-side (LTM)", aliases: ["ltm avg sale price buy-side"] },
  { key: "LTM Avg Sale Price List-Side", label: "Avg sale price list-side (LTM)", aliases: ["ltm avg sale price list-side"] },
  { key: "LTM Close-To-List Price %", label: "Close-to-list %", aliases: ["ltm close-to-list price %", "close to list %"] },
  { key: "LTM Avg Days On Market", label: "Avg days on market", aliases: ["ltm avg days on market", "avg days on market", "days on market", "dom"] },
  // listings + all-time
  { key: "Active Listings", label: "Active listings", aliases: ["active listings"] },
  { key: "Pending Listings", label: "Pending listings", aliases: ["pending listings"] },
  { key: "Total Sales All Time", label: "Total sales (all time)", aliases: ["total sales all time", "all time sales"] },
  { key: "Average Price All Time", label: "Avg price (all time)", aliases: ["average price all time", "all time avg price"] },
  { key: "Average Sales Volume All Time", label: "Avg volume (all time)", aliases: ["average sales volume all time", "all time volume"] },
  // misc
  { key: "LinkedIn URL", label: "LinkedIn URL", aliases: ["linkedin url", "linkedin"] },
  { key: "Languages Spoken", label: "Languages", aliases: ["languages spoken", "languages", "language"] },
  { key: "Price Range", label: "Price range", aliases: ["price range"] },
  { key: "Other Licenses", label: "Other licenses", aliases: ["other licenses"] },
  { key: "Alt State Licenses", label: "Alt state licenses", aliases: ["alt state licenses"] },
  { key: "Profile URL", label: "Profile URL", aliases: ["profile url"] },
  { key: "Profile Photo URL", label: "Profile photo URL", aliases: ["profile photo url", "photo url", "headshot"] },
  { key: "Is Team Leader", label: "Is team leader", aliases: ["is team leader", "team leader"] },
  { key: "Is Team Member", label: "Is team member", aliases: ["is team member", "team member"] },
  { key: "Is Managing Broker", label: "Is managing broker", aliases: ["is managing broker", "managing broker"] },
  { key: "Is Rental Agent", label: "Is rental agent", aliases: ["is rental agent", "rental agent"] },
  { key: "Is New Agent", label: "Is new agent", aliases: ["is new agent", "new agent"] },
];

const norm = (s: string) => s.toLowerCase().trim().replace(/[\s_-]+/g, " ");

export function autoMatchAgentField(csvHeader: string): string | null {
  const n = norm(csvHeader);
  for (const f of AGENT_FIELDS) {
    if (norm(f.key) === n || f.aliases.some((a) => norm(a) === n)) return f.key;
  }
  return null;
}
