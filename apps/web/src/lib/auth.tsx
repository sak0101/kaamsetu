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
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

export function friendlyAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("invalid login credentials")) return "That email and password don't match. Please try again.";
  if (m.includes("email not confirmed")) return "Please confirm your email first. Check your inbox for the confirmation link.";
  if (m.includes("already registered") || m.includes("already been registered")) return "An account with this email already exists. Try signing in instead.";
  if (m.includes("rate limit") || m.includes("too many")) return "Too many attempts. Please wait a few minutes and try again.";
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
        const { data: sub } = sb.auth.onAuthStateChange((_event, session) => {
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

  const value = useMemo<AuthContextValue>(
    () => ({ status, me, error, signIn, signUp, signOut, reloadMe: loadMe }),
    [status, me, error, signIn, signUp, signOut, loadMe],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
