import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";

let dir: string;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let base: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kaamsetu-app-test-"));
  fs.writeFileSync(path.join(dir, "index.html"), '<div id="root"></div>');
  server = createApp({ staticDir: dir }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("app", () => {
  it("serves health as JSON", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("returns a JSON 404 for unknown API routes", async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/json/);
  });

  it("serves the SPA shell for client-side routes", async () => {
    const res = await fetch(`${base}/worker/jobs/123`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="root"');
  });
});
