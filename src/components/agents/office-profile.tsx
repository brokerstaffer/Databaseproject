"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface OfficeInfo {
  id: string;
  office_name: string | null;
  brand: string | null;
  office_city: string | null;
  office_state: string | null;
  office_zip: string | null;
  sales_volume: number | null;
  units: number | null;
}
interface OfficeAgent {
  id: string;
  full_name: string | null;
  license_number: string | null;
  preferred_email: string | null;
  preferred_phone: string | null;
  sales_volume: number | null;
  units: number | null;
  title: string | null;
}
const usd = (n: number | null) => (n == null ? "—" : "$" + Math.round(n).toLocaleString());
const na = (s: string | null) => (s == null || s === "" ? "—" : s);

export function OfficeProfile({ officeId, onOpenChange }: { officeId: string | null; onOpenChange: (o: boolean) => void }) {
  const [office, setOffice] = useState<OfficeInfo | null>(null);
  const [agents, setAgents] = useState<OfficeAgent[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const pageSize = 50;

  const load = useCallback(async () => {
    if (!officeId) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/offices/${officeId}/agents?page=${page}&pageSize=${pageSize}`);
      const j = await r.json();
      setOffice(j.office ?? null);
      setAgents(j.agents ?? []);
      setTotal(j.total ?? 0);
    } finally {
      setLoading(false);
    }
  }, [officeId, page]);

  useEffect(() => {
    setPage(1);
  }, [officeId]);
  useEffect(() => {
    load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <Dialog open={!!officeId} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{office?.office_name ?? "Office"}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-neutral-600">
          {office?.brand && <span><span className="text-neutral-400">Brand:</span> {office.brand}</span>}
          {(office?.office_city || office?.office_state) && (
            <span><span className="text-neutral-400">Location:</span> {[office?.office_city, office?.office_state].filter(Boolean).join(", ")}{office?.office_zip ? ` ${office.office_zip}` : ""}</span>
          )}
          <span><span className="text-neutral-400">Sales volume:</span> {usd(office?.sales_volume ?? null)}</span>
          <span><span className="text-neutral-400">Agents:</span> {total.toLocaleString()}</span>
        </div>

        <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-neutral-200">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-neutral-50 text-left text-xs font-medium text-neutral-500">
              <tr>
                <th className="px-3 py-2">Agent</th>
                <th className="px-3 py-2">Title</th>
                <th className="px-3 py-2">License</th>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2 text-right">Sales volume</th>
                <th className="px-3 py-2 text-right">Units</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="px-3 py-8 text-center text-neutral-400">Loading…</td></tr>
              ) : agents.length === 0 ? (
                <tr><td colSpan={6} className="px-3 py-8 text-center text-neutral-400">No agents linked to this office.</td></tr>
              ) : (
                agents.map((a) => (
                  <tr key={a.id} className="border-t border-neutral-100">
                    <td className="px-3 py-2 font-medium text-neutral-800">{na(a.full_name)}</td>
                    <td className="px-3 py-2 text-neutral-600">{na(a.title)}</td>
                    <td className="px-3 py-2 text-neutral-600">{na(a.license_number)}</td>
                    <td className="px-3 py-2 text-neutral-600">{na(a.preferred_email)}</td>
                    <td className="px-3 py-2 text-right text-neutral-700">{usd(a.sales_volume)}</td>
                    <td className="px-3 py-2 text-right text-neutral-700">{a.units == null ? "—" : a.units.toLocaleString()}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-end gap-3 text-sm text-neutral-600">
          <span>{page} of {totalPages}</span>
          <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded-md border border-neutral-300 p-1.5 disabled:opacity-40">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="rounded-md border border-neutral-300 p-1.5 disabled:opacity-40">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
