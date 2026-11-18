// Indian conventions: money is integer paise shown in INR; times are shown in IST (Asia/Kolkata).

const TZ = "Asia/Kolkata";

const inr0 = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatInr(paise: number): string {
  return paise % 100 === 0 ? inr0.format(paise / 100) : inr2.format(paise / 100);
}

const PAY_SUFFIX = { daily: "per day", hourly: "per hour", fixed: "fixed price" } as const;

export function formatPay(paise: number, payType: keyof typeof PAY_SUFFIX): string {
  return `${formatInr(paise)} ${PAY_SUFFIX[payType]}`;
}

const dateFmt = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true });
const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

export const formatDate = (iso: string) => dateFmt.format(new Date(iso));
export const formatTime = (iso: string) => timeFmt.format(new Date(iso)).toUpperCase();
export const formatDateTime = (iso: string) => `${formatDate(iso)}, ${formatTime(iso)}`;

/** "Tue, 25 Nov 2026 · 9:00 AM – 1:00 PM IST" (spans days when needed). */
export function formatRange(startIso: string, endIso: string): string {
  const sameDay = dayKey.format(new Date(startIso)) === dayKey.format(new Date(endIso));
  return sameDay
    ? `${formatDate(startIso)} · ${formatTime(startIso)} – ${formatTime(endIso)} IST`
    : `${formatDateTime(startIso)} – ${formatDateTime(endIso)} IST`;
}

/** Build the ISO-8601 string with the +05:30 offset the API requires from a date + time picked in IST. */
export function toIstIso(date: string, time: string): string {
  return `${date}T${time}:00+05:30`;
}

/** Today's date in IST as YYYY-MM-DD (for date inputs). */
export function todayIst(now: Date = new Date()): string {
  return dayKey.format(now);
}

/** "850" or "850.50" -> paise. Returns null when not a valid positive amount with at most 2 decimals. */
export function rupeesToPaise(input: string): number | null {
  const s = input.trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
  const paise = Math.round(Number(s) * 100);
  return paise > 0 ? paise : null;
}

export const MAX_PAY_PAISE = 5_000_000;

/** The IST calendar date (YYYY-MM-DD) of an instant. */
export const istDate = (iso: string): string => dayKey.format(new Date(iso));

/** YYYY-MM-DD plus n calendar days (pure date arithmetic, no timezone involved). */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function relativeTime(iso: string, now: Date = new Date()): string {
  const diff = Math.round((now.getTime() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return formatDate(iso);
}
