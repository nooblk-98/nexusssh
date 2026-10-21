"use client";
import { useEffect, useState, type FormEvent } from "react";
import { api, useApi, type Row } from "../lib/api";
import { Button, Field, Logo } from "./ui";

export function Auth({ onLogin }: { onLogin: () => void }) {
  const { data } = useApi<Row>("auth/status");
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
  if (!data) return <div className="splash">Opening your workspace…</div>;
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
          <Field label="Authenticator code">
            <input
              className="input"
              name="code"
              autoFocus
              autoComplete="one-time-code"
              inputMode="numeric"
              maxLength={6}
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
      </form>
    </div>
  );
}
