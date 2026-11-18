import { useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Link, type LinkProps } from "react-router-dom";
import { ApiError } from "../lib/api";
import type { Tone } from "../lib/labels";

// ----------------------------------------------------------------- buttons
type Variant = "primary" | "secondary" | "danger" | "ghost";

const BASE =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 py-2 text-base font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-terracotta-dark text-white hover:bg-terracotta-darker",
  secondary: "border-2 border-ink bg-paper text-ink hover:bg-cream",
  danger: "bg-danger text-white hover:bg-danger-dark",
  ghost: "text-ink underline underline-offset-2 hover:bg-ink/5",
};

export function buttonClass(variant: Variant = "primary", extra = "") {
  return `${BASE} ${VARIANTS[variant]} ${extra}`.trim();
}

export function Button({
  variant = "primary",
  loading = false,
  className = "",
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean }) {
  return (
    <button type={type} className={buttonClass(variant, className)} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function ButtonLink({ variant = "primary", className = "", ...rest }: LinkProps & { variant?: Variant }) {
  return <Link className={buttonClass(variant, className)} {...rest} />;
}

export function Spinner({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent ${className}`} />;
}

// ------------------------------------------------------------------ fields
interface FieldShellProps {
  label: string;
  error?: string;
  hint?: string;
  required?: boolean;
  /** Small status chip shown beside the label (e.g. "Filled by AI"). */
  badge?: ReactNode;
}

function describedBy(id: string, hint?: string, error?: string) {
  return [hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
}

function Shell({ id, label, error, hint, required, badge, children }: FieldShellProps & { id: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="text-base font-semibold">
          {label}
          {required && <span aria-hidden="true" className="text-danger"> *</span>}
        </label>
        {badge}
      </div>
      {hint && (
        <p id={`${id}-hint`} className="text-sm text-ink-soft">
          {hint}
        </p>
      )}
      {children}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-sm font-semibold text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

const CONTROL =
  "min-h-11 w-full rounded-lg border-2 border-line bg-white px-3 py-2 text-base text-ink placeholder:text-ink-soft/70 aria-[invalid=true]:border-danger";

export function TextField({ label, error, hint, required, badge, id, className = "", ...rest }: FieldShellProps & InputHTMLAttributes<HTMLInputElement>) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Shell id={fid} label={label} error={error} hint={hint} required={required} badge={badge}>
      <input id={fid} required={required} aria-invalid={error ? true : undefined} aria-describedby={describedBy(fid, hint, error)} className={`${CONTROL} ${className}`} {...rest} />
    </Shell>
  );
}

export function SelectField({ label, error, hint, required, badge, id, children, className = "", ...rest }: FieldShellProps & SelectHTMLAttributes<HTMLSelectElement>) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Shell id={fid} label={label} error={error} hint={hint} required={required} badge={badge}>
      <select id={fid} required={required} aria-invalid={error ? true : undefined} aria-describedby={describedBy(fid, hint, error)} className={`${CONTROL} ${className}`} {...rest}>
        {children}
      </select>
    </Shell>
  );
}

export function TextAreaField({ label, error, hint, required, badge, id, className = "", ...rest }: FieldShellProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Shell id={fid} label={label} error={error} hint={hint} required={required} badge={badge}>
      <textarea id={fid} required={required} aria-invalid={error ? true : undefined} aria-describedby={describedBy(fid, hint, error)} className={`${CONTROL} min-h-24 ${className}`} {...rest} />
    </Shell>
  );
}

// --------------------------------------------------------------- feedback
const ALERT_TONES: Record<"error" | "success" | "info" | "warning", string> = {
  error: "border-danger bg-danger-bg text-danger-dark",
  success: "border-success bg-success-bg text-success",
  info: "border-ink-soft bg-paper text-ink",
  warning: "border-marigold bg-marigold/20 text-ink",
};

export function Alert({ tone = "info", title, children, className = "" }: { tone?: keyof typeof ALERT_TONES; title?: string; children?: ReactNode; className?: string }) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`rounded-lg border-l-4 px-4 py-3 ${ALERT_TONES[tone]} ${className}`}>
      {title && <p className="font-bold">{title}</p>}
      {children && <div className="text-base">{children}</div>}
    </div>
  );
}

/** Turns any thrown value into an error Alert (with per-field details when the API sent them). */
export function ErrorAlert({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  const e = error as Partial<ApiError>;
  const message = error instanceof Error ? error.message : "Something went wrong. Please try again.";
  return (
    <Alert tone="error" className={className}>
      <p>{message}</p>
      {Array.isArray(e.details) && e.details.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-sm">
          {e.details.map((d, i) => (
            <li key={i}>{d.path ? `${d.path}: ` : ""}{d.message}</li>
          ))}
        </ul>
      )}
    </Alert>
  );
}

export function LoadingBlock({ label = "Loading…", rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-3">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} aria-hidden="true" className="h-24 animate-pulse rounded-xl bg-paper/70" />
      ))}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-xl border-2 border-dashed border-line bg-paper px-6 py-10 text-center">
      <h2 className="text-xl">{title}</h2>
      {children && <div className="mx-auto mt-2 max-w-md text-ink-soft">{children}</div>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3">
      <ErrorAlert error={error} className="w-full" />
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ layout
const BADGE: Record<Tone, string> = {
  neutral: "bg-line/60 text-ink",
  info: "bg-ink text-white",
  success: "bg-success-bg text-success",
  warning: "bg-marigold text-ink",
  danger: "bg-danger-bg text-danger-dark",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-sm font-semibold ${BADGE[tone]}`}>{children}</span>;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-xl border border-line bg-paper p-4 shadow-sm sm:p-5 ${className}`}>{children}</section>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 text-ink-soft">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

/** Small "label: value" pair used in cards. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-sm text-ink-soft">{label}</dt>
      <dd className="font-semibold">{children}</dd>
    </div>
  );
}

/** Where a draft value came from, for the AI review screen. Always text, never colour alone. */
export function SourceBadge({ kind }: { kind: "ai" | "assumed" | "missing" }) {
  const map = {
    ai: { text: "Filled by AI: please check", cls: "border-ink-soft bg-white text-ink" },
    assumed: { text: "Assumed: please check", cls: "border-marigold bg-marigold/25 text-ink" },
    missing: { text: "Needs your input", cls: "border-danger bg-danger-bg text-danger-dark" },
  }[kind];
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-bold ${map.cls}`}>{map.text}</span>;
}
