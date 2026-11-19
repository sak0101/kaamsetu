import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, api, configureApi } from "./api";
import { getSupabase } from "./supabase";
import type { MeResponse, Role } from "./types";

type Status = "loading" | "signedOut" | "signedIn" | "error";

interface AuthContextValue {
  status: Status;
  me: MeResponse | null;
  /** Set when status === "error". */
  error: string | null;
  signIn(email: string, password: string): Promise<{ error?: string }>;
  signUp(input: { email: string; password: string; fullName: string; role: Role }): Promise<{ error?: string; needsConfirmation?: boolean }>;
  signOut(): Promise<void>;
  reloadMe(): Promise<void>;
  /** True while the user arrived through a password-recovery link and has not chosen a new password yet. */
  recovering: boolean;
  /** Set when the recovery link itself was rejected (expired, already used, malformed). */
  recoveryLinkError: string | null;
  /** Emails a reset link. Never reveals whether the address has an account. */
  requestPasswordReset(email: string): Promise<{ error?: string }>;
  /** Sets the new password for the recovery session, then signs the user out so they log in with it. */
  completePasswordReset(newPassword: string): Promise<{ error?: string }>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

/**
 * Supabase delivers recovery results in the URL hash: `#access_token=…&type=recovery` on success,
 * `#error=access_denied&error_code=otp_expired&…` when the link is expired or already used.
 * It is read synchronously on first render because the Supabase client (which also consumes the hash)
 * can emit PASSWORD_RECOVERY before our listener exists.
 */
export function readRecoveryHash(hash: string): { recovering: boolean; linkError: string | null } {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  if (p.get("type") === "recovery" && p.get("access_token")) return { recovering: true, linkError: null };
  const code = p.get("error_code") ?? p.get("error");
  if (code) return { recovering: false, linkError: "This reset link has expired or was already used. Request a new one below." };
  return { recovering: false, linkError: null };
}

/** For small shared widgets that can also render outside the provider (for example in isolation): never throws. */
export function useOptionalAuth(): AuthContextValue | null {
  return useContext(AuthContext);
}

export function friendlyAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("invalid login credentials")) return "That email and password don't match. Please try again.";
  if (m.includes("email not confirmed")) return "Please confirm your email first. Check your inbox for the confirmation link.";
  if (m.includes("already registered") || m.includes("already been registered")) return "An account with this email already exists. Try signing in instead.";
  if (m.includes("rate limit") || m.includes("too many") || m.includes("security purposes")) return "Too many attempts. Please wait a few minutes and try again.";
  if (m.includes("same password") || m.includes("different from the old")) return "Choose a password you haven't used before.";
  if (m.includes("session") && (m.includes("missing") || m.includes("expired") || m.includes("not found"))) return "This reset link has expired or was already used. Request a new one.";
  if (m.includes("password")) return "Choose a stronger password (at least 8 characters).";
  if (m.includes("valid email") || m.includes("invalid email")) return "Enter a valid email address.";
  if (m.includes("network") || m.includes("fetch")) return "Can't reach KaamSetu right now. Check your connection and try again.";
  return "Something went wrong. Please try again.";
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // undefined = not yet known, null = signed out
  const [userId, setUserId] = useState<string | null | undefined>(undefined);
  const [initialHash] = useState(() => readRecoveryHash(typeof window === "undefined" ? "" : window.location.hash));
  const [recovering, setRecovering] = useState(initialHash.recovering);

  // 1. Bootstrap the Supabase client and follow its session.
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    (async () => {
      try {
        const sb = await getSupabase();
        configureApi({
          getToken: async () => (await sb.auth.getSession()).data.session?.access_token ?? null,
          onUnauthorized: () => void sb.auth.signOut(),
        });
        const { data } = await sb.auth.getSession();
        if (cancelled) return;
        setUserId(data.session?.user.id ?? null);
        const { data: sub } = sb.auth.onAuthStateChange((event, session) => {
          if (event === "PASSWORD_RECOVERY") setRecovering(true);
          if (event === "SIGNED_OUT") setRecovering(false);
          setUserId(session?.user.id ?? null);
        });
        unsubscribe = () => sub.subscription.unsubscribe();
      } catch {
        if (!cancelled) {
          setError("KaamSetu is unavailable right now. Please try again in a moment.");
          setStatus("error");
        }
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const loadMe = useCallback(async () => {
    try {
      const data = await api.me();
      setMe(data);
      setError(null);
      setStatus("signedIn");
    } catch (err) {
      setMe(null);
      if (err instanceof ApiError && err.status === 401) return; // session invalid: the signed-out transition follows
      setError(
        err instanceof ApiError && err.code === "profile_missing"
          ? "This account has no KaamSetu profile. Please contact support."
          : err instanceof ApiError
            ? err.message
            : "Something went wrong loading your account.",
      );
      setStatus("error");
    }
  }, []);

  // 2. Whenever the signed-in user changes, load their role/profile from the API.
  useEffect(() => {
    if (userId === undefined) return;
    if (userId === null) {
      setMe(null);
      setError(null);
      setStatus("signedOut");
      return;
    }
    setStatus("loading");
    void loadMe();
  }, [userId, loadMe]);

  const signIn = useCallback<AuthContextValue["signIn"]>(async (email, password) => {
    try {
      const sb = await getSupabase();
      const { error: err } = await sb.auth.signInWithPassword({ email: email.trim(), password });
      return err ? { error: friendlyAuthError(err.message) } : {};
    } catch {
      return { error: friendlyAuthError("network") };
    }
  }, []);

  const signUp = useCallback<AuthContextValue["signUp"]>(async ({ email, password, fullName, role }) => {
    try {
      const sb = await getSupabase();
      const { data, error: err } = await sb.auth.signUp({
        email: email.trim(),
        password,
        options: { data: { role, full_name: fullName.trim() }, emailRedirectTo: `${window.location.origin}/login` },
      });
      if (err) return { error: friendlyAuthError(err.message) };
      return { needsConfirmation: !data.session };
    } catch {
      return { error: friendlyAuthError("network") };
    }
  }, []);

  const signOut = useCallback(async () => {
    const sb = await getSupabase();
    await sb.auth.signOut();
  }, []);

  const requestPasswordReset = useCallback<AuthContextValue["requestPasswordReset"]>(async (email) => {
    try {
      const sb = await getSupabase();
      const { error: err } = await sb.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/reset-password` });
      // Only rate limits and network failures are surfaced; "no such account" is never revealed.
      if (err && /rate limit|too many|security purposes|network|fetch/i.test(err.message)) return { error: friendlyAuthError(err.message) };
      return {};
    } catch {
      return { error: friendlyAuthError("network") };
    }
  }, []);

  const completePasswordReset = useCallback<AuthContextValue["completePasswordReset"]>(async (newPassword) => {
    try {
      const sb = await getSupabase();
      const { error: err } = await sb.auth.updateUser({ password: newPassword });
      if (err) return { error: friendlyAuthError(err.message) };
      setRecovering(false);
      await sb.auth.signOut(); // they log in again with the new password
      return {};
    } catch {
      return { error: friendlyAuthError("network") };
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status, me, error, signIn, signUp, signOut, reloadMe: loadMe,
      recovering, recoveryLinkError: initialHash.linkError, requestPasswordReset, completePasswordReset,
    }),
    [status, me, error, signIn, signUp, signOut, loadMe, recovering, initialHash.linkError, requestPasswordReset, completePasswordReset],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
