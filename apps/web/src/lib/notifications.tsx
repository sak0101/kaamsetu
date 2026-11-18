import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "./api";
import { useAuth } from "./auth";
import { describeNotification } from "./labels";
import { getSupabase } from "./supabase";
import type { NotificationItem } from "./types";

interface NotificationsValue {
  items: NotificationItem[];
  unreadCount: number;
  loading: boolean;
  /** Increments whenever a new notification arrives: lists include it in their deps to refresh. */
  version: number;
  refresh(): Promise<void>;
  markRead(ids?: string[]): Promise<void>;
}

const NotificationsContext = createContext<NotificationsValue | null>(null);

export function useNotifications(): NotificationsValue {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error("useNotifications must be used inside <NotificationsProvider>");
  return ctx;
}

const POLL_MS = 60_000;
const TOAST_MS = 8_000;

/**
 * Notifications for the signed-in user.
 *  - initial load + 60 s polling fallback via GET /api/notifications
 *  - Supabase Realtime (INSERT on public.notifications, filtered to this user; RLS applies)
 * A genuinely new notification bumps `version` and shows a toast.
 */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const userId = me?.profile.id;
  const role = me?.profile.role ?? "worker";
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const [toast, setToast] = useState<NotificationItem | null>(null);
  const newestId = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { notifications } = await api.notifications({ limit: 50 });
      const newest = notifications[0];
      if (newestId.current !== null && newest && newest.id !== newestId.current) {
        setVersion((v) => v + 1);
        if (!newest.read_at) setToast(newest);
      }
      newestId.current = newest?.id ?? newestId.current ?? "none";
      setItems(notifications);
    } catch {
      /* keep the previous list; the next poll retries */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!userId) return;
    newestId.current = null;
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [userId, refresh]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    (async () => {
      try {
        const sb = await getSupabase();
        if (cancelled) return;
        const channel = sb
          .channel(`notifications:${userId}`)
          .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${userId}` }, () => void refresh())
          .subscribe();
        cleanup = () => void sb.removeChannel(channel);
      } catch {
        /* polling covers it */
      }
    })();
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [userId, refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), TOAST_MS);
    return () => window.clearTimeout(t);
  }, [toast]);

  const markRead = useCallback(
    async (ids?: string[]) => {
      await api.markRead(ids);
      await refresh();
    },
    [refresh],
  );

  const value = useMemo<NotificationsValue>(
    () => ({ items, unreadCount: items.filter((n) => !n.read_at).length, loading, version, refresh, markRead }),
    [items, loading, version, refresh, markRead],
  );

  const described = toast ? describeNotification(toast, role) : null;
  return (
    <NotificationsContext.Provider value={value}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
        {toast && described && (
          <div role="status" className="pointer-events-auto flex max-w-md items-start gap-3 rounded-xl bg-ink px-4 py-3 text-white shadow-lg">
            <p className="text-base">
              {described.text}{" "}
              <Link to={described.to} className="font-semibold text-marigold underline" onClick={() => setToast(null)}>
                View
              </Link>
            </p>
            <button type="button" aria-label="Dismiss notification" className="min-h-8 min-w-8 text-xl leading-none text-white/80 hover:text-white" onClick={() => setToast(null)}>
              ×
            </button>
          </div>
        )}
      </div>
    </NotificationsContext.Provider>
  );
}
