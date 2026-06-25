"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { FileDown, Users } from "lucide-react";

interface Row {
  id: string;
  action: string;
  performed_by: string | null;
  details: string | null;
  created_at: string;
}
const fmt = (s: string | null) => (s ? new Date(s).toLocaleString() : "—");

export default function ExportPage() {
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    fetch("/api/export/history")
      .then((r) => r.json())
      .then((j) => setRows(j.rows ?? []));
  }, []);

  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-neutral-900">Export</h1>
        <p className="mt-0.5 text-sm text-neutral-500">CSV downloads and Send-to-Clay pushes from Agent Search.</p>
      </div>

      <Link href="/search" className="flex items-center gap-3 rounded-xl border border-neutral-200 bg-white p-4 text-sm shadow-sm hover:bg-neutral-50">
        <Users className="h-5 w-5 text-neutral-400" />
        <div>
          <div className="font-medium text-neutral-800">Export from Agent Search</div>
          <div className="text-neutral-500">Filter agents, then use the Export button to download CSV or send to a client&apos;s Clay.</div>
        </div>
      </Link>

      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
        <div className="border-b border-neutral-100 px-4 py-3 text-sm font-semibold text-neutral-900">Recent exports</div>
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left text-xs font-medium text-neutral-500">
              <tr>
                <th className="px-4 py-2">When</th>
                <th className="px-4 py-2">Type</th>
                <th className="px-4 py-2">By</th>
                <th className="px-4 py-2">Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-10 text-center text-neutral-400">
                    <FileDown className="mx-auto mb-2 h-6 w-6 text-neutral-300" />
                    No exports yet.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className="border-t border-neutral-100">
                    <td className="whitespace-nowrap px-4 py-2 text-neutral-500">{fmt(r.created_at)}</td>
                    <td className="px-4 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs ${r.action === "clay_send" ? "bg-purple-100 text-purple-800" : "bg-blue-100 text-blue-800"}`}>
                        {r.action === "clay_send" ? "Clay" : "CSV"}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-neutral-600">{r.performed_by ?? "—"}</td>
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
