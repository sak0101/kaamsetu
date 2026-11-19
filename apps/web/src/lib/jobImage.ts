import { wordRe } from "./voiceQuery";

/**
 * Which picture a job card shows. KaamSetu's pictures are one consistent set of original illustrations
 * (public/images/*.svg): one per type of work, plus five for the kinds of event under "Event help".
 *
 * The event kind is read from the job's own title and description with plain keyword rules (English, Hindi,
 * Gujarati and Hinglish). There is no AI call and no network request: choosing a picture never costs anything
 * and works the same every time a card is shown. When nothing matches, the general event picture is used.
 */

/** One picture per type of work (the work category slug is the key). */
export const FILE_BY_SLUG: Record<string, string> = {
  event_help: "event-generic.svg",
  loading_unloading: "cat-loading.svg",
  furniture_shifting: "cat-furniture.svg",
  cleaning: "cat-cleaning.svg",
  construction_helper: "cat-construction.svg",
  painting_helper: "cat-painting.svg",
  gardening: "cat-gardening.svg",
  packing: "cat-packing.svg",
};

export type EventKind = "wedding" | "catering" | "exhibition" | "religious" | "corporate";

export const EVENT_FILES: Record<EventKind, string> = {
  wedding: "event-wedding.svg",
  catering: "event-catering.svg",
  exhibition: "event-exhibition.svg",
  religious: "event-religious.svg",
  corporate: "event-corporate.svg",
};

/** Hindi and Gujarati words are first-pass and should be reviewed by native speakers. */
const EVENT_WORDS: Record<EventKind, RegExp> = {
  wedding: wordRe([
    "wedding", "weddings", "marriage", "marriages", "bride", "groom", "baraat", "barat", "mandap", "sangeet", "mehndi", "mehendi", "haldi", "reception", "shaadi", "shadi", "vivah", "lagn", "lagna",
    "शादी", "शादियों", "विवाह", "बारात", "मंडप", "हल्दी", "मेहंदी", "रिसेप्शन",
    "લગ્ન", "વિવાહ", "જાન", "માંડવો", "હલ્દી", "મહેંદી", "રિસેપ્શન",
  ]),
  catering: wordRe([
    "catering", "caterer", "caterers", "buffet", "kitchen", "cook", "cooks", "chef", "chefs", "food", "serving", "waiter", "waiters", "waitress", "dining", "lunch", "dinner", "meal", "meals",
    "केटरिंग", "खाना", "रसोई", "भोजन", "वेटर", "परोसना", "बुफे",
    "કેટરિંગ", "જમણ", "રસોડું", "ભોજન", "વેઈટર", "વેટર", "જમવાનું", "બુફે",
  ]),
  exhibition: wordRe([
    "exhibition", "exhibitions", "expo", "trade fair", "fair", "stall", "stalls", "booth", "booths", "mela", "trade show", "showcase",
    "प्रदर्शनी", "मेला", "स्टॉल", "एक्सपो",
    "એક્ઝિબિશન", "પ્રદર્શન", "મેળો", "સ્ટોલ", "એક્સ્પો",
  ]),
  religious: wordRe([
    "puja", "pooja", "havan", "hawan", "yagna", "yajna", "katha", "satsang", "bhajan", "kirtan", "temple", "mandir", "religious", "bhandara", "jagran", "jagrata", "aarti", "navratri", "garba", "ganesh", "diwali", "festival", "pran pratishtha",
    "पूजा", "हवन", "यज्ञ", "कथा", "सत्संग", "भजन", "कीर्तन", "मंदिर", "भंडारा", "जागरण", "आरती", "नवरात्रि", "गरबा", "त्योहार", "गणेश", "दिवाली",
    "પૂજા", "હવન", "યજ્ઞ", "કથા", "સત્સંગ", "ભજન", "કીર્તન", "મંદિર", "ભંડારો", "જાગરણ", "આરતી", "નવરાત્રી", "ગરબા", "તહેવાર", "ગણેશ", "દિવાળી",
  ]),
  corporate: wordRe([
    "corporate", "conference", "seminar", "meeting", "office", "launch", "product launch", "annual day", "team event", "convention", "workshop", "summit", "boardroom", "company",
    "कॉर्पोरेट", "सम्मेलन", "सेमिनार", "बैठक", "कंपनी", "ऑफिस",
    "કોર્પોરેટ", "કોન્ફરન્સ", "સેમિનાર", "મીટિંગ", "કંપની", "ઓફિસ",
  ]),
};

/** The event kind whose keyword appears EARLIEST in the text, or null. */
function firstKind(text: string): EventKind | null {
  const lower = text.toLowerCase();
  let best: { kind: EventKind; index: number } | null = null;
  for (const kind of Object.keys(EVENT_WORDS) as EventKind[]) {
    const m = EVENT_WORDS[kind].exec(lower);
    if (m && (best === null || m.index < best.index)) best = { kind, index: m.index };
  }
  return best?.kind ?? null;
}

/** The title is the organiser's own summary of the job, so it decides first; the description is the fallback. */
export function classifyEvent(title: string, description = ""): EventKind | null {
  return firstKind(title) ?? firstKind(description);
}

/**
 * The picture file for a job. Only "Event help" jobs are told apart by kind of event; every other type of work keeps
 * its own picture (a cleaning job after a wedding is still a cleaning job). Unknown types have no file (a coloured tile is shown).
 */
export function imageFileFor(slug: string | undefined, title?: string, description?: string): string | undefined {
  if (!slug) return undefined;
  if (slug === "event_help" && (title || description)) {
    const kind = classifyEvent(title ?? "", description ?? "");
    if (kind) return EVENT_FILES[kind];
  }
  return FILE_BY_SLUG[slug];
}
