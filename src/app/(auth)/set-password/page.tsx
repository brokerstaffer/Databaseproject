"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function SetPasswordPage() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const supabase = createClient();

  // A recovery link arrives with the tokens in the URL FRAGMENT (#access_token=...&refresh_token=...).
  // Nothing server-side can see a fragment, so the session has to be established here before
  // updateUser() below has anything to update -- without this the page rendered fine and then
  // failed with "Auth session missing" the moment you submitted.
  //
  // Mirrors the handler on the login page; the fragment is cleared afterwards so the tokens do not
  // sit in the address bar or leak into history and Referer headers.
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash) {
      setReady(true);
      return;
    }
    const params = new URLSearchParams(hash.substring(1));
    const hashError = params.get("error_description");
    if (hashError) {
      setError(hashError.replace(/\+/g, " "));
      window.history.replaceState(null, "", window.location.pathname);
      setReady(true);
      return;
    }
    const access_token = params.get("access_token");
    const refresh_token = params.get("refresh_token");
    if (!access_token || !refresh_token) {
      setReady(true);
      return;
    }
    supabase.auth
      .setSession({ access_token, refresh_token })
      .then(({ error: e }) => {
        if (e) setError(e.message);
        window.history.replaceState(null, "", window.location.pathname);
      })
      .finally(() => setReady(true));
  }, [supabase.auth]);

  async function handleSetPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 6) {
      setError("Password must be at least 6 characters");
      return;
    }

    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }

    setLoading(true);

    const { error } = await supabase.auth.updateUser({ password });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    window.location.href = "/search";
  }

  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle className="text-2xl font-bold">Set Your Password</CardTitle>
        <p className="text-sm text-muted-foreground">
          Create a password to access your account
        </p>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSetPassword} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="password" className="text-sm font-medium">
              New Password
            </label>
            <Input
              id="password"
              type="password"
              placeholder="At least 6 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="confirm" className="text-sm font-medium">
              Confirm Password
            </label>
            <Input
              id="confirm"
              type="password"
              placeholder="Confirm your password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {/* !ready: the recovery session is still being established from the URL fragment.
              Submitting before that resolves fails with "Auth session missing". */}
          <Button type="submit" className="w-full" disabled={loading || !ready}>
            {loading ? "Setting password..." : "Set Password"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
