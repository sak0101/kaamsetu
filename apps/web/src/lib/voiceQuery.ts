import { addDays, formatDate, todayIst } from "./format";

/**
 * Turns a spoken or typed job search ("Show me event helper jobs near Alkapuri
 * tomorrow") into filters. This is a deterministic, rule-based parser: no AI call,
 * no network. The caller shows the result and lets the worker edit and confirm it.
 */
export interface QueryContext {
  categories: { id: number; slug: string; name_en: string }[];
  localities: { id: number; name: string }[];
  now?: Date;
}

export interface InterpretedQuery {
  categoryId: number | null;
  localityId: number | null;
  /** YYYY-MM-DD (IST) */
  date: string | null;
  /** Leftover search words for the title/description. */
  keywords: string;
  /** Plain-language reading of the query, shown back to the worker. */
  summary: string;
  recognised: boolean;
}

const CATEGORY_WORDS: [string, RegExp][] = [
  ["event_help", /\b(events?|weddings?|parties|party|functions?|catering|caterers?|hospitality|banquets?|marriages?|receptions?|waiters?|servers?)\b/],
  ["loading_unloading", /\b(loading|unloading|loaders?|load|unload|lifting|trucks?|tempos?|lorry|lorries|godowns?|warehouses?)\b/],
  ["furniture_shifting", /\b(shifting|shift|moving|movers?|furniture|relocation)\b/],
  ["cleaning", /\b(cleaning|cleaners?|clean|sweeping|sweep|housekeeping|mopping|washing|sanitation)\b/],
  ["construction_helper", /\b(construction|masons?|masonry|building|site|cement|bricks?|labou?r(?:ers?)?)\b/],
  ["painting_helper", /\b(painting|painters?|paint)\b/],
  ["gardening", /\b(gardening|gardeners?|garden|lawn|plants?)\b/],
  ["packing", /\b(packing|packers?|packaging|pack)\b/],
];

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const STOPWORDS = new Set(
  (
    "show me find get give search look looking for i want need work works job jobs near nearby around in at on the a an any to of and or please available " +
    "helper helpers help people person some with can you my is are there hi hey vadodara baroda city area morning evening afternoon night from this next " +
    "today tonight tomorrow day after weekend let see what whats which anything something someone um uh"
  ).split(/\s+/),
);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function interpretJobQuery(input: string, ctx: QueryContext): InterpretedQuery {
  const today = todayIst(ctx.now ?? new Date());
  let rest = ` ${input.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, " ")} `;

  // Locality: longest name first so "Waghodia Road" beats any shorter name.
  let localityId: number | null = null;
  let localityName = "";
  for (const l of [...ctx.localities].sort((a, b) => b.name.length - a.name.length)) {
    const re = new RegExp(`\\b${escapeRe(l.name.toLowerCase())}\\b`);
    if (re.test(rest)) {
      localityId = l.id;
      localityName = l.name;
      rest = rest.replace(re, " ");
      break;
    }
  }

  // Category: the earliest mention wins.
  let categoryId: number | null = null;
  let categoryName = "";
  let bestIndex = Infinity;
  let bestRe: RegExp | null = null;
  for (const [slug, re] of CATEGORY_WORDS) {
    const cat = ctx.categories.find((c) => c.slug === slug);
    const m = cat ? re.exec(rest) : null;
    if (cat && m && m.index < bestIndex) {
      bestIndex = m.index;
      categoryId = cat.id;
      categoryName = cat.name_en;
      bestRe = re;
    }
  }
  if (bestRe) rest = rest.replace(new RegExp(bestRe.source, "g"), " ");

  // Date
  let date: string | null = null;
  let dateLabel = "";
  if (/\bday after tomorrow\b/.test(rest)) {
    date = addDays(today, 2);
    dateLabel = "the day after tomorrow";
    rest = rest.replace(/\bday after tomorrow\b/, " ");
  } else if (/\btomorrow\b/.test(rest)) {
    date = addDays(today, 1);
    dateLabel = "tomorrow";
    rest = rest.replace(/\btomorrow\b/, " ");
  } else if (/\b(today|tonight)\b/.test(rest)) {
    date = today;
    dateLabel = "today";
    rest = rest.replace(/\b(today|tonight)\b/, " ");
  } else {
    const wd = /\b(?:(next|this|on)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend)\b/.exec(rest);
    if (wd) {
      const target = wd[2] === "weekend" ? 6 : WEEKDAYS.indexOf(wd[2]!);
      const todayDow = new Date(`${today}T00:00:00Z`).getUTCDay();
      let diff = (target - todayDow + 7) % 7;
      if (wd[1] === "next" && diff === 0) diff = 7;
      date = addDays(today, diff);
      dateLabel = diff === 0 ? "today" : wd[2] === "weekend" ? "this weekend (Saturday)" : `${wd[1] === "next" ? "next " : ""}${wd[2]}`;
      rest = rest.replace(new RegExp(escapeRe(wd[0])), " ");
    }
  }

  const keywords = rest
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ""))
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .join(" ");

  const parts = [categoryName ? `${categoryName} jobs` : "Jobs"];
  if (localityName) parts.push(`in ${localityName}`);
  if (date) parts.push(`${dateLabel} (${formatDate(`${date}T06:00:00Z`)})`);
  if (keywords) parts.push(`matching “${keywords}”`);

  const recognised = Boolean(categoryId || localityId || date || keywords);
  return {
    categoryId,
    localityId,
    date,
    keywords,
    recognised,
    summary: recognised ? parts.join(" ") : "I couldn't pick out a type of work, place or day from that.",
  };
}
