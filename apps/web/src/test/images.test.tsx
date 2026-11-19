import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FILE_BY_SLUG } from "../components/CategoryImage";
import { fakeSupabase } from "./fakeSupabase";
import { baseRoutes, installFetch, renderApp } from "./helpers";

vi.mock("../lib/supabase", async () => {
  const m = await import("./fakeSupabase");
  return { getSupabase: () => Promise.resolve(m.fakeSupabase.client) };
});

const imagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public/images");
const credits = JSON.parse(fs.readFileSync(path.join(imagesDir, "credits.json"), "utf8")) as {
  file: string; title: string; author: string; source_url: string; license: string; license_url: string;
}[];

beforeEach(() => fakeSupabase.reset());
afterEach(() => vi.unstubAllGlobals());

describe("photo assets", () => {
  it("every photo the app references exists on disk (no broken images)", () => {
    for (const file of [...Object.values(FILE_BY_SLUG), "hero.jpg"]) {
      expect(fs.existsSync(path.join(imagesDir, file)), `${file} is referenced but missing`).toBe(true);
    }
  });

  it("every photo file is credited, and every credit has a file", () => {
    const files = fs.readdirSync(imagesDir).filter((f) => f.endsWith(".jpg"));
    expect(files.sort()).toEqual(credits.map((c) => c.file).sort());
  });

  it("only licences that allow reuse are present, each with an author and a source", () => {
    const allowed = /^(CC0|CC BY|CC BY-SA|Public domain)/i;
    for (const c of credits) {
      expect(c.license, c.file).toMatch(allowed);
      expect(c.license, c.file).not.toMatch(/\bNC\b|\bND\b/);
      expect(c.author.trim().length, c.file).toBeGreaterThan(1);
      expect(c.source_url, c.file).toMatch(/^https:\/\/commons\.wikimedia\.org\//);
      expect(c.license_url, c.file).toMatch(/^https:\/\//);
    }
  });

  it("keeps each photo light enough for mobile data", () => {
    for (const c of credits) {
      const kb = fs.statSync(path.join(imagesDir, c.file)).size / 1024;
      expect(kb, `${c.file} is ${Math.round(kb)} KB`).toBeLessThan(400);
    }
  });

  it("has valid JPEG files (not an HTML error page saved as .jpg)", () => {
    for (const c of credits) {
      const head = fs.readFileSync(path.join(imagesDir, c.file)).subarray(0, 3);
      expect([...head], c.file).toEqual([0xff, 0xd8, 0xff]);
    }
  });
});

describe("photo credits page", () => {
  it("is public, lists every photo with author, licence link and source link", async () => {
    installFetch({ ...baseRoutes("worker"), "GET /images/credits.json": { json: credits } });
    renderApp("/credits");
    expect(await screen.findByRole("heading", { level: 1, name: "Photo credits" })).toBeInTheDocument();
    const list = await within(screen.getByRole("main")).findByRole("list"); // the footer has its own link list
    expect(within(list).getAllByRole("listitem")).toHaveLength(credits.length);
    const first = credits[0]!;
    expect(within(list).getByText(first.title)).toBeInTheDocument();
    expect(within(list).getAllByRole("link", { name: first.license })[0]).toHaveAttribute("href", first.license_url);
    expect(within(list).getAllByRole("link", { name: "Original on Wikimedia Commons" })[0]).toHaveAttribute("href", first.source_url);
    expect(screen.getByText(/not\s+KaamSetu workers or customers/)).toBeInTheDocument();
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

  it("the landing hero says what the photo really shows and credits it", async () => {
    installFetch({ ...baseRoutes("worker") });
    renderApp("/");
    const hero = (await screen.findByAltText(/Porters in red shirts/)) as HTMLImageElement;
    expect(hero.getAttribute("src")).toBe("/images/hero.jpg");
    expect(screen.getByText(/Photo: porters at a Delhi railway station/)).toBeInTheDocument();
  });
});
