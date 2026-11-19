// Demo marketplace data for KaamSetu. Everything here is FICTIONAL and clearly labelled "(Demo)" / "[Demo data]".
// Pure data and helpers: no network access happens in this file.

export const DEMO_EMAIL_DOMAIN = "kaamsetu.invalid"; // a reserved TLD: nothing can ever be delivered to these addresses
export const DEMO_MARKER = "[Demo data]";

export const EMPLOYER = {
  key: "employer",
  email: `demo.employer@${DEMO_EMAIL_DOMAIN}`,
  full_name: "Hitesh Shah (Demo)",
  org_name: "Shah Event Services (Demo)",
  phone: "+919000000001",
};

/** Workers span localities, work types and experience levels, including one who has not stated their experience. */
export const WORKERS = [
  { key: "w1", email: `demo.worker1@${DEMO_EMAIL_DOMAIN}`, full_name: "Ramesh Parmar (Demo)", locality: "Alkapuri", categories: ["event_help", "loading_unloading"], years: 4, skills: ["Guest handling", "Serving food", "Heavy lifting"], availability: "Evenings and weekends", bio: "I have worked at weddings and loaded trucks for four years.", phone: "+919000000011" },
  { key: "w2", email: `demo.worker2@${DEMO_EMAIL_DOMAIN}`, full_name: "Sunita Vasava (Demo)", locality: "Gotri", categories: ["cleaning", "event_help"], years: 2, skills: ["Deep cleaning", "Event set-up"], availability: "Weekdays", bio: null, phone: "+919000000012" },
  { key: "w3", email: `demo.worker3@${DEMO_EMAIL_DOMAIN}`, full_name: "Imran Pathan (Demo)", locality: "Makarpura", categories: ["loading_unloading", "furniture_shifting"], years: 6, skills: ["Heavy lifting", "Packing furniture"], availability: "Any day", bio: "Six years of moving homes and shops.", phone: "+919000000013" },
  { key: "w4", email: `demo.worker4@${DEMO_EMAIL_DOMAIN}`, full_name: "Kiran Solanki (Demo)", locality: "Alkapuri", categories: ["painting_helper", "construction_helper"], years: 1, skills: ["Wall preparation"], availability: "Mornings", bio: null, phone: null },
  { key: "w5", email: `demo.worker5@${DEMO_EMAIL_DOMAIN}`, full_name: "Meena Chauhan (Demo)", locality: "Akota", categories: ["cleaning", "packing"], years: null, skills: ["Packing", "Cleaning"], availability: "Weekends", bio: null, phone: null }, // years not stated: shown as "not provided", never as zero
  { key: "w6", email: `demo.worker6@${DEMO_EMAIL_DOMAIN}`, full_name: "Dev Rathod (Demo)", locality: "Gotri", categories: ["gardening"], years: 3, skills: ["Lawn care", "Hindi", "Gujarati"], availability: "Mornings", bio: "Garden care and tidy-ups.", phone: "+919000000016" },
];

const pad = (n) => String(n).padStart(2, "0");

/** YYYY-MM-DD of (today in IST) + n days. */
export function istDay(now, plusDays) {
  const ist = new Date(now.getTime() + 5.5 * 3_600_000 + plusDays * 86_400_000);
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}`;
}

/** ISO string with the +05:30 offset for an instant (given as epoch milliseconds), expressed in IST. */
export function istIsoFromMs(ms) {
  const d = new Date(ms + 5.5 * 3_600_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00+05:30`;
}

/** ISO string with the +05:30 offset for a local IST date and "HH:MM" time. */
export const istIso = (date, time) => `${date}T${time}:00+05:30`;

/**
 * The demo jobs, dated relative to `now` so they are always upcoming. `apply` lists worker keys that apply;
 * `accept` lists the ones the employer confirms (so the job shows progress such as "2 of 8 booked").
 */
export function buildJobs(now = new Date()) {
  const day = (n) => istDay(now, n);
  // A job that starts a few hours from now (rounded up to the half hour), on whatever IST day that falls, so it is always upcoming.
  const startMs = Math.ceil((now.getTime() + 3 * 3_600_000) / 1_800_000) * 1_800_000;
  const startsTodayIso = istIsoFromMs(startMs);
  const endsTodayIso = istIsoFromMs(startMs + 4 * 3_600_000);

  const job = (title, category, locality, startsAt, endsAt, workers, payType, rupees, description, extra = {}) => ({
    title, category, locality, starts_at: startsAt, ends_at: endsAt, workers_needed: workers, pay_type: payType, pay_amount_paise: rupees * 100,
    description: `${description} ${DEMO_MARKER}`, ...extra,
  });

  return [
    job("Wedding helpers, Alkapuri", "event_help", "Alkapuri", istIso(day(1), "17:00"), istIso(day(2), "00:00"), 8, "fixed", 800,
      "Guest coordination, serving and clear-up at an evening wedding.", { apply: ["w1", "w2", "w3", "w6"], accept: ["w1", "w3"], address: "Demo Banquet Hall, Race Course Road", landmark: "Near the fountain" }),
    job("Catering staff for a lunch buffet", "event_help", "Akota", istIso(day(2), "11:00"), istIso(day(2), "16:00"), 6, "fixed", 600,
      "Serving at a family function lunch buffet.", { apply: ["w2", "w5"] }),
    job("Puja and havan helpers", "event_help", "Gotri", istIso(day(3), "07:00"), istIso(day(3), "12:00"), 4, "fixed", 500,
      "Set-up and arrangements for a morning puja at a home in Gotri.", { apply: [] }),
    job("Exhibition stall set-up crew", "event_help", "Makarpura", istIso(day(4), "08:00"), istIso(day(4), "18:00"), 10, "daily", 900,
      "Carrying and assembling stalls for a two-day trade exhibition.", { apply: ["w3"] }),
    job("Corporate conference set-up", "event_help", "Akota", istIso(day(5), "09:00"), istIso(day(5), "15:00"), 5, "fixed", 700,
      "Chairs, banners and registration desk for an office conference.", { apply: [] }),
    job("Shift household goods", "furniture_shifting", "Gotri", istIso(day(1), "09:00"), istIso(day(1), "13:00"), 2, "daily", 900,
      "Third floor, no lift. Bring a trolley if you have one.", { apply: ["w1", "w3"], accept: ["w3"], address: "14 Sampatrao Colony, Gotri Road", landmark: "Opposite the post office" }),
    job("Truck loading at a godown", "loading_unloading", "Makarpura", startsTodayIso, endsTodayIso, 3, "hourly", 120,
      "Loading cartons onto a truck. Starting later today.", { apply: ["w3"] }),
    job("Deep clean a flat", "cleaning", "Gotri", istIso(day(2), "10:00"), istIso(day(2), "15:00"), 2, "daily", 800,
      "Two-bedroom flat before a family moves in.", { apply: ["w2", "w5"] }),
    job("Paint two rooms", "painting_helper", "Alkapuri", istIso(day(6), "09:00"), istIso(day(6), "17:00"), 2, "daily", 850,
      "Wall preparation and first coat for two rooms.", { apply: ["w4"] }),
    job("Garden clean-up", "gardening", "Gotri", istIso(day(5), "08:00"), istIso(day(5), "12:00"), 1, "daily", 700,
      "Lawn trimming and clearing leaves.", { apply: ["w6"] }),
  ];
}

/**
 * A job that has ALREADY HAPPENED, so judges can see completion and ratings. It cannot be created in the past, so it is
 * created to start in ~40 seconds, booked, and finished once it has started (the seed script waits for that).
 */
export const HISTORY_JOB = {
  title: "Warehouse unloading (completed)",
  category: "loading_unloading",
  locality: "Makarpura",
  workers_needed: 2,
  pay_type: "daily",
  pay_amount_paise: 90000,
  description: `Unloading a delivery at a warehouse. ${DEMO_MARKER}`,
  worker: "w3",
  employerReview: { rating: 5, comment: "On time and careful with the goods." },
  workerReview: { rating: 4, comment: "Clear instructions and paid fairly." },
};
