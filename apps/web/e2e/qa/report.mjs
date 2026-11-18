// Renders docs/QA-REPORT.md from e2e/out/qa-results.json plus the hand-written findings below.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OUT, repo } from "./harness.mjs";

const data = JSON.parse(fs.readFileSync(path.join(OUT, "qa-results.json"), "utf8"));
const rs = data.results;
const count = (s) => rs.filter((r) => r.status === s).length;
const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const areas = [...new Set(rs.map((r) => r.area))];
const unexpectedNet = data.network.filter((e) => !e.expected);
const unexpectedCon = data.consoleErrors.filter((e) => !e.expected);
const expectedNet = data.network.length - unexpectedNet.length;

let md = `# KaamSetu: end-to-end QA report

Generated ${data.at} by \`npm run qa -w apps/web\` (suite: \`apps/web/e2e/qa/suite.mjs\`, report: \`apps/web/e2e/qa/report.mjs\`).

**Scope:** local development only: local Supabase (Auth, Postgres, Mailpit at http://127.0.0.1:54324), local Express API (:3001), local Vite (:5173), Microsoft Edge driven by Playwright. The harness refuses to run against a non-local Supabase URL. Nothing was deployed, pushed, or applied to a remote project; production Supabase and GoDaddy were not touched. Email confirmation stayed **enabled**: every QA account was confirmed by following the real link from Mailpit. No application code was changed to make a test pass.

## 1. Result summary

| Result | Count |
|---|---|
| PASS | ${count("PASS")} |
| FAIL | ${count("FAIL")} |
| BLOCKED | ${count("BLOCKED")} |
| NOT IMPLEMENTED | ${count("NOT IMPLEMENTED")} |
| **Total** | **${rs.length}** |

| Area | Pass | Fail | Blocked | Not impl. |
|---|---|---|---|---|
${areas.map((a) => { const x = rs.filter((r) => r.area === a); const c = (s) => x.filter((r) => r.status === s).length; return `| ${a} | ${c("PASS")} | ${c("FAIL")} | ${c("BLOCKED")} | ${c("NOT IMPLEMENTED")} |`; }).join("\n")}

QA accounts (identifiable, local DB only): ${data.accounts.map((a) => `\`${a.email}\` (${a.role})`).join(", ")}.

## 2. Test cases

| ID | Area | Case | Result | Evidence / reason |
|---|---|---|---|---|
${rs.map((r) => `| ${r.id} | ${esc(r.area)} | ${esc(r.name)} | ${r.status} | ${esc(r.error || r.evidence)}${r.screenshot ? ` ([screenshot](${r.screenshot}))` : ""} |`).join("\n")}

## 3. Not passing in this run

${rs.filter((r) => r.status !== "PASS").map((r) => `- **${r.id}** (${r.status}): ${esc(r.name)}: ${esc(r.error)}`).join("\n") || "None."}

## 4. Browser health

- Console errors outside negative tests: **${unexpectedCon.length}**; uncaught page errors: **${data.pageErrors.length}**.
- HTTP >= 400 responses outside negative tests: **${unexpectedNet.length}**; ${expectedNet} further 4xx responses were deliberately provoked by negative tests (bad login, unauthorised, validation, 404 route).
${unexpectedNet.map((e) => `  - ${e.method} ${e.status} ${e.url} (${e.test})`).join("\n")}

`;

md += fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "report-findings.md"), "utf8");
fs.writeFileSync(path.join(repo, "docs", "QA-REPORT.md"), md);
console.log(`wrote docs/QA-REPORT.md (${rs.length} cases)`);
