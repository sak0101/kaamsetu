import { useState } from "react";
import { Link, NavLink, Navigate, Outlet, useLocation } from "react-router-dom";
import { APP_NAME } from "@kaamsetu/shared";
import { useAuth } from "../lib/auth";
import { NotificationsProvider, useNotifications } from "../lib/notifications";
import { ReferenceProvider } from "../lib/reference";
import type { Role } from "../lib/types";
import { Button, ButtonLink, LoadingBlock } from "./ui";

export const homeFor = (role: Role) => (role === "worker" ? "/worker" : "/employer");

const NAV: Record<Role, { to: string; label: string; end?: boolean }[]> = {
  worker: [
    { to: "/worker", label: "Find work", end: true },
    { to: "/worker/applications", label: "My applications" },
    { to: "/worker/bookings", label: "Bookings" },
    { to: "/worker/profile", label: "Profile" },
  ],
  employer: [
    { to: "/employer", label: "My jobs", end: true },
    { to: "/employer/jobs/new/ai", label: "Create with AI" },
    { to: "/employer/jobs/new", label: "Post a job", end: true },
    { to: "/employer/bookings", label: "Bookings" },
    { to: "/employer/profile", label: "Profile" },
  ],
};

export const CONTACT_EMAIL = "info@kaamsetu.tech";

function Brand({ to }: { to: string }) {
  return (
    <Link to={to} className="text-2xl font-extrabold tracking-tight text-white">
      <span className="border-b-4 border-terracotta pb-0.5">{APP_NAME}</span>
    </Link>
  );
}

function SkipLink() {
  return (
    <a href="#main" className="sr-only z-[60] rounded-b-lg bg-marigold px-4 py-2 font-semibold text-ink focus:not-sr-only focus:absolute focus:left-4 focus:top-0">
      Skip to main content
    </a>
  );
}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `flex min-h-11 items-center rounded-lg px-3 text-base font-semibold ${isActive ? "bg-white/15 text-white underline decoration-terracotta decoration-4 underline-offset-8" : "text-white/90 hover:bg-white/10"}`;

function Bell() {
  const { unreadCount } = useNotifications();
  return (
    <Link
      to="/notifications"
      aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
      className="relative flex min-h-11 min-w-11 items-center justify-center rounded-lg text-white hover:bg-white/10"
    >
      <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.7 21a2 2 0 0 1-3.4 0" />
      </svg>
      {unreadCount > 0 && (
        <span aria-hidden="true" className="absolute right-0.5 top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-marigold px-1 text-xs font-bold text-ink">
          {unreadCount > 9 ? "9+" : unreadCount}
        </span>
      )}
    </Link>
  );
}

/** Signed-in shell: header with role-specific navigation, notification bell and sign-out. */
function AppShell() {
  const { me, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const role = me!.profile.role;
  const links = NAV[role];

  return (
    <div className="flex min-h-screen flex-col">
      <SkipLink />
      <header className="on-dark bg-ink text-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <Brand to={homeFor(role)} />
          <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
            {links.map((l) => (
              <NavLink key={l.to} to={l.to} end={l.end} className={navLinkClass}>
                {l.label}
              </NavLink>
            ))}
          </nav>
          <div className="flex items-center gap-1">
            <Bell />
            <button
              type="button"
              onClick={() => void signOut()}
              className="hidden min-h-11 rounded-lg px-3 text-base font-semibold text-white/90 hover:bg-white/10 md:block"
            >
              Sign out
            </button>
            <button
              type="button"
              aria-expanded={open}
              aria-controls="mobile-nav"
              aria-label={open ? "Close menu" : "Open menu"}
              onClick={() => setOpen((o) => !o)}
              className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-white hover:bg-white/10 md:hidden"
            >
              <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
              </svg>
            </button>
          </div>
        </div>
        {open && (
          <nav id="mobile-nav" aria-label="Main" className="border-t border-white/15 px-4 pb-3 md:hidden">
            <ul className="flex flex-col gap-1 pt-2">
              {links.map((l) => (
                <li key={l.to}>
                  <NavLink to={l.to} end={l.end} className={navLinkClass} onClick={() => setOpen(false)}>
                    {l.label}
                  </NavLink>
                </li>
              ))}
              <li>
                <button type="button" onClick={() => void signOut()} className="flex min-h-11 w-full items-center rounded-lg px-3 text-left text-base font-semibold text-white/90 hover:bg-white/10">
                  Sign out
                </button>
              </li>
            </ul>
          </nav>
        )}
      </header>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 focus:outline-none sm:py-8">
        <Outlet />
      </main>
      <footer className="border-t border-line px-4 py-4 text-center text-sm text-ink-soft">
        {APP_NAME} · Vadodara, Gujarat · We never ask for Aadhaar or ID numbers. · <Link to="/credits" className="underline">Photo credits</Link>
      </footer>
    </div>
  );
}

function FullPage({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-4 py-10">{children}</div>;
}

/** Everything behind login: resolves the session, then provides reference data + notifications. */
export function SignedInLayout() {
  const { status, error, signOut, reloadMe } = useAuth();
  const location = useLocation();

  if (status === "loading") {
    return (
      <FullPage>
        <LoadingBlock label="Loading your account…" rows={2} />
      </FullPage>
    );
  }
  if (status === "signedOut") return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (status === "error") {
    return (
      <FullPage>
        <h1 className="text-2xl">We couldn't load your account</h1>
        <p role="alert" className="text-danger-dark">{error}</p>
        <div className="flex gap-3">
          <Button onClick={() => void reloadMe()}>Try again</Button>
          <Button variant="secondary" onClick={() => void signOut()}>Sign out</Button>
        </div>
      </FullPage>
    );
  }
  return (
    <ReferenceProvider>
      <NotificationsProvider>
        <AppShell />
      </NotificationsProvider>
    </ReferenceProvider>
  );
}

/** Keeps workers out of employer pages and vice-versa (the API enforces this too). */
export function RoleGate({ role }: { role: Role }) {
  const { me } = useAuth();
  if (!me) return null;
  if (me.profile.role !== role) return <Navigate to={homeFor(me.profile.role)} replace />;
  return <Outlet />;
}

/** Public pages: simple header with Log in / Sign up. */
export function PublicShell() {
  const { status, me } = useAuth();
  return (
    <div className="flex min-h-screen flex-col">
      <SkipLink />
      <header className="on-dark bg-ink text-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <Brand to="/" />
          <nav aria-label="Account" className="flex items-center gap-2">
            {status === "signedIn" && me ? (
              <ButtonLink to={homeFor(me.profile.role)} variant="primary">Open dashboard</ButtonLink>
            ) : (
              <>
                <Link to="/login" className="flex min-h-11 items-center rounded-lg px-3 font-semibold text-white hover:bg-white/10">Log in</Link>
                <ButtonLink to="/signup" variant="primary">Sign up</ButtonLink>
              </>
            )}
          </nav>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="flex-1 focus:outline-none">
        <Outlet />
      </main>
      <footer className="on-dark bg-ink text-white">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <p className="text-xl font-extrabold">
              <span className="border-b-4 border-terracotta pb-0.5">{APP_NAME}</span>
            </p>
            <p className="mt-3 max-w-xs text-white/85">Short-term work, close to home. Connecting people who need a few hands with nearby workers in Vadodara, Gujarat.</p>
          </div>
          <nav aria-label="Footer">
            <h2 className="text-base font-bold text-marigold">Explore</h2>
            <ul className="mt-3 flex flex-col gap-1">
              <li><Link to="/signup?role=employer" className="inline-flex min-h-9 items-center underline-offset-2 hover:underline">Hire workers</Link></li>
              <li><Link to="/signup?role=worker" className="inline-flex min-h-9 items-center underline-offset-2 hover:underline">Find work</Link></li>
              <li><Link to="/login" className="inline-flex min-h-9 items-center underline-offset-2 hover:underline">Log in</Link></li>
              <li><Link to="/credits" className="inline-flex min-h-9 items-center underline-offset-2 hover:underline">Photo credits</Link></li>
            </ul>
          </nav>
          <section aria-labelledby="contact-h">
            <h2 id="contact-h" className="text-base font-bold text-marigold">Contact</h2>
            <p className="mt-3 text-white/85">Questions or feedback? Write to us:</p>
            <a href={`mailto:${CONTACT_EMAIL}`} className="mt-1 inline-flex min-h-11 items-center break-all font-semibold text-white underline decoration-terracotta decoration-2 underline-offset-4 hover:text-marigold">
              {CONTACT_EMAIL}
            </a>
          </section>
        </div>
        <div className="border-t border-white/15 px-4 py-4 text-center text-sm text-white/75">
          © {new Date().getFullYear()} {APP_NAME} · Vadodara, Gujarat · We never ask for Aadhaar or ID numbers.
        </div>
      </footer>
    </div>
  );
}
