import { describe, expect, it } from "vitest";
import { FIT_WEIGHTS, computeFit, rankApplicants, type ApplicantRow } from "./fit";

const base: ApplicantRow = {
  application_id: "a1",
  worker_id: "w1",
  worker_name: "Ravi Patel",
  application_status: "pending",
  applied_at: "2026-11-20T10:00:00Z",
  message: null,
  category_match: true,
  locality_match: "same_locality",
  years_experience: 5,
  has_booking_conflict: false,
  bio: null,
  skills: [],
  availability_note: null,
  member_since: "2026-11-01T00:00:00Z",
  completed_jobs: 0,
  no_show_count: 0,
  review_count: 0,
  avg_rating: null,
};
const worker = (over: Partial<ApplicantRow>): ApplicantRow => ({ ...base, ...over });

describe("computeFit", () => {
  it("scores a worker who matches on everything at 100%", () => {
    const f = computeFit(base);
    expect(f.percent).toBe(100);
    expect(f.label).toBe("Strong match");
    expect(f.signals_used).toEqual(["category", "locality", "experience"]);
    expect(f.reasons).toEqual(expect.arrayContaining(["Offers this type of work", "Works in this job's locality", "5 years of experience"]));
  });

  it("weights are category 0.30, locality 0.20, experience 0.10", () => {
    expect(FIT_WEIGHTS).toEqual({ category: 0.3, locality: 0.2, experience: 0.1 });
    // category + locality only (experience 0 years): (0.3 + 0.2 + 0) / 0.6 = 83%
    expect(computeFit(worker({ years_experience: 0 })).percent).toBe(83);
    // category only matches: 0.3 / 0.6 = 50%
    expect(computeFit(worker({ locality_match: "different_locality", years_experience: 0 })).percent).toBe(50);
  });

  it("FAIRNESS: missing locality and experience are excluded and weights renormalised, never counted as zero", () => {
    const veteran = computeFit(worker({ locality_match: "same_locality", years_experience: 5 }));
    const newcomer = computeFit(worker({ locality_match: "unknown", years_experience: null }));
    // a newcomer who matches on the only known signal is a perfect fit on what is known
    expect(newcomer.percent).toBe(100);
    expect(newcomer.percent).toBeGreaterThanOrEqual(veteran.percent);
    expect(newcomer.signals_used).toEqual(["category"]);
    expect(newcomer.signals_excluded).toEqual(expect.arrayContaining(["locality", "experience"]));
    expect(newcomer.notes.join(" ")).toMatch(/isn't counted for or against them/);
  });

  it("FAIRNESS: unknown experience is not the same as zero experience", () => {
    const unknown = computeFit(worker({ years_experience: null }));
    const zero = computeFit(worker({ years_experience: 0 }));
    expect(unknown.percent).toBeGreaterThan(zero.percent);
    expect(unknown.notes.join(" ")).toContain("Experience not provided");
    expect(zero.notes.join(" ")).toContain("Lists no prior experience");
  });

  it("FAIRNESS: having no review history costs nothing, and reviews/reliability are never used", () => {
    const newWorker = computeFit(worker({ completed_jobs: 0 }));
    const experienced = computeFit(worker({ completed_jobs: 12 }));
    expect(newWorker.percent).toBe(experienced.percent);
    expect(newWorker.signals_excluded).toEqual(expect.arrayContaining(["reviews", "reliability"]));
    expect(newWorker.signals_used).not.toContain("reviews");
    expect(newWorker.notes.join(" ")).toMatch(/New to KaamSetu.*isn't held against them/);
    expect(experienced.reasons).toContain("Completed 12 jobs through KaamSetu");
  });

  it("shows genuine reviews and no-shows as facts, but they never change the percentage", () => {
    const none = computeFit(worker({}));
    const reviewed = computeFit(worker({ completed_jobs: 3, review_count: 3, avg_rating: 4.67 }));
    const noShow = computeFit(worker({ no_show_count: 2 }));
    expect(reviewed.percent).toBe(none.percent);
    expect(noShow.percent).toBe(none.percent);
    expect(reviewed.reasons).toContain("Rated 4.7 out of 5 from 3 reviews");
    expect(noShow.notes).toContain("Recorded as a no-show 2 times by employers");
    expect(none.reasons.join(" ")).not.toMatch(/Rated/);
    expect(none.notes.join(" ")).not.toMatch(/no-show/);
  });

  it("only reports completed-job history that exists (singular/plural, nothing invented)", () => {
    expect(computeFit(worker({ completed_jobs: 1 })).reasons).toContain("Completed 1 job through KaamSetu");
    expect(computeFit(worker({ completed_jobs: 0 })).reasons.join(" ")).not.toMatch(/Completed/);
    expect(JSON.stringify(computeFit(worker({}))).toLowerCase()).not.toMatch(/review score|rating|stars|verified/);
  });

  it("reports an overlapping booking as a flag without changing the percentage", () => {
    const free = computeFit(base);
    const busy = computeFit(worker({ has_booking_conflict: true }));
    expect(busy.percent).toBe(free.percent);
    expect(busy.has_conflict).toBe(true);
    expect(busy.notes.join(" ")).toMatch(/overlapping time/);
  });

  it("explains skills and availability in the reasons when given", () => {
    const f = computeFit(worker({ skills: ["Guest handling", "Stage setup"], availability_note: "Evenings and weekends" }));
    expect(f.reasons).toEqual(expect.arrayContaining(["Skills: Guest handling, Stage setup", "Availability: Evenings and weekends"]));
  });

  it("labels by percent", () => {
    expect(computeFit(base).label).toBe("Strong match"); // 100
    expect(computeFit(worker({ years_experience: 0 })).label).toBe("Strong match"); // 83
    expect(computeFit(worker({ locality_match: "different_locality" })).label).toBe("Good match"); // (0.3 + 0 + 0.1) / 0.6 = 67
    expect(computeFit(worker({ locality_match: "different_locality", years_experience: 0 })).label).toBe("Partial match"); // 50
    expect(computeFit(worker({ category_match: false, locality_match: "different_locality", years_experience: 0 })).label).toBe("Weak match"); // 0
  });
});

describe("rankApplicants", () => {
  it("puts the best fit first, ties by who applied first, and anyone with an overlap last", () => {
    const rows = [
      worker({ application_id: "late-strong", applied_at: "2026-11-20T12:00:00Z" }),
      worker({ application_id: "weak", category_match: false, locality_match: "different_locality", years_experience: 0, applied_at: "2026-11-20T08:00:00Z" }),
      worker({ application_id: "busy-strong", has_booking_conflict: true, applied_at: "2026-11-20T07:00:00Z" }),
      worker({ application_id: "early-strong", applied_at: "2026-11-20T09:00:00Z" }),
    ];
    expect(rankApplicants(rows).map((r) => r.application_id)).toEqual(["early-strong", "late-strong", "weak", "busy-strong"]);
  });

  it("does not let a newcomer sink below an equally matching veteran", () => {
    const ranked = rankApplicants([
      worker({ application_id: "veteran", completed_jobs: 20, applied_at: "2026-11-20T09:00:00Z" }),
      worker({ application_id: "newcomer", completed_jobs: 0, applied_at: "2026-11-20T08:00:00Z" }),
    ]);
    expect(ranked.map((r) => r.application_id)).toEqual(["newcomer", "veteran"]); // same fit, applied first
  });

  it("keeps every input field and attaches fit", () => {
    const [r] = rankApplicants([base]);
    expect(r).toMatchObject({ application_id: "a1", worker_name: "Ravi Patel", fit: { percent: 100 } });
  });
});
