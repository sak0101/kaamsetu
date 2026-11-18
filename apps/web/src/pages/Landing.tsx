import { useState } from "react";
import { APP_TAGLINE } from "@kaamsetu/shared";
import { Link } from "react-router-dom";
import { CategoryImage } from "../components/CategoryImage";
import { homeFor } from "../components/Layout";
import { ButtonLink } from "../components/ui";
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

function Hero() {
  const [failed, setFailed] = useState(false);
  return (
    <div className="relative overflow-hidden rounded-2xl bg-ink shadow-md">
      {failed ? (
        <div aria-hidden="true" className="h-72 w-full bg-gradient-to-br from-terracotta via-marigold to-ink sm:h-96" />
      ) : (
        <img src="/images/hero.jpg" alt={HERO_ALT} width={1200} height={800} decoding="async" fetchPriority="high" onError={() => setFailed(true)} className="h-72 w-full object-cover sm:h-96" />
      )}
      <p className="absolute left-3 top-3 rounded bg-ink/80 px-2 py-1 text-xs text-white">
        Photo: porters at a Delhi railway station · <Link to="/credits" className="underline">credit</Link>
      </p>
      {/* Illustration only: clearly not a real listing. */}
      <figure aria-label="Illustration of a job card" className="absolute inset-x-3 bottom-3 sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-80">
        <div className="rounded-xl border-2 border-dashed border-terracotta bg-paper/95 p-4 shadow-lg backdrop-blur">
          <p className="mb-1 text-xs font-bold uppercase tracking-wide text-terracotta-darker">Illustration · not a real listing</p>
          <h2 className="text-lg">Wedding helpers, Alkapuri</h2>
          <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
            <div><dt className="text-ink-soft">Pay</dt><dd className="font-semibold">₹800 per worker</dd></div>
            <div><dt className="text-ink-soft">Workers</dt><dd className="font-semibold">8 needed</dd></div>
            <div className="col-span-2"><dt className="text-ink-soft">When</dt><dd className="font-semibold">5:00 PM – 12:00 AM IST</dd></div>
          </dl>
        </div>
      </figure>
    </div>
  );
}

export function Landing() {
  const { status, me } = useAuth();
  const signedIn = status === "signedIn" && me;

  return (
    <>
      <section className="bg-cream">
        <div className="mx-auto grid max-w-6xl items-center gap-8 px-4 py-8 sm:py-14 lg:grid-cols-[1fr_1.1fr]">
          <div>
            <p className="mb-3 inline-block rounded-full bg-marigold px-3 py-1 text-sm font-bold text-ink">Now in Vadodara, Gujarat</p>
            <h1 className="text-4xl sm:text-5xl">
              Short-term work, <span className="text-terracotta-dark">close to home.</span>
            </h1>
            <p className="mt-4 max-w-xl text-lg text-ink-soft">
              {APP_TAGLINE} Weddings, godowns, shops, shifting and cleaning: KaamSetu connects people who need a few hands for a day with nearby workers
              who are ready to start.
            </p>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row">
              {signedIn ? (
                <ButtonLink to={homeFor(me.profile.role)}>Open your dashboard</ButtonLink>
              ) : (
                <>
                  <ButtonLink to="/signup?role=employer">I need workers</ButtonLink>
                  <ButtonLink to="/signup?role=worker" variant="secondary">I'm looking for work</ButtonLink>
                </>
              )}
            </div>
            {!signedIn && (
              <p className="mt-4 text-ink-soft">
                Already have an account? <Link to="/login" className="font-semibold text-ink underline">Log in</Link>
              </p>
            )}
            <ul className="mt-6 flex flex-wrap gap-x-5 gap-y-1 text-sm font-semibold text-ink-soft">
              <li>✓ No Aadhaar or ID numbers</li>
              <li>✓ You choose who to hire</li>
              <li>✓ No double-bookings</li>
            </ul>
          </div>
          <Hero />
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-10" aria-labelledby="kinds-h">
        <h2 id="kinds-h" className="text-2xl sm:text-3xl">The kind of work you'll find</h2>
        <p className="mt-1 text-ink-soft">Short, hands-on jobs across Vadodara, from a few hours to a few days.</p>
        <ul className="mt-6 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          {KINDS_OF_WORK.map((k) => (
            <li key={k.slug} className="overflow-hidden rounded-xl border border-line bg-paper shadow-sm">
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
