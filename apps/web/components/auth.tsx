"use client";
import { useEffect, useState, type FormEvent } from "react";
import { api, useApi, type Row } from "../lib/api";
import { Button, Field, Logo } from "./ui";

export function Auth({ onLogin }: { onLogin: () => void }) {
  const { data, error: statusError, refetch } = useApi<Row>("auth/status");
  const sso = useApi<{ enabled: boolean; label: string }>("auth/oidc/options");
  const [ssoMfa, setSsoMfa] = useState(false);
  const [invitation, setInvitation] = useState("");
  useEffect(
    () =>
      setInvitation(new URLSearchParams(location.search).get("invite") || ""),
    [],
  );
  const setup = data?.setupRequired && !invitation;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [needCode, setNeedCode] = useState(false);
  useEffect(() => {
    const state = new URLSearchParams(location.search).get("sso");
    setSsoMfa(state === "mfa");
    if (state === "failed")
      setError(
        "Single sign-on failed. Ask an administrator to check the identity mapping or use your local account.",
      );
  }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = Object.fromEntries(new FormData(e.currentTarget));
    try {
      if (invitation) await api("auth/invitation", { ...f, token: invitation });
      if (setup) await api("auth/setup", f);
      await api("auth/login", {
        email: f.email,
        password: f.password,
        code: f.code || undefined,
      });
      if (invitation) history.replaceState(null, "", "/");
      onLogin();
    } catch (e) {
      const message = (e as Error).message;
      if (/code|mfa|totp/i.test(message)) setNeedCode(true);
      setError(message);
    } finally {
      setBusy(false);
    }
  }
  if (statusError)
    return (
      <div className="splash">
        <div style={{ display: "grid", gap: 12, justifyItems: "center" }}>
          <span>NexusSSH is not reachable: {statusError.message}</span>
          <Button variant="outline" onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      </div>
    );
  if (!data) return <div className="splash">Opening your workspace…</div>;
  if (ssoMfa)
    return (
      <div className="auth">
        <form
          className="auth-card"
          onSubmit={(e) => {
            e.preventDefault();
            const code = new FormData(e.currentTarget).get("code");
            setBusy(true);
            setError("");
            void api("auth/oidc/complete", { code })
              .then(() => {
                history.replaceState(null, "", "/");
                onLogin();
              })
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          <Logo />
          <h1>Verify your account</h1>
          <p>Enter an authenticator or recovery code to finish signing in.</p>
          {error && (
            <p className="alert danger" role="alert">
              {error}
            </p>
          )}
          <Field label="Authenticator or recovery code">
            <input
              className="input"
              name="code"
              required
              maxLength={30}
              autoComplete="one-time-code"
              autoFocus
            />
          </Field>
          <Button type="submit" disabled={busy}>
            Verify and sign in
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setSsoMfa(false);
              history.replaceState(null, "", "/");
            }}
          >
            Use local sign-in
          </Button>
        </form>
      </div>
    );
  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <Logo />
        <h1>
          {invitation
            ? "Join your workspace"
            : setup
              ? "Create your workspace"
              : "Sign in"}
        </h1>
        <p className="sub">
          {setup
            ? "Set up the first owner account for this installation."
            : invitation
              ? "Create your account to accept the invitation."
              : "Remote access to your servers, for your team and AI agents."}
        </p>
        {error && (
          <div role="alert" className="alert">
            {error}
          </div>
        )}
        {setup && (
          <>
            <Field label="Workspace name">
              <input
                className="input"
                required
                name="organization"
                autoComplete="organization"
              />
            </Field>
            <Field label="Your name">
              <input
                className="input"
                required
                name="name"
                autoComplete="name"
              />
            </Field>
            <Field
              label="Installation setup token"
              hint="SETUP_TOKEN from your .env file."
            >
              <input
                className="input"
                type="password"
                required
                name="setupToken"
              />
            </Field>
          </>
        )}
        <Field label="Email address">
          <input
            className="input"
            required
            name="email"
            type="email"
            autoComplete="username"
            autoFocus={!setup}
          />
        </Field>
        {invitation && (
          <Field label="Your name">
            <input className="input" required name="name" autoComplete="name" />
          </Field>
        )}
        <Field label="Password">
          <input
            className="input"
            required
            name="password"
            type="password"
            minLength={12}
            autoComplete={
              setup || invitation ? "new-password" : "current-password"
            }
          />
        </Field>
        {!setup && !invitation && needCode && (
          <Field
            label="Authenticator code"
            hint="Lost your device? Enter one of your recovery codes instead."
          >
            <input
              className="input"
              name="code"
              autoFocus
              autoComplete="one-time-code"
              maxLength={14}
            />
          </Field>
        )}
        {!setup && !invitation && !needCode && (
          <p className="small" style={{ marginTop: -8, marginBottom: 16 }}>
            <a onClick={() => setNeedCode(true)}>I use an authenticator app</a>
          </p>
        )}
        <Button type="submit" block disabled={busy || !data}>
          {busy
            ? "Please wait…"
            : setup
              ? "Create workspace"
              : invitation
                ? "Create account"
                : "Sign in"}
        </Button>
        {!setup && !invitation && sso.data?.enabled && (
          <Button
            block
            variant="secondary"
            disabled={busy}
            onClick={() => {
              location.assign("/api/auth/oidc/start");
            }}
          >
            {sso.data.label}
          </Button>
        )}
      </form>
    </div>
  );
}
