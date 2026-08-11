// Export/send size limits, shared by the server (gather-rows) and the Export dialog so the
// number shown to the operator is the number that actually goes out.
//
// This file deliberately has NO imports: the dialog is a client component and must be able to
// read these without pulling in the pg pool.

// Hard ceiling on rows any single export or campaign send can produce. gatherExportRows applies
// it as Math.min(limit, EXPORT_MAX_ROWS); before A14b the dialog still said "all 1,130,286
// agents" while silently sending the first 100,000, so the count and the action disagreed.
export const EXPORT_MAX_ROWS = 100_000;

// Above this, a campaign send asks for explicit confirmation. Sending is not free — every agent
// runs through BetterEnrich + Instantly + OpenAI, and the leads land in a live sending domain —
// so a mis-click at six figures is expensive in money and deliverability, not just time.
// For scale: 10,040 enrichment items had been created in the system's entire history when this
// was added, so even 10,000 is a large batch here.
export const SEND_CONFIRM_THRESHOLD = 10_000;
