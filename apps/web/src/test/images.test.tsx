import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CategoryImage } from "../components/CategoryImage";
import { EVENT_FILES, FILE_BY_SLUG, classifyEvent, imageFileFor } from "../lib/jobImage";
import { fakeSupabase } from "./fakeSupabase";
import { baseRoutes, installFetch, renderApp } from "./helpers";

vi.mock("../lib/supabase", async () => {
  const m = await import("./fakeSupabase");
  return { getSupabase: () => Promise.resolve(m.fakeSupabase.client) };
});

const imagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public/images");
type Credit = { file: string; title: string; author: string; source_url: string; license: string; license_url: string; notes?: string };
const credits = JSON.parse(fs.readFileSync(path.join(imagesDir, "credits.json"), "utf8")) as Credit[];

beforeEach(() => fakeSupabase.reset());
afterEach(() => vi.unstubAllGlobals());

describe("image assets", () => {
  it("every picture the app references exists on disk (no broken images)", () => {
    for (const file of [...Object.values(FILE_BY_SLUG), ...Object.values(EVENT_FILES), "hero.svg"]) {
      expect(fs.existsSync(path.join(imagesDir, file)), `${file} is referenced but missing`).toBe(true);
    }
  });

  it("covers all 8 types of work and all 5 kinds of event, each with its own picture", () => {
    expect(Object.keys(FILE_BY_SLUG).sort()).toEqual(
      ["cleaning", "construction_helper", "event_help", "furniture_shifting", "gardening", "loading_unloading", "packing", "painting_helper"],
    );
    expect(Object.keys(EVENT_FILES).sort()).toEqual(["catering", "corporate", "exhibition", "religious", "wedding"]);
    const all = [...Object.values(FILE_BY_SLUG), ...Object.values(EVENT_FILES)];
    expect(new Set(all).size).toBe(all.length); // no two things share a picture
  });

  it("is ONE consistent set: every picture is an original SVG with no embedded photo, script or external reference", () => {
    for (const file of fs.readdirSync(imagesDir).filter((f) => f !== "credits.json")) {
      expect(file, "only SVG illustrations (or credited photographs) belong here").toMatch(/\.(svg|jpg)$/);
      if (file.endsWith(".svg")) {
        const svg = fs.readFileSync(path.join(imagesDir, file), "utf8");
        expect(svg.startsWith("<svg"), file).toBe(true);
        expect(svg, file).not.toMatch(/<script|<image|href=|xlink|<foreignObject|onload/i);
        expect(fs.statSync(path.join(imagesDir, file)).size / 1024, file).toBeLessThan(20);
      }
    }
  });

  it("any photograph that is ever added must be credited under a reuse-friendly licence, and every credit needs its file", () => {
    const photos = fs.readdirSync(imagesDir).filter((f) => /\.(jpg|jpeg|png)$/i.test(f));
    expect(photos.sort()).toEqual(credits.map((c) => c.file).sort());
    const allowed = /^(Unsplash License|Pexels License|CC0|CC BY|CC BY-SA|Public domain)/i;
    for (const c of credits) {
      expect(c.license, c.file).toMatch(allowed);
      expect(c.license, c.file).not.toMatch(/\bNC\b|\bND\b/);
      expect(c.author.trim().length, c.file).toBeGreaterThan(1);
      expect(fs.statSync(path.join(imagesDir, c.file)).size / 1024, c.file).toBeLessThan(400);
    }
  });
});

describe("event kind from the job text (no AI call, no network)", () => {
  it.each([
    ["Wedding helpers needed, Alkapuri", "wedding"],
    ["Catering staff for a lunch buffet", "catering"],
    ["Stall setup at trade exhibition", "exhibition"],
    ["Puja and havan arrangements helpers", "religious"],
    ["Corporate conference setup crew", "corporate"],
    ["शादी के लिए सहायक चाहिए", "wedding"],
    ["લગ્ન માટે હેલ્પર", "wedding"],
    ["Shaadi mein waiter chahiye", "wedding"], // earliest keyword in the title wins
    ["भंडारे के लिए सेवक", null], // inflected form: not guessed
    ["सत्संग में सेवा", "religious"],
    ["ગરબા અને નવરાત્રી માટે સ્વયંસેવકો", "religious"],
    ["प्रदर्शनी में स्टॉल सहायक", "exhibition"],
    ["કોન્ફરન્સ માટે સ્ટાફ", "corporate"],
    ["Event helpers", null],
    ["Weekend help", null],
  ] as const)("%s -> %s", (title, kind) => {
    expect(classifyEvent(title)).toBe(kind);
  });

  it("the title decides first; the description is only a fallback", () => {
    expect(classifyEvent("Event helpers", "A wedding reception at a banquet hall")).toBe("wedding");
    expect(classifyEvent("Catering team", "for a wedding")).toBe("catering");
    expect(classifyEvent("Helpers", "Setting up stalls for an exhibition")).toBe("exhibition");
  });

  it("does not match a keyword inside a longer word", () => {
    expect(classifyEvent("Officer training")).toBeNull(); // contains 'office'-like letters but is a different word
    expect(classifyEvent("Fairness audit")).toBeNull(); // 'fair' inside 'fairness'
    expect(classifyEvent("Cookware packing")).toBeNull(); // 'cook' inside 'cookware'
  });

  it("only Event help jobs are told apart; every other type of work keeps its own picture", () => {
    expect(imageFileFor("event_help", "Wedding helpers", "")).toBe(EVENT_FILES.wedding);
    expect(imageFileFor("event_help", "Catering team")).toBe(EVENT_FILES.catering);
    expect(imageFileFor("event_help", "Event helpers", "")).toBe(FILE_BY_SLUG.event_help); // uncertain: the general event picture
    expect(imageFileFor("event_help")).toBe(FILE_BY_SLUG.event_help);
    expect(imageFileFor("cleaning", "Clean the hall after a wedding", "wedding")).toBe(FILE_BY_SLUG.cleaning);
    expect(imageFileFor("packing", "Pack wedding gifts")).toBe(FILE_BY_SLUG.packing);
    expect(imageFileFor("unknown_type", "Wedding")).toBeUndefined();
    expect(imageFileFor(undefined, "Wedding")).toBeUndefined();
  });

  it("makes no network request when choosing a picture", () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    classifyEvent("Wedding helpers");
    imageFileFor("event_help", "Puja helpers", "");
    expect(f).not.toHaveBeenCalled();
  });
});

describe("CategoryImage", () => {
  it("shows the wedding picture for a wedding job and a different one for a catering job", () => {
    const { container, rerender } = render(<CategoryImage slug="event_help" name="Event help" title="Wedding helpers" description="" />);
    expect(container.querySelector("img")!.getAttribute("src")).toBe("/images/event-wedding.svg");
    rerender(<CategoryImage slug="event_help" name="Event help" title="Catering crew" description="" />);
    expect(container.querySelector("img")!.getAttribute("src")).toBe("/images/event-catering.svg");
  });

  it("is decorative (empty alt) and lazy", () => {
    const { container } = render(<CategoryImage slug="loading_unloading" name="Loading" />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("src")).toBe("/images/cat-loading.jpg");
  });

  it("falls back to a coloured tile with the initial when a picture fails to load", () => {
    const { container } = render(<CategoryImage slug="gardening" name="Gardening" />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("G");
  });

  it("falls back to a tile for an unknown type of work, never a broken image", () => {
    const { container } = render(<CategoryImage slug="brand_new_type" name="Roofing" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("R");
  });

  it("a failed picture does not poison a different one", () => {
    const { container, rerender } = render(<CategoryImage slug="event_help" name="Event help" title="Wedding helpers" />);
    fireEvent.error(container.querySelector("img")!); // the wedding picture is missing
    expect(container.querySelector("img")).toBeNull();
    rerender(<CategoryImage slug="event_help" name="Event help" title="Catering crew" />);
    expect(container.querySelector("img")!.getAttribute("src")).toBe("/images/event-catering.svg");
  });
});

describe("image credits page", () => {
  it("is public, and says the pictures are original illustrations when there are no third-party photographs", async () => {
    installFetch({ ...baseRoutes("worker"), "GET /images/credits.json": { json: [] } });
    renderApp("/credits");
    expect(await screen.findByRole("heading", { level: 1, name: "Image credits" })).toBeInTheDocument();
    expect(screen.getByText(/original illustrations made for KaamSetu/)).toBeInTheDocument();
    expect(await screen.findByText("No third-party photographs are used.")).toBeInTheDocument();
  });

  it("still lists every photograph with author, licence link and source link, if one is ever added", async () => {
    const photo: Credit = {
      file: "example.jpg", title: "Example photograph", author: "A. Photographer", source_url: "https://commons.wikimedia.org/wiki/File:Example.jpg",
      license: "CC BY-SA 4.0", license_url: "https://creativecommons.org/licenses/by-sa/4.0/", notes: "Resized.",
    };
    installFetch({ ...baseRoutes("worker"), "GET /images/credits.json": { json: [photo] } });
    renderApp("/credits");
    const list = await within(await screen.findByRole("main")).findByRole("list"); // the footer has its own link list
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByText("Example photograph")).toBeInTheDocument();
    expect(within(list).getByRole("link", { name: "CC BY-SA 4.0" })).toHaveAttribute("href", photo.license_url);
    expect(within(list).getByRole("link", { name: "Original on Wikimedia Commons" })).toHaveAttribute("href", photo.source_url);
  });

  it("shows an error with a retry if the credits can't be loaded", async () => {
    installFetch({ ...baseRoutes("worker"), "GET /images/credits.json": { status: 500, json: {} } });
    renderApp("/credits");
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be loaded/);
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("is linked from the footer of the landing page", async () => {
    installFetch({ ...baseRoutes("worker") });
    renderApp("/");
    const links = await screen.findAllByRole("link", { name: /credit/i });
    expect(links.some((l) => l.getAttribute("href") === "/credits")).toBe(true);
  });
});

describe("landing hero", () => {
  it("is a neutral illustration, with honest alt text, and no longer a photograph of a specific place", async () => {
    installFetch({ ...baseRoutes("worker") });
    renderApp("/");
    const hero = (await screen.findByAltText(/Illustration of a delivery truck/)) as HTMLImageElement;
    expect(hero.getAttribute("src")).toBe("/images/hero.svg");
    expect(document.body.textContent).not.toMatch(/Delhi|railway|porters/i);
  });

  it("falls back to a gradient if the hero picture fails to load", async () => {
    installFetch({ ...baseRoutes("worker") });
    renderApp("/");
    fireEvent.error(await screen.findByAltText(/Illustration of a delivery truck/));
    expect(screen.queryByAltText(/Illustration of a delivery truck/)).not.toBeInTheDocument();
  });
});
