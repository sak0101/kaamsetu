import { describe, expect, it } from "vitest";
import { resolvePort } from "./config";

describe("resolvePort", () => {
  it("uses PORT when provided", () => {
    expect(resolvePort({ PORT: "8080", NODE_ENV: "production" })).toBe(8080);
  });

  it("falls back to 3001 only outside production", () => {
    expect(resolvePort({})).toBe(3001);
    expect(resolvePort({ NODE_ENV: "development" })).toBe(3001);
  });

  it("throws in production when PORT is missing", () => {
    expect(() => resolvePort({ NODE_ENV: "production" })).toThrow(/PORT/);
  });

  it("rejects invalid values", () => {
    expect(() => resolvePort({ PORT: "abc" })).toThrow();
    expect(() => resolvePort({ PORT: "0" })).toThrow();
    expect(() => resolvePort({ PORT: "70000" })).toThrow();
    expect(() => resolvePort({ PORT: "80.5" })).toThrow();
  });
});
