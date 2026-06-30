"use client";

import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Copy, Check, Plus, Webhook, KeyRound, Users, ScrollText } from "lucide-react";
import { toast } from "sonner";

const ROLES = ["owner", "admin", "manager", "viewer"];
const fmt = (s: string | null) => (s ? new Date(s).toLocaleString() : "—");

function CopyButton({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(value);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-neutral-300 px-2 py-1.5 text-xs text-neutral-600 hover:bg-neutral-50"
    >
      {done ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
      {done ? "Copied" : "Copy"}
    </button>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mb-1 text-sm font-medium text-neutral-700">{label}</div>
      <div className="flex items-center gap-2">
        <code className="flex-1 overflow-auto rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-800">{value}</code>
        <CopyButton value={value} />
      </div>
    </div>
  );
}

// ---------- Data Webhook ----------
function DataWebhookTab() {
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const sample = `{
  "source": "courted",
  "rows": [
    {
      "Name": "Jane Doe",
      "State License": "12345",
      "Office": "Acme Realty",
      "Email": "jane@acme.com",
      "Home City": "Austin", "Home State": "TX",
      "LTM Sales Volume": "1250000",
      "LTM Closed Units": "8"
    }
  ]
}`;
  return (
    <div className="max-w-2xl space-y-5">
      <p className="text-sm text-neutral-600">
        Point your scraper at this endpoint to push agent data into the database. Authenticate with a key from the <b>API Keys</b> tab, sent
        as the <code className="rounded bg-neutral-100 px-1">x-ingest-token</code> header.
      </p>
      <Field label="Endpoint (POST)" value={origin ? `${origin}/api/ingest/agents` : "/api/ingest/agents"} />
      <Field label="Auth header" value="x-ingest-token: <your API key>" />
      <div>
        <div className="mb-1 text-sm font-medium text-neutral-700">Example request body</div>
        <pre className="overflow-auto rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-700">{sample}</pre>
      </div>
      <ul className="list-disc space-y-1 pl-5 text-xs text-neutral-500">
        <li>Up to 2,000 rows per request — loop in batches for larger loads.</li>
        <li>Set <code>source</code> to courted | zillow | realtor. Send each source&apos;s own native CSV column names — the app maps Zillow/Realtor columns automatically.</li>
        <li>Idempotent: re-sending the same agents updates them (matched by license → email → phone).</li>
      </ul>
    </div>
  );
}

// ---------- API Keys ----------
interface ApiKey {
  id: string;
  name: string;
  masked: string;
  created_at: string;
  last_used_at: string | null;
  revoked: boolean;
}
function ApiKeysTab() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<{ name: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const r = await fetch("/api/admin/api-keys");
    const j = await r.json();
    setKeys(j.keys ?? []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    const r = await fetch("/api/admin/api-keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    const j = await r.json();
    setBusy(false);
    if (r.ok) {
      setFresh({ name: j.name, key: j.key });
      setName("");
      load();
    } else toast.error(j.error ?? "Failed to create key");
  }
  async function revoke(id: string) {
    const r = await fetch(`/api/admin/api-keys?id=${id}`, { method: "DELETE" });
    if (r.ok) {
      toast.success("Key revoked");
      load();
    } else toast.error("Failed to revoke");
  }

  return (
    <div className="max-w-3xl space-y-5">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <div className="mb-1 text-sm font-medium text-neutral-700">Generate a new API key</div>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Courted scraper" />
        </div>
        <Button onClick={create} disabled={busy || !name.trim()}>
          <Plus className="mr-1 h-4 w-4" /> Generate
        </Button>
      </div>
      {fresh && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <div className="text-sm font-medium text-amber-900">New key “{fresh.name}” — copy it now, it won’t be shown again.</div>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 overflow-auto rounded bg-white px-3 py-2 text-xs">{fresh.key}</code>
            <CopyButton value={fresh.key} />
          </div>
        </div>
      )}
      <div className="overflow-hidden rounded-lg border border-neutral-200">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs font-medium text-neutral-500">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Key</th>
              <th className="px-3 py-2">Created</th>
              <th className="px-3 py-2">Last used</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {keys.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-neutral-400">No API keys yet.</td>
              </tr>
            ) : (
              keys.map((k) => (
                <tr key={k.id} className="border-t border-neutral-100">
                  <td className="px-3 py-2 text-neutral-800">{k.name}</td>
                  <td className="px-3 py-2 font-mono text-xs text-neutral-500">{k.masked}</td>
                  <td className="px-3 py-2 text-neutral-500">{fmt(k.created_at)}</td>
                  <td className="px-3 py-2 text-neutral-500">{fmt(k.last_used_at)}</td>
                  <td className="px-3 py-2">
                    {k.revoked ? <Badge variant="secondary">Revoked</Badge> : <Badge className="bg-green-100 text-green-800">Active</Badge>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {!k.revoked && (
                      <button type="button" onClick={() => revoke(k.id)} className="text-xs text-red-600 hover:underline">
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- Users ----------
interface UserRow {
  id: string;
  email: string | null;
  full_name: string | null;
  role: string;
  is_active: boolean;
  created_at: string;
}
function UsersTab({ currentUserId }: { currentUserId: string }) {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("viewer");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/admin/users");
    const j = await r.json();
    setUsers(j.users ?? []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function invite() {
    if (!email.trim()) return;
    setBusy(true);
    const r = await fetch("/api/admin/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim(), name: name.trim() || null, role, password: password || undefined }),
    });
    const j = await r.json();
    setBusy(false);
    if (r.ok) {
      toast.success(password ? "User created" : "Invite sent");
      setOpen(false);
      setEmail("");
      setName("");
      setPassword("");
      setRole("viewer");
      load();
    } else toast.error(j.error ?? "Failed");
  }
  async function changeRole(userId: string, newRole: string) {
    const r = await fetch("/api/admin/update-role", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId, newRole }) });
    if (r.ok) {
      toast.success("Role updated");
      load();
    } else toast.error("Failed to update role");
  }
  async function resetPw(userId: string) {
    const r = await fetch("/api/admin/reset-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId }) });
    toast[r.ok ? "success" : "error"](r.ok ? "Reset link sent" : "Failed");
  }
  async function del(userId: string) {
    if (!confirm("Delete this user?")) return;
    const r = await fetch("/api/admin/delete-user", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId }) });
    if (r.ok) {
      toast.success("User deleted");
      load();
    } else toast.error("Failed to delete");
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setOpen(true)}>
          <Plus className="mr-1 h-4 w-4" /> Invite user
        </Button>
      </div>
      <div className="overflow-hidden rounded-lg border border-neutral-200">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs font-medium text-neutral-500">
            <tr>
              <th className="px-3 py-2">Email</th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Role</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-neutral-100">
                <td className="px-3 py-2 text-neutral-800">{u.email}</td>
                <td className="px-3 py-2 text-neutral-600">{u.full_name ?? "—"}</td>
                <td className="px-3 py-2">
                  <Select value={u.role} onValueChange={(v) => changeRole(u.id, v)} disabled={u.id === currentUserId}>
                    <SelectTrigger className="h-8 w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ROLES.map((r) => (
                        <SelectItem key={r} value={r}>
                          {r}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </td>
                <td className="px-3 py-2">
                  {u.is_active ? <Badge className="bg-green-100 text-green-800">Active</Badge> : <Badge variant="secondary">Inactive</Badge>}
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="flex justify-end gap-3">
                    <button type="button" onClick={() => resetPw(u.id)} className="text-xs text-neutral-600 hover:underline">
                      Reset password
                    </button>
                    {u.id !== currentUserId && (
                      <button type="button" onClick={() => del(u.id)} className="text-xs text-red-600 hover:underline">
                        Delete
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Invite user</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input placeholder="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <Input placeholder="Full name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input placeholder="Temp password (optional — else email invite)" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={invite} disabled={busy || !email.trim()}>
              {busy ? "Sending…" : "Send invite"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------- Activity ----------
interface ActivityRow {
  id: string;
  action: string;
  performed_by: string | null;
  details: string | null;
  created_at: string;
}
const ACTION_TONE: Record<string, string> = {
  ingest: "bg-blue-100 text-blue-800",
  clay_send: "bg-purple-100 text-purple-800",
  api_key_created: "bg-green-100 text-green-800",
  api_key_revoked: "bg-red-100 text-red-800",
  user_deleted: "bg-red-100 text-red-800",
};
function ActivityTab() {
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const load = useCallback(async () => {
    const r = await fetch("/api/admin/activity");
    const j = await r.json();
    setRows(j.activity ?? []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200">
      <table className="w-full text-sm">
        <thead className="bg-neutral-50 text-left text-xs font-medium text-neutral-500">
          <tr>
            <th className="px-3 py-2">When</th>
            <th className="px-3 py-2">Action</th>
            <th className="px-3 py-2">By</th>
            <th className="px-3 py-2">Details</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-3 py-6 text-center text-neutral-400">No activity yet.</td>
            </tr>
          ) : (
            rows.map((a) => (
              <tr key={a.id} className="border-t border-neutral-100 align-top">
                <td className="whitespace-nowrap px-3 py-2 text-neutral-500">{fmt(a.created_at)}</td>
                <td className="px-3 py-2">
                  <Badge className={ACTION_TONE[a.action] ?? "bg-neutral-100 text-neutral-700"}>{a.action}</Badge>
                </td>
                <td className="px-3 py-2 text-neutral-600">{a.performed_by ?? "—"}</td>
                <td className="px-3 py-2 text-neutral-600">{a.details ?? "—"}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------- shell ----------
const SECTIONS = [
  { key: "users", label: "Users", icon: Users, title: "Users", desc: "Invite teammates and manage their roles and access." },
  { key: "keys", label: "API Keys", icon: KeyRound, title: "API Keys", desc: "Generate and revoke keys that authenticate the ingest endpoint." },
  { key: "webhook", label: "Data Webhook", icon: Webhook, title: "Data Webhook", desc: "The endpoint your scraper posts agent data to." },
  { key: "activity", label: "Activity", icon: ScrollText, title: "Activity", desc: "Recent actions across ingestion, exports, keys, and users." },
] as const;

export function AdminClient({ currentUserId }: { currentUserId: string }) {
  const [active, setActive] = useState<string>("users");
  const section = SECTIONS.find((s) => s.key === active) ?? SECTIONS[0];

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="text-xl font-semibold text-neutral-900">Admin</h1>
      <p className="mt-0.5 text-sm text-neutral-500">Manage data ingestion, API access, users, and activity.</p>

      <div className="mt-5 flex flex-col gap-5 md:flex-row">
        <nav className="flex shrink-0 gap-1 overflow-x-auto md:w-56 md:flex-col md:overflow-visible">
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            const on = s.key === active;
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => setActive(s.key)}
                className={cn(
                  "flex items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-colors md:w-full",
                  on ? "bg-neutral-900 text-white" : "text-neutral-700 hover:bg-neutral-200/70"
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {s.label}
              </button>
            );
          })}
        </nav>

        <div className="min-w-0 flex-1 rounded-xl border border-neutral-200 bg-white p-6 shadow-sm">
          <div className="mb-5 border-b border-neutral-100 pb-4">
            <h2 className="text-base font-semibold text-neutral-900">{section.title}</h2>
            <p className="mt-0.5 text-sm text-neutral-500">{section.desc}</p>
          </div>
          {active === "webhook" && <DataWebhookTab />}
          {active === "keys" && <ApiKeysTab />}
          {active === "users" && <UsersTab currentUserId={currentUserId} />}
          {active === "activity" && <ActivityTab />}
        </div>
      </div>
    </div>
  );
}
