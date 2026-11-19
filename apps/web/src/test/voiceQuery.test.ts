import { describe, expect, it } from "vitest";
import { interpretJobQuery, type QueryContext } from "../lib/voiceQuery";

// Thursday 19 Nov 2026, 10:00 AM IST
const ctx: QueryContext = {
  now: new Date("2026-11-19T04:30:00Z"),
  categories: [
    { id: 1, slug: "loading_unloading", name_en: "Loading & unloading" },
    { id: 2, slug: "furniture_shifting", name_en: "Furniture shifting" },
    { id: 3, slug: "cleaning", name_en: "Cleaning" },
    { id: 4, slug: "event_help", name_en: "Event help" },
    { id: 5, slug: "construction_helper", name_en: "Construction helper" },
    { id: 6, slug: "painting_helper", name_en: "Painting helper" },
    { id: 7, slug: "gardening", name_en: "Gardening" },
    { id: 8, slug: "packing", name_en: "Packing" },
  ],
  localities: [
    { id: 1, name: "Alkapuri" },
    { id: 2, name: "Gotri" },
    { id: 3, name: "Waghodia Road" },
    { id: 4, name: "Race Course" },
    { id: 5, name: "Akota" },
  ],
};

describe("interpretJobQuery", () => {
  it("handles the example: 'Show me event helper jobs near Alkapuri tomorrow'", () => {
    const q = interpretJobQuery("Show me event helper jobs near Alkapuri tomorrow", ctx);
    expect(q).toMatchObject({ categoryId: 4, localityId: 1, date: "2026-11-20", keywords: "", recognised: true });
    expect(q.summary).toMatch(/^Event help jobs in Alkapuri tomorrow \(.*20 Nov.*\)$/);
  });

  it.each([
    ["wedding work in Gotri", { categoryId: 4, localityId: 2, date: null }],
    ["I need loading jobs at Akota today", { categoryId: 1, localityId: 5, date: "2026-11-19" }],
    ["cleaning near Race Course the day after tomorrow", { categoryId: 3, localityId: 4, date: "2026-11-21" }],
    ["painters on Saturday", { categoryId: 6, localityId: null, date: "2026-11-21" }],
    ["gardening work this weekend", { categoryId: 7, localityId: null, date: "2026-11-21" }],
    ["packing jobs next thursday", { categoryId: 8, localityId: null, date: "2026-11-26" }],
    ["furniture shifting on thursday", { categoryId: 2, localityId: null, date: "2026-11-19" }],
    ["mason or construction labour in Waghodia Road", { categoryId: 5, localityId: 3, date: null }],
  ])("%s", (text, expected) => {
    expect(interpretJobQuery(text, ctx)).toMatchObject(expected);
  });

  it("is case-insensitive and ignores punctuation", () => {
    expect(interpretJobQuery("EVENT jobs!!! near ALKAPURI, tomorrow?", ctx)).toMatchObject({ categoryId: 4, localityId: 1, date: "2026-11-20" });
  });

  it("matches the longest locality name", () => {
    expect(interpretJobQuery("jobs near waghodia road", ctx).localityId).toBe(3);
  });

  it("keeps unrecognised words as search keywords", () => {
    const q = interpretJobQuery("find security guard jobs near Gotri", ctx);
    expect(q.localityId).toBe(2);
    expect(q.categoryId).toBeNull();
    expect(q.keywords).toBe("security guard");
    expect(q.summary).toContain("matching “security guard”");
  });

  it("picks the earliest category when several are mentioned", () => {
    expect(interpretJobQuery("cleaning and loading work", ctx).categoryId).toBe(3);
    expect(interpretJobQuery("loading and cleaning work", ctx).categoryId).toBe(1);
  });

  it("says so when nothing could be understood", () => {
    const q = interpretJobQuery("um please show me the jobs", ctx);
    expect(q.recognised).toBe(false);
    expect(q.summary).toMatch(/couldn't pick out/);
    expect(q).toMatchObject({ categoryId: null, localityId: null, date: null, keywords: "" });
  });

  it("returns nothing for empty input and never throws on odd text", () => {
    expect(interpretJobQuery("", ctx).recognised).toBe(false);
    expect(() => interpretJobQuery("((( )))  \\ ^ $ . * + ?", ctx)).not.toThrow();
    expect(() => interpretJobQuery("x".repeat(5000), ctx)).not.toThrow();
  });

  it("works from IST, not UTC: late evening UTC is already tomorrow in India", () => {
    const late = { ...ctx, now: new Date("2026-11-19T20:00:00Z") }; // 01:30 IST on the 20th
    expect(interpretJobQuery("jobs today", late).date).toBe("2026-11-20");
    expect(interpretJobQuery("jobs tomorrow", late).date).toBe("2026-11-21");
  });

  it("only uses categories that exist in the reference data", () => {
    const small = { ...ctx, categories: ctx.categories.filter((c) => c.slug !== "event_help") };
    expect(interpretJobQuery("wedding jobs", small).categoryId).toBeNull();
  });
});

// Hindi, Gujarati and Hinglish. The word lists are first-pass and need native-speaker review (see docs/ai-and-voice.md).
describe("interpretJobQuery: Hindi, Gujarati and Hinglish", () => {
  const read = (text: string) => interpretJobQuery(text, ctx);

  it("understands a Hindi request: wedding work in Alkapuri tomorrow", () => {
    expect(read("मुझे कल अलकापुरी में शादी का काम चाहिए")).toMatchObject({ categoryId: 4, localityId: 1, date: "2026-11-20", keywords: "", recognised: true });
  });

  it("understands a Gujarati request: cleaning work in Gotri tomorrow", () => {
    // Gujarati attaches postpositions to the word: "ગોત્રીમાં" (in Gotri), "સફાઈનું" (of cleaning)
    expect(read("મને કાલે ગોત્રીમાં સફાઈનું કામ જોઈએ")).toMatchObject({ categoryId: 3, localityId: 2, date: "2026-11-20", keywords: "", recognised: true });
    expect(read("મને કાલે ગોત્રી માં સફાઈ કામ જોઈએ")).toMatchObject({ categoryId: 3, localityId: 2, date: "2026-11-20", keywords: "" });
  });

  it("understands Hinglish (Hindi in Latin letters)", () => {
    expect(read("mujhe aaj Gotri mein safai ka kaam chahiye")).toMatchObject({ categoryId: 3, localityId: 2, date: "2026-11-19", keywords: "" });
    expect(read("kal Alkapuri shaadi ke liye waiter chahiye")).toMatchObject({ categoryId: 4, localityId: 1, date: "2026-11-20" });
    expect(read("parso Akota mein loading ka kaam")).toMatchObject({ categoryId: 1, localityId: 5, date: "2026-11-21" });
  });

  it("understands mixed-language requests", () => {
    expect(read("tomorrow अलकापुरी में wedding helper")).toMatchObject({ categoryId: 4, localityId: 1, date: "2026-11-20" });
    expect(read("Gotri માં cleaning kal")).toMatchObject({ categoryId: 3, localityId: 2, date: "2026-11-20" });
  });

  it("understands Hindi, Gujarati and Hinglish weekday names and 'next'", () => {
    expect(read("शनिवार को पेंटिंग का काम")).toMatchObject({ categoryId: 6, date: "2026-11-21" }); // Saturday
    expect(read("રવિવારે પેકિંગ")).toMatchObject({ categoryId: 8, date: "2026-11-22" }); // "on Sunday"
    expect(read("somvar ko packing")).toMatchObject({ categoryId: 8, date: "2026-11-23" }); // Monday
    expect(read("अगले गुरुवार माली")).toMatchObject({ categoryId: 7, date: "2026-11-26" }); // next Thursday: a week away, not today
  });

  it("keeps real search words and drops filler words in every language", () => {
    expect(read("mujhe kal Gotri mein sofa safai chahiye").keywords).toBe("sofa");
    expect(read("मुझे कल गोत्री में सोफा सफाई चाहिए").keywords).toBe("सोफा");
  });

  it("does not match a category word inside a longer word, or invent anything from unrelated text", () => {
    expect(read("मालवीय नगर")).toMatchObject({ categoryId: null }); // 'माल' inside 'मालवीय' is a different word
    const nothing = read("नमस्ते");
    expect(nothing.categoryId).toBeNull();
    expect(nothing.localityId).toBeNull();
    expect(nothing.date).toBeNull();
  });
});
