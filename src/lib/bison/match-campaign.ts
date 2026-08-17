// THE campaign -> client matcher. One implementation, used by both the 6-hourly sync and the
// Export dialog's campaign list.
//
// There used to be two. The sync matched fuzzily in JS; /api/bison/campaigns matched with strict
// SQL ("the part before the first ' + ' equals the client name, or the name is followed by ' +'").
// They disagreed, and the dialog was the one that lost: campaigns whose leads the sync had
// correctly attributed simply did not appear, so an operator could not send to them.
//
// Measured before this was unified -- 13 clients affected, 47 campaigns invisible, 72,407 leads
// behind them:
//
//     client                     real campaigns   shown by the dialog
//     Jeff Cook Real Estate            13                0
//     The Discover Flag Team            6                0
//     The Rafeh Group                   6                1
//     LIV Indy Realty                   5                1
//     REMAX Pacific                     3                0
//
// The strict rule missed three shapes the fuzzy one handles, all of which are normal here:
//   * numbered variants   "LIV Indy Realty 2 + Nicole + MIBOR"   (prefix != client name)
//   * "Copy of ..."       "Copy of LIV Indy Realty 4 + ..."      (norm drops "copy of")
//   * leading "The"       "The Discover Flag Team"               (norm drops a leading "the")
// and punctuation differences like "RE/MAX Pacific" vs "REMAX Pacific" (norm drops non-alphanum).
//
// Matching is fuzzy but ambiguity-safe: a tie between two clients is left UNMAPPED rather than
// guessed, so a campaign never lands under the wrong client.

export interface MatchableClient {
  id: string;
  client_name: string | null;
  bison_campaign_id?: string | null;
}

// lowercase, drop "copy of", strip non-alphanumerics, drop a leading "the"
export const normClientName = (v: string): string =>
  v.toLowerCase().replace(/\bcopy of\b/g, "").replace(/[^a-z0-9]+/g, "").replace(/^the/, "");

// The campaign-name prefix that identifies the client: "Client + Sender + Market" -> "Client".
// This is EmailBison's convention. Instantly names its campaigns differently -- see below.
export const campaignPrefix = (name: string | null): string =>
  (name ?? "").replace(/\s+/g, " ").split(" + ")[0].trim();

/** Explicit alias, so a call site says which provider's convention it means. */
export const bisonPrefix = campaignPrefix;

/**
 * Instantly's convention: "Client Name (N) - Market - Market", with "(copy)" suffixes.
 * The Bison rule cannot be reused -- of 100 live Instantly campaigns only 21 contain " + ", and at
 * least one uses "+" to separate MARKETS, which the Bison split would mis-parse:
 *
 *   Camelot Realty Group (4) - Houston - Katy - The Woodlands …  -> Camelot Realty Group
 *   54 Realty (2) - Hillsborough - Pasco - Pinellas              -> 54 Realty
 *   BHGRE Basecamp (5) Zillow Preferred Offer                    -> whole string; scoring's
 *                                                                   startsWith still finds it
 *   Spotlight - A Compass Team (3) - Cary + Durham + Hillsborough -> Spotlight  (see note)
 *   Campaign #1: Personal Emails                                 -> no client; left unmapped
 *
 * Names with a leading fragment before the client (the Spotlight case) may map to nothing, which
 * is the safe failure: an unmapped campaign still flags its agents as replied, it just loses the
 * client attribution. Nothing is dropped.
 */
export const instantlyPrefix = (name: string | null): string => {
  let s = (name ?? "").replace(/\s+/g, " ").trim();
  s = s.replace(/\s*\(copy\)\s*$/gi, "").trim();      // possibly repeated
  s = s.replace(/\s*\(copy\)\s*$/gi, "").trim();
  s = s.replace(/\s*\([^)]*\)\s*/g, " ").trim();       // "(4)", "(Pro)", …
  const dash = s.indexOf(" - ");
  s = (dash >= 0 ? s.slice(0, dash) : s).trim();
  // ~1 in 5 Instantly campaigns are named the Bison way, so fall back to that split once the
  // dash form has been applied. Order matters: "Spotlight - A Compass Team (3) - Cary + Durham"
  // must be cut at the dash FIRST, otherwise splitting on " + " would keep the market list.
  const plus = s.indexOf(" + ");
  return (plus >= 0 ? s.slice(0, plus) : s).trim();
};

/**
 * Builds a matcher over a set of clients. Pass ALL clients, not just the ones being displayed --
 * tie detection needs the full set, otherwise an ambiguous campaign looks unambiguous.
 *
 * `prefixFn` selects the provider's naming convention; the scoring and the refusal to guess on a
 * tie are shared, because those are what stopped campaigns being filed under the wrong client.
 * It defaults to the Bison rule so every existing call site is unchanged.
 */
export function makeCampaignMatcher<C extends MatchableClient>(
  clients: C[],
  prefixFn: (name: string | null) => string = campaignPrefix
) {
  const byDirect = new Map<string, C>(
    clients.filter((c) => c.bison_campaign_id).map((c) => [String(c.bison_campaign_id), c])
  );
  // clients with a very short normalised name are skipped: a 1-2 char name would match almost
  // anything under startsWith
  const normed = clients
    .map((c) => ({ c, n: normClientName(c.client_name ?? "") }))
    .filter((x) => x.n.length >= 3);

  return function matchCampaign(name: string | null, bisonId: string): C | null {
    // an explicit campaign id on the client always wins over any name reasoning
    if (byDirect.has(bisonId)) return byDirect.get(bisonId)!;
    const pn = normClientName(prefixFn(name));
    if (!pn) return null;

    let best: { c: C; len: number; score: number } | null = null;
    let tied = false;
    for (const { c, n } of normed) {
      let score = 0;
      if (pn === n) score = 3;                                   // exact
      else if (n.length >= 6 && pn.startsWith(n)) score = 2;      // "LIV Indy Realty 2"
      else if (pn.length >= 6 && n.startsWith(pn)) score = 1;     // truncated client name
      if (!score) continue;
      if (!best || score > best.score || (score === best.score && n.length > best.len)) {
        best = { c, len: n.length, score };
        tied = false;
      } else if (score === best.score && n.length === best.len && c.id !== best.c.id) {
        tied = true;
      }
    }
    return best && !tied ? best.c : null;
  };
}
