import { addDays, formatDate, todayIst } from "./format";

/**
 * Turns a spoken or typed job search ("Show me event helper jobs near Alkapuri tomorrow",
 * "मुझे कल अलकापुरी में शादी का काम चाहिए", "mane kal Gotri ma safai nu kaam joiye") into filters.
 * This is a deterministic, rule-based parser: no AI call, no network. The caller shows the result and lets
 * the worker edit and confirm it. English, Hindi, Gujarati and Hinglish (Latin-script Hindi/Gujarati) are understood.
 * The Hindi and Gujarati word lists are first-pass and should be reviewed by native speakers.
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

/**
 * Word matching that works for every script. JavaScript's \b only understands ASCII letters, and Devanagari and
 * Gujarati vowel signs are combining marks, so a "word" is a run of letters, marks and digits.
 */
const BEFORE = "(?<![\\p{L}\\p{M}\\p{N}])";
const AFTER = "(?![\\p{L}\\p{M}\\p{N}])";
/**
 * Gujarati attaches its postpositions to the word ("ગોત્રીમાં" = in Gotri, "સફાઈનું" = of cleaning, "રવિવારે" = on Sunday),
 * so a Gujarati word may be followed by one of these endings. Hindi and English keep them as separate words.
 */
const GU_ENDING = "(?:માં|મા|નું|ની|ના|નો|ને|થી|માટે|ે|ો|એ)?";
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const wordRe = (words: string[], flags = "u") => new RegExp(`${BEFORE}(?:${words.map(escapeRe).join("|")})${GU_ENDING}${AFTER}`, flags);

const CATEGORY_WORDS: [string, string[]][] = [
  ["event_help", [
    "event", "events", "wedding", "weddings", "party", "parties", "function", "functions", "catering", "caterer", "caterers", "hospitality", "banquet", "banquets",
    "marriage", "marriages", "reception", "receptions", "waiter", "waiters", "server", "servers",
    "शादी", "शादियों", "विवाह", "इवेंट", "कार्यक्रम", "पार्टी", "केटरिंग", "वेटर", "मेहमान", "फंक्शन",
    "લગ્ન", "ઇવેન્ટ", "ઈવેન્ટ", "કાર્યક્રમ", "પાર્ટી", "કેટરિંગ", "વેઈટર", "વેટર", "ફંક્શન",
    "shaadi", "shadi", "vivah", "lagn", "lagna", "mehman",
  ]],
  ["loading_unloading", [
    "loading", "unloading", "loader", "loaders", "load", "unload", "lifting", "truck", "trucks", "tempo", "tempos", "lorry", "lorries", "godown", "godowns", "warehouse", "warehouses",
    "लोडिंग", "अनलोडिंग", "लोडर", "माल", "गोदाम", "ट्रक", "टेम्पो",
    "લોડિંગ", "અનલોડિંગ", "લોડર", "માલ", "ગોડાઉન", "ટ્રક", "ટેમ્પો",
    "maal", "mal",
  ]],
  ["furniture_shifting", [
    "shifting", "shift", "moving", "mover", "movers", "furniture", "relocation",
    "फर्नीचर", "फर्नीचर", "शिफ्टिंग", "शिफ्ट",
    "ફર્નિચર", "ફર્નીચર", "શિફ્ટિંગ", "શિફ્ટ",
  ]],
  ["cleaning", [
    "cleaning", "cleaner", "cleaners", "clean", "sweeping", "sweep", "housekeeping", "mopping", "washing", "sanitation",
    "सफाई", "सफ़ाई", "झाड़ू", "पोछा", "सफाईकर्मी",
    "સફાઈ", "સફાઇ", "ઝાડુ", "પોતું", "સાફસફાઈ",
    "safai", "saafsafai", "saaf", "jhadu", "pocha",
  ]],
  ["construction_helper", [
    "construction", "mason", "masons", "masonry", "building", "site", "cement", "brick", "bricks", "labour", "labor", "labourer", "labourers", "laborer", "laborers",
    "निर्माण", "मिस्त्री", "राजमिस्त्री", "मजदूर", "मज़दूर", "ईंट", "सीमेंट", "बांधकाम",
    "બાંધકામ", "મજૂર", "મજદૂર", "મિસ્ત્રી", "સિમેન્ટ", "ઈંટ",
    "majdoor", "mazdoor", "mistri", "majur",
  ]],
  ["painting_helper", [
    "painting", "painter", "painters", "paint",
    "पेंटिंग", "पेंट", "रंगाई", "पुताई", "रंगरोगन",
    "પેઈન્ટિંગ", "પેઇન્ટિંગ", "પેઈન્ટ", "પેઇન્ટ", "રંગકામ", "પેન્ટિંગ",
    "putai", "rangai",
  ]],
  ["gardening", [
    "gardening", "gardener", "gardeners", "garden", "lawn", "plant", "plants",
    "बागवानी", "बगीचा", "माली", "बाग", "बगीचे",
    "બાગકામ", "બગીચો", "માળી", "બાગ",
    "baghwani", "bagicha", "bagiche", "mali",
  ]],
  ["packing", [
    "packing", "packer", "packers", "packaging", "pack",
    "पैकिंग", "पैक", "पैकर",
    "પેકિંગ", "પેક", "પેકર",
  ]],
];

/** Other ways of writing each locality: Hindi and Gujarati script, plus common Latin spellings. Keyed by the English name. */
const LOCALITY_ALIASES: Record<string, string[]> = {
  Akota: ["अकोटा", "અકોટા"],
  Alkapuri: ["अलकापुरी", "અલકાપુરી"],
  "Ajwa Road": ["अजवा रोड", "અજવા રોડ", "ajwa"],
  Fatehgunj: ["फतेहगंज", "फतेगंज", "ફતેગંજ", "ફતેહગંજ", "fatehganj", "fategunj", "fateganj"],
  Gorwa: ["गोरवा", "ગોરવા"],
  Gotri: ["गोत्री", "ગોત્રી"],
  Harni: ["हरणी", "हरनी", "હરણી"],
  Karelibaug: ["करेलीबाग", "કારેલીબાગ", "કરેલીબાગ", "karelibag", "kareli baug"],
  Makarpura: ["मकरपुरा", "મકરપુરા"],
  Manjalpur: ["मांजलपुर", "मंजलपुर", "માંજલપુર", "મંજલપુર"],
  Nizampura: ["निजामपुरा", "નિઝામપુરા"],
  "Productivity Road": ["प्रोडक्टिविटी रोड", "પ્રોડક્ટિવિટી રોડ"],
  "Race Course": ["रेस कोर्स", "रेसकोर्स", "રેસ કોર્સ", "રેસકોર્સ", "racecourse"],
  Sayajigunj: ["सयाजीगंज", "સયાજીગંજ", "sayajiganj", "sayaji gunj"],
  Subhanpura: ["सुभानपुरा", "સુભાનપુરા"],
  Tarsali: ["तरसाली", "તરસાલી"],
  Vasna: ["वासना", "वासणा", "વાસણા", "વાસના"],
  "Waghodia Road": ["वाघोडिया रोड", "વાઘોડિયા રોડ", "waghodia", "vaghodia road"],
};

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_WORDS: string[][] = [
  ["sunday", "रविवार", "रवि", "રવિવાર", "ravivar"],
  ["monday", "सोमवार", "સોમવાર", "somvar", "somwar"],
  ["tuesday", "मंगलवार", "મંગળવાર", "મંગલવાર", "mangalvar", "mangalwar"],
  ["wednesday", "बुधवार", "બુધવાર", "budhvar", "budhwar"],
  ["thursday", "गुरुवार", "बृहस्पतिवार", "ગુરુવાર", "guruvar", "guruwar"],
  ["friday", "शुक्रवार", "શુક્રવાર", "shukravar", "shukrawar"],
  ["saturday", "शनिवार", "શનિવાર", "shanivar", "shaniwar"],
];

const DAY_AFTER_TOMORROW = ["day after tomorrow", "परसों", "परसो", "પરમદિવસે", "પરમ દિવસે", "પરમદિવસ", "parso", "parson", "parsu"];
const TOMORROW = ["tomorrow", "कल", "આવતીકાલે", "આવતીકાલ", "કાલે", "કાલ", "kal", "kale", "kaale", "aavtikal"];
const TODAY = ["today", "tonight", "आज", "આજે", "આજ", "aaj", "aj"];

const STOPWORDS = new Set(
  (
    "show me find get give search look looking for i want need work works job jobs near nearby around in at on the a an any to of and or please available " +
    "helper helpers help people person some with can you my is are there hi hey vadodara baroda city area morning evening afternoon night from this next " +
    "today tonight tomorrow day after weekend let see what whats which anything something someone um uh " +
    // Hindi / Hinglish filler
    "मुझे मुझको चाहिए चाहिये काम में के की का को पास आसपास दिखाओ दिखाइए बताओ बताइए वडोदरा बड़ौदा शहर एरिया कोई है हैं और या से पर " +
    "mujhe mujhko chahiye chahie kaam kam mein me ke ki ka ko paas pass dikhao dikhaiye batao bataiye wala wale wali hai hain aur ya se par " +
    // Gujarati filler
    "મને મારે જોઈએ જોઇએ કામ માં મા ના નું ની નો નજીક પાસે બતાવો બતાવ દેખાડો વડોદરા શહેર વિસ્તાર કોઈ છે અને કે થી પર " +
    "mane mare joiye joie kaam ma na nu ni no najik pase batavo batav vadodara chhe ane ke thi par"
  ).split(/\s+/),
);

export function interpretJobQuery(input: string, ctx: QueryContext): InterpretedQuery {
  const today = todayIst(ctx.now ?? new Date());
  // Keep letters, combining marks (Hindi/Gujarati vowel signs) and digits.
  let rest = ` ${input.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s'-]/gu, " ")} `;

  // Locality: longest spelling first so "Waghodia Road" beats any shorter name.
  let localityId: number | null = null;
  let localityName = "";
  const spellings = ctx.localities.flatMap((l) => [l.name, ...(LOCALITY_ALIASES[l.name] ?? [])].map((text) => ({ l, text: text.toLowerCase() })));
  for (const { l, text } of spellings.sort((a, b) => b.text.length - a.text.length)) {
    const re = wordRe([text]);
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
  for (const [slug, words] of CATEGORY_WORDS) {
    const cat = ctx.categories.find((c) => c.slug === slug);
    const re = wordRe(words.map((w) => w.toLowerCase()));
    const m = cat ? re.exec(rest) : null;
    if (cat && m && m.index < bestIndex) {
      bestIndex = m.index;
      categoryId = cat.id;
      categoryName = cat.name_en;
      bestRe = re;
    }
  }
  if (bestRe) rest = rest.replace(new RegExp(bestRe.source, "gu"), " ");

  // Date
  let date: string | null = null;
  let dateLabel = "";
  const dayAfter = wordRe(DAY_AFTER_TOMORROW);
  const tomorrow = wordRe(TOMORROW);
  const todayRe = wordRe(TODAY);
  if (dayAfter.test(rest)) {
    date = addDays(today, 2);
    dateLabel = "the day after tomorrow";
    rest = rest.replace(dayAfter, " ");
  } else if (tomorrow.test(rest)) {
    date = addDays(today, 1);
    dateLabel = "tomorrow";
    rest = rest.replace(tomorrow, " ");
  } else if (todayRe.test(rest)) {
    date = today;
    dateLabel = "today";
    rest = rest.replace(todayRe, " ");
  } else {
    const names = [...WEEKDAY_WORDS.flat(), "weekend", "वीकेंड", "વીકએન્ડ", "weekend"];
    const prefix = ["next", "this", "on", "अगले", "इस", "આવતા", "આ"];
    const wd = new RegExp(`${BEFORE}(?:(${prefix.map(escapeRe).join("|")})\\s+)?(${names.map(escapeRe).join("|")})${GU_ENDING}${AFTER}`, "u").exec(rest);
    if (wd) {
      const spoken = wd[2]!;
      const isWeekend = ["weekend", "वीकेंड", "વીકએન્ડ"].includes(spoken);
      const index = WEEKDAY_WORDS.findIndex((group) => group.includes(spoken));
      const target = isWeekend ? 6 : index;
      const todayDow = new Date(`${today}T00:00:00Z`).getUTCDay();
      const isNext = ["next", "अगले", "આવતા"].includes(wd[1] ?? "");
      let diff = (target - todayDow + 7) % 7;
      if (isNext && diff === 0) diff = 7;
      date = addDays(today, diff);
      const english = isWeekend ? "weekend" : WEEKDAYS[index]!;
      dateLabel = diff === 0 ? "today" : isWeekend ? "this weekend (Saturday)" : `${isNext ? "next " : ""}${english}`;
      rest = rest.replace(new RegExp(escapeRe(wd[0]), "u"), " ");
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
