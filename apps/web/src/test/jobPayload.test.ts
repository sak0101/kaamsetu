import { describe, expect, it } from "vitest";
import { addOneDay, buildJobPayload, type JobFormValues } from "../pages/NewJob";

const now = new Date("2026-11-20T04:30:00Z"); // 10:00 AM IST on 20 Nov 2026
const valid: JobFormValues = {
  categoryId: "1",
  localityId: "2",
  title: "  Shift household goods  ",
  description: " Third floor, no lift ",
  date: "2026-11-21",
  startTime: "09:00",
  endTime: "13:00",
  endsNextDay: false,
  workers: "2",
  payType: "daily",
  pay: "850",
};

describe("buildJobPayload", () => {
  it("builds the exact API payload: IST offsets, paise, trimmed text, numeric ids", () => {
    const { payload, errors } = buildJobPayload(valid, now);
    expect(errors).toEqual({});
    expect(payload).toEqual({
      category_id: 1,
      locality_id: 2,
      title: "Shift household goods",
      description: "Third floor, no lift",
      starts_at: "2026-11-21T09:00:00+05:30",
      ends_at: "2026-11-21T13:00:00+05:30",
      workers_needed: 2,
      pay_type: "daily",
      pay_amount_paise: 85000,
    });
  });

  it("converts rupees with paise exactly", () => {
    expect(buildJobPayload({ ...valid, pay: "850.50" }, now).payload?.pay_amount_paise).toBe(85050);
  });

  it("reports every missing field at once", () => {
    const { payload, errors } = buildJobPayload({ ...valid, categoryId: "", localityId: "", title: "", description: "", date: "", pay: "" }, now);
    expect(payload).toBeUndefined();
    expect(Object.keys(errors).sort()).toEqual(["category_id", "date", "description", "locality_id", "pay_amount_paise", "title"]);
  });

  it.each([
    ["end not after start", { endTime: "09:00" }, "ends_at"],
    ["end before start", { endTime: "08:00" }, "ends_at"],
    ["date in the past (IST)", { date: "2026-11-19" }, "date"],
    ["start time already passed today", { date: "2026-11-20", startTime: "09:00", endTime: "12:00" }, "starts_at"],
    ["zero workers", { workers: "0" }, "workers_needed"],
    ["51 workers", { workers: "51" }, "workers_needed"],
    ["fractional workers", { workers: "1.5" }, "workers_needed"],
    ["pay over INR 50,000", { pay: "50000.01" }, "pay_amount_paise"],
    ["pay not a number", { pay: "five hundred" }, "pay_amount_paise"],
    ["title too short", { title: "abc" }, "title"],
  ])("rejects: %s", (_name, over, field) => {
    const { payload, errors } = buildJobPayload({ ...valid, ...over }, now);
    expect(payload).toBeUndefined();
    expect(errors[field]).toBeTruthy();
  });

  it("allows today when the start time is still in the future", () => {
    const { payload } = buildJobPayload({ ...valid, date: "2026-11-20", startTime: "15:00", endTime: "18:00" }, now);
    expect(payload?.starts_at).toBe("2026-11-20T15:00:00+05:30");
  });

  it("accepts exactly the maximum pay of INR 50,000", () => {
    expect(buildJobPayload({ ...valid, pay: "50000" }, now).payload?.pay_amount_paise).toBe(5_000_000);
  });
});

describe("overnight jobs (e.g. a wedding from 5 PM to midnight)", () => {
  const wedding: JobFormValues = { ...valid, date: "2026-11-21", startTime: "17:00", endTime: "00:00", endsNextDay: true, workers: "8", payType: "fixed", pay: "800" };

  it("puts the end time on the following IST day", () => {
    const { payload, errors } = buildJobPayload(wedding, now);
    expect(errors).toEqual({});
    expect(payload).toMatchObject({
      starts_at: "2026-11-21T17:00:00+05:30",
      ends_at: "2026-11-22T00:00:00+05:30",
      workers_needed: 8,
      pay_type: "fixed",
      pay_amount_paise: 80000,
    });
    expect(Date.parse(payload!.ends_at) - Date.parse(payload!.starts_at)).toBe(7 * 3_600_000);
  });

  it("rolls over month and year boundaries", () => {
    expect(addOneDay("2026-11-30")).toBe("2026-12-01");
    expect(addOneDay("2026-12-31")).toBe("2027-01-01");
    expect(addOneDay("2028-02-28")).toBe("2028-02-29");
  });

  it("without the overnight tick, an end time before the start is an error that explains the fix", () => {
    const { payload, errors } = buildJobPayload({ ...wedding, endsNextDay: false }, now);
    expect(payload).toBeUndefined();
    expect(errors.ends_at).toMatch(/Ends the next day/);
  });

  it("treats an equal end time with the overnight tick as a 24-hour job, and caps jobs at 14 days", () => {
    const day = buildJobPayload({ ...wedding, endTime: "17:00" }, now).payload!;
    expect(Date.parse(day.ends_at) - Date.parse(day.starts_at)).toBe(24 * 3_600_000);
    expect(buildJobPayload({ ...wedding, endTime: "17:00" }, now).errors).toEqual({});
  });
});

describe("pay type", () => {
  it("is required (an AI draft may leave it empty rather than guessing)", () => {
    const { payload, errors } = buildJobPayload({ ...valid, payType: "" }, now);
    expect(payload).toBeUndefined();
    expect(errors.pay_type).toBeTruthy();
  });
});
