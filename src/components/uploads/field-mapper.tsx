"use client";

import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AGENT_FIELDS, autoMatchAgentField } from "@/lib/uploads/agent-fields";
import type { FieldMapping } from "@/lib/uploads/normalize-row";

interface FieldMapperProps {
  headers: string[];
  preview: string[][];
  onConfirm: (mapping: FieldMapping) => void;
  onBack: () => void;
}

const SKIP_VALUE = "__skip__";

export function FieldMapper({ headers, preview, onConfirm, onBack }: FieldMapperProps) {
  const [mapping, setMapping] = useState<Record<number, string>>({});

  // Auto-match on mount
  useEffect(() => {
    const auto: Record<number, string> = {};
    headers.forEach((header, idx) => {
      const match = autoMatchAgentField(header);
      if (match) auto[idx] = match;
    });
    setMapping(auto);
  }, [headers]);

  function setField(index: number, value: string) {
    setMapping((prev) => {
      const next = { ...prev };
      if (value === SKIP_VALUE) delete next[index];
      else next[index] = value;
      return next;
    });
  }

  const used = new Set(Object.values(mapping));
  // A name is required (agents are unusable without one); an identity field is strongly
  // recommended — without license/email/phone the match waterfall falls back to
  // name + office zip (low confidence), which can mis-merge same-named agents.
  const hasName = used.has("Name") || (used.has("First Name") && used.has("Last Name"));
  const hasIdentity = used.has("State License") || used.has("Email") || used.has("Phone") || used.has("Mobile Phone");

  function handleConfirm() {
    const filtered: FieldMapping = {};
    for (const [idx, field] of Object.entries(mapping)) filtered[Number(idx)] = field;
    onConfirm(filtered);
  }

  return (
    <div className="space-y-4">
      <div className="max-h-[55vh] overflow-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[200px]">CSV Column</TableHead>
              <TableHead className="w-[240px]">Map To</TableHead>
              <TableHead>Preview</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {headers.map((header, idx) => (
              <TableRow key={idx}>
                <TableCell className="text-xs font-medium">{header}</TableCell>
                <TableCell>
                  <Select value={mapping[idx] ?? SKIP_VALUE} onValueChange={(v) => setField(idx, v)}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="Skip" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SKIP_VALUE} className="text-xs">
                        — Skip —
                      </SelectItem>
                      {AGENT_FIELDS.map((field) => (
                        <SelectItem
                          key={field.key}
                          value={field.key}
                          className="text-xs"
                          disabled={used.has(field.key) && mapping[idx] !== field.key}
                        >
                          {field.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell className="max-w-[300px] truncate text-xs text-muted-foreground">
                  {preview
                    .slice(0, 3)
                    .map((row) => row[idx] ?? "")
                    .join(" | ")}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {!hasName && (
        <p className="text-xs text-red-600">Map a Full name column (or First name + Last name) — agents need a name.</p>
      )}
      {hasName && !hasIdentity && (
        <p className="text-xs text-amber-600">
          No License / Email / Phone mapped — rows will match existing agents by name + office zip only (low
          confidence). Mapping a license number gives the most reliable dedup.
        </p>
      )}

      <div className="flex gap-2">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button onClick={handleConfirm} disabled={!hasName}>
          Continue
        </Button>
      </div>
    </div>
  );
}
