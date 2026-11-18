import { useState } from "react";
import { Link } from "react-router-dom";
import { Alert, Button, EmptyState, LoadingBlock, PageHeader } from "../components/ui";
import { useAuth } from "../lib/auth";
import { relativeTime } from "../lib/format";
import { describeNotification } from "../lib/labels";
import { useNotifications } from "../lib/notifications";

export function NotificationsPage() {
  const { me } = useAuth();
  const { items, unreadCount, loading, markRead } = useNotifications();
  const [failed, setFailed] = useState(false);
  const role = me?.profile.role ?? "worker";

  async function mark(ids?: string[]) {
    setFailed(false);
    try {
      await markRead(ids);
    } catch {
      setFailed(true);
    }
  }

  return (
    <>
      <PageHeader
        title="Notifications"
        subtitle={unreadCount > 0 ? `${unreadCount} unread` : "You're all caught up."}
        actions={unreadCount > 0 ? <Button variant="secondary" onClick={() => void mark()}>Mark all as read</Button> : undefined}
      />
      {failed && <Alert tone="error" className="mb-4">Couldn't update notifications. Please try again.</Alert>}

      {loading && items.length === 0 ? (
        <LoadingBlock label="Loading notifications…" rows={2} />
      ) : items.length === 0 ? (
        <EmptyState title="No notifications yet">
          {role === "worker" ? "You'll hear from us when an employer responds to your applications." : "You'll hear from us when workers apply to your jobs."}
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((n) => {
            const { text, to } = describeNotification(n, role);
            const unread = !n.read_at;
            return (
              <li key={n.id} className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4 ${unread ? "border-marigold bg-white" : "border-line bg-paper"}`}>
                <div>
                  <p className={unread ? "font-semibold" : ""}>
                    {unread && <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full bg-terracotta-dark align-middle" aria-label="Unread" role="img" />}
                    {text}
                  </p>
                  <p className="text-sm text-ink-soft">{relativeTime(n.created_at)}</p>
                </div>
                <div className="flex items-center gap-3">
                  <Link to={to} onClick={() => unread && void mark([n.id])} className="font-semibold underline">View</Link>
                  {unread && <Button variant="ghost" onClick={() => void mark([n.id])}>Mark read</Button>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
