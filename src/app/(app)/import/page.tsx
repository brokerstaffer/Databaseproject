"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Database, Webhook } from "lucide-react";

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
const fmt = (s: string | null) => (s ? new Date(s).toLocaleString() : "—");

export default function ImportPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);

  useEffect(() => {
    fetch("/api/import/history")
      .then((r) => r.json())
      .then((j) => {
        setRows(j.rows ?? []);
        setCounts(j.counts ?? null);
      });
  }, []);

  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-neutral-900">Import</h1>
        <p className="mt-0.5 text-sm text-neutral-500">Agent data flows in from the scraper via the ingest webhook.</p>
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
                    No imports yet. Point the scraper at the ingest webhook to load data.
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
