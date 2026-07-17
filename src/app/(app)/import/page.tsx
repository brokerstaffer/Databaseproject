"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Database, FileUp, Webhook } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { CSVDropzone } from "@/components/uploads/csv-dropzone";
import { FieldMapper } from "@/components/uploads/field-mapper";
import { parseCSVAllRows, type ParseResult } from "@/lib/uploads/parse-csv";
import type { FieldMapping } from "@/lib/uploads/normalize-row";

interface Row {
  id: string;
  performed_by: string | null;
  details: string | null;
  created_at: string;
}
interface Counts {
  agents: number;
  offices: number;
  mls: number;
}
interface ImportTotals {
  inserted: number;
  updated: number;
  offices: number;
  mls: number;
}
const fmt = (s: string | null) => (s ? new Date(s).toLocaleString() : "—");
const CHUNK = 1000;

export default function ImportPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);

  // CSV flow: idle -> map -> confirm -> running -> done
  const [step, setStep] = useState<"idle" | "map" | "confirm" | "running" | "done">("idle");
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [mapping, setMapping] = useState<FieldMapping>({});
  const [source, setSource] = useState<"courted" | "zillow" | "realtor">("courted");
  const [clients, setClients] = useState<{ id: string; client_name: string | null }[]>([]);
  const [clientId, setClientId] = useState("");
  const [progress, setProgress] = useState({ sent: 0, total: 0 });
  const [totals, setTotals] = useState<ImportTotals | null>(null);
  const [linkedTotal, setLinkedTotal] = useState(0);
  const [skippedEmpty, setSkippedEmpty] = useState(0);

  const loadHistory = useCallback(() => {
    fetch("/api/import/history")
      .then((r) => r.json())
      .then((j) => {
        setRows(j.rows ?? []);
        setCounts(j.counts ?? null);
      });
  }, []);
  useEffect(loadHistory, [loadHistory]);

  // clients for the optional "add to a client's lead list" picker
  useEffect(() => {
    fetch("/api/orch/clients")
      .then((r) => r.json())
      .then((j) => setClients(j.clients ?? []))
      .catch(() => setClients([]));
  }, []);

  function resetFlow() {
    setStep("idle");
    setFile(null);
    setParsed(null);
    setMapping({});
    setTotals(null);
    setLinkedTotal(0);
    setClientId("");
    setSkippedEmpty(0);
    setProgress({ sent: 0, total: 0 });
  }

  async function runImport() {
    if (!file) return;
    setStep("running");
    try {
      const { rows: allRows } = await parseCSVAllRows(file);
      // apply the column mapping -> objects keyed by the ingest column names
      const mapped: Record<string, string>[] = [];
      let empty = 0;
      for (const raw of allRows) {
        const obj: Record<string, string> = {};
        for (const [idxStr, key] of Object.entries(mapping)) {
          const v = raw[Number(idxStr)]?.trim();
          if (v) obj[key] = v;
        }
        if (Object.keys(obj).length === 0) empty++;
        else mapped.push(obj);
      }
      setSkippedEmpty(empty);
      setProgress({ sent: 0, total: mapped.length });

      const agg: ImportTotals = { inserted: 0, updated: 0, offices: 0, mls: 0 };
      let linked = 0;
      const chunks = Math.ceil(mapped.length / CHUNK);
      for (let i = 0; i < chunks; i++) {
        const slice = mapped.slice(i * CHUNK, (i + 1) * CHUNK);
        const res = await fetch("/api/import/csv", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source, rows: slice, fileName: file.name, chunk: i + 1, chunks, orchClientId: clientId || undefined }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error ?? `chunk ${i + 1}/${chunks} failed (HTTP ${res.status})`);
        agg.inserted += j.inserted ?? 0;
        agg.updated += j.updated ?? 0;
        agg.offices += j.offices ?? 0;
        agg.mls += j.mls ?? 0;
        linked += j.linked ?? 0;
        setProgress({ sent: Math.min((i + 1) * CHUNK, mapped.length), total: mapped.length });
      }
      setLinkedTotal(linked);
      setTotals(agg);
      setStep("done");
      loadHistory();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import failed", { duration: 8000 });
      setStep("confirm"); // keep the mapping so a transient failure can be retried
    }
  }

  const mappedCount = Object.keys(mapping).length;

  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col gap-4 overflow-y-auto">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-neutral-900">Import</h1>
        <p className="mt-0.5 text-sm text-neutral-500">
          Agent data flows in from the scraper via the ingest webhook — or upload a CSV here.
        </p>
      </div>

      {/* totals */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Agents", value: counts?.agents },
          { label: "Offices", value: counts?.offices },
          { label: "MLS", value: counts?.mls },
        ].map((c) => (
          <div key={c.label} className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
            <div className="text-2xl font-semibold text-neutral-900">{c.value == null ? "—" : c.value.toLocaleString()}</div>
            <div className="text-sm text-neutral-500">{c.label}</div>
          </div>
        ))}
      </div>

      {/* CSV import */}
      <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-neutral-900">
          <FileUp className="h-4 w-4 text-neutral-400" />
          Import from CSV
          {step !== "idle" && (
            <button type="button" className="ml-auto text-xs font-normal text-neutral-500 hover:underline" onClick={resetFlow}>
              Start over
            </button>
          )}
        </div>

        {step === "idle" && (
          <CSVDropzone
            onFilesParsed={(result, files) => {
              setParsed(result);
              setFile(files[0]);
              setStep("map");
            }}
            onError={(m) => toast.error(m)}
          />
        )}

        {step === "map" && parsed && (
          <FieldMapper
            headers={parsed.headers}
            preview={parsed.preview}
            onBack={resetFlow}
            onConfirm={(m) => {
              setMapping(m);
              setStep("confirm");
            }}
          />
        )}

        {step === "confirm" && parsed && file && (
          <div className="space-y-4">
            <p className="text-sm text-neutral-700">
              <span className="font-medium">{file.name}</span> — {parsed.totalRows.toLocaleString()} rows, {mappedCount} columns
              mapped.
            </p>
            <div>
              <label className="text-sm font-medium text-neutral-700">Import as source</label>
              <div className="mt-1.5 grid max-w-md grid-cols-3 gap-2">
                {([["courted", "MLS / Courted"], ["zillow", "Zillow"], ["realtor", "Realtor"]] as const).map(([s, lbl]) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSource(s)}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
                      source === s ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-300 text-neutral-700 hover:bg-neutral-50"
                    )}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-xs text-neutral-500">
                Which source these rows count as — drives per-source stats, the All/Zillow/Realtor toggle, and merge
                priority. Rows are matched against existing agents by license → email → phone, so re-importing updates
                instead of duplicating.
              </p>
            </div>
            <div>
              <label className="text-sm font-medium text-neutral-700">
                Add to client&apos;s lead list <span className="font-normal text-neutral-400">(optional)</span>
              </label>
              <div className="mt-1.5 flex max-w-md items-center gap-2">
                <Select value={clientId || "__none__"} onValueChange={(v) => setClientId(v === "__none__" ? "" : v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="No client" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">No client — just import</SelectItem>
                    {clients.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.client_name ?? "Unnamed client"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <p className="mt-1 text-xs text-neutral-500">
                Every imported agent (new or already in the database) is also added to this client&apos;s lead list, so the
                Client filter finds them.
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep("map")}>
                Back
              </Button>
              <Button onClick={runImport}>Import {parsed.totalRows.toLocaleString()} rows</Button>
            </div>
          </div>
        )}

        {step === "running" && (
          <div className="space-y-2">
            <p className="text-sm text-neutral-700">
              Importing… {progress.sent.toLocaleString()} / {progress.total.toLocaleString()} rows
            </p>
            <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-100">
              <div
                className="h-full rounded-full bg-neutral-900 transition-all"
                style={{ width: progress.total ? `${Math.round((progress.sent / progress.total) * 100)}%` : "0%" }}
              />
            </div>
          </div>
        )}

        {step === "done" && totals && (
          <div className="space-y-3">
            <p className="text-sm text-neutral-800">
              Done — <span className="font-medium">{totals.inserted.toLocaleString()} new agents</span>,{" "}
              <span className="font-medium">{totals.updated.toLocaleString()} updated</span>
              {totals.offices > 0 && <>, {totals.offices.toLocaleString()} offices touched</>}
              {totals.mls > 0 && <>, {totals.mls.toLocaleString()} MLS links</>}
              {linkedTotal > 0 && <>, {linkedTotal.toLocaleString()} added to the client&apos;s lead list</>}
              {skippedEmpty > 0 && <span className="text-neutral-500"> ({skippedEmpty} empty rows skipped)</span>}.
            </p>
            <Button variant="outline" onClick={resetFlow}>
              Import another file
            </Button>
          </div>
        )}
      </div>

      {/* webhook pointer */}
      <Link href="/admin" className="flex items-center gap-3 rounded-xl border border-neutral-200 bg-white p-4 text-sm shadow-sm hover:bg-neutral-50">
        <Webhook className="h-5 w-5 text-neutral-400" />
        <div>
          <div className="font-medium text-neutral-800">Scraper ingest endpoint</div>
          <div className="text-neutral-500">Get the URL + an API key in Admin → Data Webhook / API Keys.</div>
        </div>
      </Link>

      {/* recent imports */}
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
        <div className="border-b border-neutral-100 px-4 py-3 text-sm font-semibold text-neutral-900">Recent imports</div>
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left text-xs font-medium text-neutral-500">
              <tr>
                <th className="px-4 py-2">When</th>
                <th className="px-4 py-2">By</th>
                <th className="px-4 py-2">Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-4 py-10 text-center text-neutral-400">
                    <Database className="mx-auto mb-2 h-6 w-6 text-neutral-300" />
                    No imports yet. Point the scraper at the ingest webhook or upload a CSV above.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className="border-t border-neutral-100">
                    <td className="whitespace-nowrap px-4 py-2 text-neutral-500">{fmt(r.created_at)}</td>
                    <td className="px-4 py-2 text-neutral-600">{r.performed_by ?? "scraper"}</td>
                    <td className="px-4 py-2 text-neutral-600">{r.details ?? "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
