import { describe, expect, it } from "vitest";
import { formatInr, formatPay, formatRange, relativeTime, rupeesToPaise, toIstIso, todayIst } from "../lib/format";
import { describeNotification, isApplyable, jobDisplay, reasonLabel } from "../lib/labels";
import { job } from "./helpers";

describe("money (INR, integer paise)", () => {
  it("formats whole and fractional rupees with Indian digit grouping", () => {
    expect(formatInr(85000)).toBe("₹850");
    expect(formatInr(85050)).toBe("₹850.50");
    expect(formatInr(12345600)).toBe("₹1,23,456");
    expect(formatPay(85000, "daily")).toBe("₹850 per day");
    expect(formatPay(12000, "hourly")).toBe("₹120 per hour");
    expect(formatPay(500000, "fixed")).toBe("₹5,000 fixed price");
  });

  it.each([
    ["850", 85000],
    ["850.5", 85050],
    ["850.50", 85050],
    ["0.5", 50],
    ["  120 ", 12000],
  ])("rupeesToPaise(%j) = %d", (input, paise) => expect(rupeesToPaise(input)).toBe(paise));

  it.each(["", "0", "0.00", "-5", "abc", "12.345", "1e3", "1,000", "₹500", "99999999"])("rejects %j", (input) => {
    expect(rupeesToPaise(input)).toBeNull();
  });
});

describe("time (IST)", () => {
  it("builds the +05:30 ISO string the API requires", () => {
    expect(toIstIso("2026-11-25", "09:00")).toBe("2026-11-25T09:00:00+05:30");
    expect(Date.parse(toIstIso("2026-11-25", "09:00"))).toBe(Date.parse("2026-11-25T03:30:00Z"));
  });

  it("shows a same-day range in IST regardless of the machine's timezone", () => {
    // ICU punctuation differs slightly between engines ("25 Nov 2099" vs "25 Nov, 2099"), so match the parts that matter.
    expect(formatRange("2099-11-25T03:30:00Z", "2099-11-25T07:30:00Z")).toMatch(/^Wed, 25 Nov,? 2099 · 9:00 AM – 1:00 PM IST$/);
  });

  it("shows both days when a job crosses midnight IST", () => {
    const text = formatRange("2099-11-25T16:30:00Z", "2099-11-25T20:30:00Z"); // 10:00 PM -> 2:00 AM IST
    expect(text).toContain("25 Nov");
    expect(text).toContain("26 Nov");
    expect(text.endsWith("IST")).toBe(true);
  });

  it("computes today's date in IST, not UTC", () => {
    // 20:00 UTC on 24 Nov is already 25 Nov in India.
    expect(todayIst(new Date("2026-11-24T20:00:00Z"))).toBe("2026-11-25");
    expect(todayIst(new Date("2026-11-24T10:00:00Z"))).toBe("2026-11-24");
  });

  it("formats relative times", () => {
    const now = new Date("2026-11-25T12:00:00Z");
    expect(relativeTime("2026-11-25T11:59:40Z", now)).toBe("just now");
    expect(relativeTime("2026-11-25T11:30:00Z", now)).toBe("30 min ago");
    expect(relativeTime("2026-11-25T09:00:00Z", now)).toBe("3 h ago");
  });
});

describe("labels", () => {
  it("derives a display status from time and bookings", () => {
    const now = new Date("2099-11-25T00:00:00Z");
    expect(jobDisplay(job(), now).label).toBe("Open");
    expect(jobDisplay(job({ status: "filled", positions_filled: 2 }), now).label).toBe("Fully booked");
    expect(jobDisplay(job({ status: "cancelled" }), now).label).toBe("Cancelled");
    const during = new Date("2099-11-25T05:00:00Z");
    expect(jobDisplay(job({ positions_filled: 1 }), during).label).toBe("In progress");
    expect(jobDisplay(job({ positions_filled: 0 }), during).label).toBe("Expired");
    expect(jobDisplay(job(), new Date("2099-11-26T00:00:00Z")).label).toBe("Ended");
  });

  it("only offers applying to open, future jobs", () => {
    const now = new Date("2099-11-24T00:00:00Z");
    expect(isApplyable(job(), now)).toBe(true);
    expect(isApplyable(job({ status: "filled" }), now)).toBe(false);
    expect(isApplyable(job({ status: "cancelled" }), now)).toBe(false);
    expect(isApplyable(job(), new Date("2099-11-25T05:00:00Z"))).toBe(false);
  });

  it("explains rejection reasons in plain language", () => {
    expect(reasonLabel("job_filled")).toBe("The job filled up.");
    expect(reasonLabel("job_cancelled")).toBe("The employer cancelled this job.");
    expect(reasonLabel("Not a fit")).toBe("Not a fit");
    expect(reasonLabel(null)).toBeNull();
  });

  it("describes notifications and links each to the right screen", () => {
    const base = { id: "1", entity_type: "x", entity_id: "e", read_at: null, created_at: "2026-11-25T00:00:00Z" };
    const jobId = "job-1";
    expect(describeNotification({ ...base, type: "new_application", payload: { job_id: jobId, job_title: "Sofa" } }, "employer")).toEqual({
      text: "New application for “Sofa”",
      to: "/employer/jobs/job-1",
    });
    expect(describeNotification({ ...base, type: "booking_confirmed", payload: { job_title: "Sofa" } }, "worker").to).toBe("/worker/bookings");
    expect(describeNotification({ ...base, type: "application_rejected", payload: { job_title: "Sofa", reason: "job_filled" } }, "worker").text).toContain("The job filled up.");
    expect(describeNotification({ ...base, type: "booking_cancelled", payload: { job_title: "Sofa", cancelled_by: "worker" } }, "employer")).toEqual({
      text: "The worker cancelled the booking for “Sofa”",
      to: "/employer/bookings",
    });
  });
});
