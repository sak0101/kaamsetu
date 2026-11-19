import { useState } from "react";
import { APP_TAGLINE } from "@kaamsetu/shared";
import { Link } from "react-router-dom";
import { CategoryImage } from "../components/CategoryImage";
import { homeFor } from "../components/Layout";
import { Badge, ButtonLink } from "../components/ui";
import { useAuth } from "../lib/auth";

/** Alt text describes what the hero photo actually shows (see public/images/credits.json). */
const HERO_ALT = "Porters in red shirts carrying suitcases on their heads on a railway platform in Delhi";

const KINDS_OF_WORK: { slug: string; name: string; blurb: string }[] = [
  { slug: "event_help", name: "Wedding & event help", blurb: "Guest coordination, serving, set-up and clear-up." },
  { slug: "loading_unloading", name: "Loading & unloading", blurb: "Trucks, tempos and godowns, by the hour or the day." },
  { slug: "furniture_shifting", name: "Furniture shifting", blurb: "Moving homes and shops without the hassle." },
  { slug: "cleaning", name: "Cleaning", blurb: "Homes, shops, restaurants and event venues." },
  { slug: "construction_helper", name: "Construction helpers", blurb: "Site helpers for building and repair work." },
  { slug: "painting_helper", name: "Painting helpers", blurb: "Hands for walls, ceilings and touch-ups." },
  { slug: "gardening", name: "Gardening", blurb: "Lawns, plants and outdoor tidy-ups." },
  { slug: "packing", name: "Packing", blurb: "Boxing and wrapping for a move or a shipment." },
];

const EMPLOYER_STEPS = [
  ["Say what you need", "Type it, say it out loud, or fill the form. AI turns your words into a job you can edit before it goes live."],
  ["Compare who applied", "See each worker's type of work, area and experience side by side, with a plain-language reason for every match."],
  ["Book with confidence", "Accept a worker and the slot is locked in. No double-bookings, no overbooking."],
];
const WORKER_STEPS = [
  ["Set up your profile", "Your area, the work you do and your skills. No ID numbers, ever."],
  ["Find work nearby", "Search by type, locality and date, or just ask: “event helper jobs near Alkapuri tomorrow”."],
  ["Get booked", "You're told the moment an employer confirms. Your confirmed jobs can never overlap."],
];

function Steps({ title, steps }: { title: string; steps: string[][] }) {
  return (
    <div className="rounded-xl border border-line bg-paper p-5 sm:p-6">
      <h3 className="text-xl">{title}</h3>
      <ol className="mt-4 flex flex-col gap-4">
        {steps.map(([head, body], i) => (
          <li key={head} className="flex gap-3">
            <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-marigold font-bold text-ink">{i + 1}</span>
            <div>
              <p className="font-semibold">{head}</p>
              <p className="text-ink-soft">{body}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function SampleListing() {
  // A sample, clearly labelled as such, built from the same pieces as a real listing card.
  return (
    <figure aria-label="Sample job listing" className="w-full">
      <div className="overflow-hidden rounded-xl border border-line bg-paper text-ink shadow-xl">
        <div className="flex items-center justify-between gap-2 border-b border-line bg-cream px-4 py-2">
          <p className="text-xs font-bold uppercase tracking-wide text-terracotta-darker">Illustration · not a real listing</p>
          <Badge tone="warning">Open</Badge>
        </div>
        <div className="p-4">
          <p className="text-sm font-semibold text-terracotta-darker">Event help · Alkapuri</p>
          <h2 className="mt-0.5 text-xl">Wedding helpers, Alkapuri</h2>
          <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-3 text-sm">
            <div><dt className="text-ink-soft">Pay</dt><dd className="text-lg font-bold">₹800 <span className="text-sm font-semibold text-ink-soft">per worker</span></dd></div>
            <div><dt className="text-ink-soft">Workers</dt><dd className="font-semibold">3 of 8 booked</dd></div>
            <div className="col-span-2"><dt className="text-ink-soft">When</dt><dd className="font-semibold">Saturday · 5:00 PM – 12:00 AM IST</dd></div>
          </dl>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-line" aria-hidden="true">
            <div className="h-full w-[37%] rounded-full bg-terracotta-dark" />
          </div>
          <p className="mt-1 text-xs text-ink-soft">5 places still open</p>
        </div>
      </div>
    </figure>
  );
}

function Hero() {
  const [failed, setFailed] = useState(false);
  return (
    <div className="relative">
      <div className="relative overflow-hidden rounded-2xl bg-ink shadow-md">
        {failed ? (
          <div aria-hidden="true" className="h-64 w-full bg-gradient-to-br from-terracotta via-marigold to-ink sm:h-[26rem]" />
        ) : (
          <img src="/images/hero.jpg" alt={HERO_ALT} width={1200} height={800} decoding="async" fetchPriority="high" onError={() => setFailed(true)} className="h-64 w-full object-cover sm:h-[26rem]" />
        )}
        <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-ink/60 via-transparent to-transparent" />
        <p className="absolute left-3 top-3 rounded bg-ink/80 px-2 py-1 text-xs text-white">
          Photo: porters at a Delhi railway station · <Link to="/credits" className="underline">credit</Link>
        </p>
      </div>
      <div className="relative z-10 mx-3 -mt-14 sm:absolute sm:-bottom-6 sm:-left-6 sm:mx-0 sm:mt-0 sm:w-80">
        <SampleListing />
      </div>
    </div>
  );
}

function TrustStrip() {
  const items = [
    ["No ID numbers", "We never ask for Aadhaar."],
    ["You choose who to hire", "Compare applicants openly."],
    ["No double-bookings", "Enforced by the database."],
    ["Speak or type", "In your own words."],
  ];
  return (
    <section aria-label="Why KaamSetu" className="border-y border-line bg-paper">
      <ul className="mx-auto grid max-w-6xl grid-cols-2 gap-4 px-4 py-5 lg:grid-cols-4">
        {items.map(([h, b]) => (
          <li key={h} className="flex items-start gap-2">
            <span aria-hidden="true" className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-success-bg text-sm font-bold text-success">✓</span>
            <span>
              <span className="block text-sm font-bold sm:text-base">{h}</span>
              <span className="block text-sm text-ink-soft">{b}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Landing() {
  const { status, me } = useAuth();
  const signedIn = status === "signedIn" && me;

  return (
    <>
      <section className="bg-cream">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-12 pt-8 sm:pb-16 sm:pt-12 lg:grid-cols-[1fr_1.1fr] lg:gap-14">
          <div>
            <p className="mb-4 inline-block rounded-full border border-terracotta bg-paper px-3 py-1 text-sm font-bold text-terracotta-darker">Now in Vadodara, Gujarat</p>
            <h1 className="text-4xl font-extrabold leading-tight tracking-tight sm:text-5xl lg:text-6xl">
              Short-term work, <span className="text-terracotta-dark">close to home.</span>
            </h1>
            <p className="mt-5 max-w-xl text-lg text-ink-soft sm:text-xl">
              {APP_TAGLINE} Weddings, godowns, shops, shifting and cleaning: KaamSetu connects people who need a few hands for a day with nearby workers
              who are ready to start.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              {signedIn ? (
                <ButtonLink to={homeFor(me.profile.role)} className="sm:min-w-52 sm:text-lg">Open your dashboard</ButtonLink>
              ) : (
                <>
                  <ButtonLink to="/signup?role=employer" className="min-h-12 sm:min-w-52 sm:text-lg">I need workers</ButtonLink>
                  <ButtonLink to="/signup?role=worker" variant="secondary" className="min-h-12 sm:min-w-52 sm:text-lg">I'm looking for work</ButtonLink>
                </>
              )}
            </div>
            {!signedIn && (
              <p className="mt-4 text-ink-soft">
                Already have an account? <Link to="/login" className="font-semibold text-ink underline">Log in</Link>
              </p>
            )}
          </div>
          <Hero />
        </div>
      </section>

      <TrustStrip />

      <section className="mx-auto max-w-6xl px-4 py-12" aria-labelledby="kinds-h">
        <h2 id="kinds-h" className="text-2xl sm:text-3xl">The kind of work you'll find</h2>
        <p className="mt-1 text-ink-soft">Short, hands-on jobs across Vadodara, from a few hours to a few days.</p>
        <ul className="mt-6 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          {KINDS_OF_WORK.map((k) => (
            <li key={k.slug} className="overflow-hidden rounded-xl border border-line bg-paper shadow-sm transition-shadow hover:shadow-md">
              <CategoryImage slug={k.slug} name={k.name} className="h-28 w-full sm:h-36" />
              <div className="p-3 sm:p-4">
                <h3 className="text-base sm:text-lg">{k.name}</h3>
                <p className="mt-1 hidden text-sm text-ink-soft sm:block">{k.blurb}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="bg-paper">
        <div className="mx-auto max-w-6xl px-4 py-10">
          <h2 className="text-2xl sm:text-3xl">How KaamSetu works</h2>
          <div className="mt-6 grid gap-5 md:grid-cols-2">
            <Steps title="For employers and organisers" steps={EMPLOYER_STEPS} />
            <Steps title="For workers" steps={WORKER_STEPS} />
          </div>
        </div>
      </section>

      <section className="bg-ink text-white">
        <div className="on-dark mx-auto grid max-w-6xl gap-6 px-4 py-10 md:grid-cols-3">
          {[
            ["Fair to new workers", "We show what a worker has told us: type of work, area, experience. Anything left blank is never counted against them, and nobody is ranked by reviews that don't exist yet."],
            ["Your privacy first", "No Aadhaar, no ID numbers, no home addresses. A phone number is optional and shared only with someone who has booked you."],
            ["Bookings that hold", "A worker can't be booked for two overlapping jobs, and a job can't be overbooked, because the database itself enforces it."],
          ].map(([h, b]) => (
            <div key={h}>
              <h3 className="text-xl text-marigold">{h}</h3>
              <p className="mt-2 text-white/90">{b}</p>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
