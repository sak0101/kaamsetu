// LOCAL TEST STUB of the Anthropic Messages API. THIS IS NOT CLAUDE.
//
// It exists only so the end-to-end browser tests can exercise the real request path
// (Express -> @anthropic-ai/sdk -> HTTP -> structured-output parsing -> Zod -> review UI)
// when no ANTHROPIC_API_KEY is available. It:
//   * REJECTS requests that don't look like what we promise to send (model, structured-output
//     schema with the real category/locality enums, a system prompt carrying today's date, one user
//     message, no thinking/sampling/forced-tool parameters);
//   * answers in the real Messages response format with a deterministic, regex-based extraction.
// Its extraction is crude on purpose and says NOTHING about how well real Claude drafts jobs.
import http from "node:http";

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20 };
const CATEGORY_KEYWORDS = [
  ["event_help", /wedding|event|catering|party|function|guest/],
  ["loading_unloading", /\bload|unload|tempo|truck|godown/],
  ["cleaning", /clean/],
  ["furniture_shifting", /shift|furniture|moving/],
  ["construction_helper", /construction|mason|site/],
  ["painting_helper", /paint/],
  ["gardening", /garden/],
  ["packing", /\bpack/],
];

const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const to24 = (h, m, ap) => {
  let hour = Number(h) % 12;
  if (/pm/i.test(ap)) hour += 12;
  return `${String(hour).padStart(2, "0")}:${m ? m : "00"}`;
};

function extract(system, user) {
  const today = /Today is \w+, (\d{4}-\d{2}-\d{2})/.exec(system)?.[1];
  const categories = Object.fromEntries(
    // "slug: English name / Hindi name / Gujarati name; ..." (the stub only needs the English name)
    [...(/Allowed categories \(value: [^)]*\): (.*)/.exec(system)?.[1] ?? "").split("; ")].map((p) => {
      const [slug, names = ""] = p.split(": ");
      return [slug, names.split(" / ")[0]];
    }),
  );
  const localities = (/Allowed localities: (.*)/.exec(system)?.[1] ?? "").split(", ").filter(Boolean);
  const text = user.toLowerCase();

  const assumptions = [];
  const questions = [];
  const out = {
    title: null, category: null, locality: null, description: null, responsibilities: [], requirements: [], workers_needed: null,
    date: null, start_time: null, end_time: null, pay_amount_rupees: null, pay_type: null, assumptions, questions,
  };

  const wk = /(\d+|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)\b)\s+(?:helpers?|workers?|people|persons?|cleaners?|staff|loaders?)/.exec(text);
  if (wk) out.workers_needed = Number.isNaN(Number(wk[1])) ? NUMBER_WORDS[wk[1]] : Number(wk[1]);

  const loc = localities.find((l) => text.includes(l.toLowerCase()));
  if (loc) out.locality = loc;

  const cat = CATEGORY_KEYWORDS.find(([slug, re]) => categories[slug] && re.test(text));
  if (cat) out.category = cat[0];

  if (/\btomorrow\b/.test(text)) {
    out.date = addDays(today, 1);
    assumptions.push({ field: "date", text: `Read 'tomorrow' as ${out.date}.` });
  } else if (/\btoday\b/.test(text)) out.date = today;
  const explicit = /(\d{4}-\d{2}-\d{2})/.exec(text);
  if (explicit) out.date = explicit[1];

  const t = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:to|-|until|till)\s*(?:midnight|(\d{1,2})(?::(\d{2}))?\s*(am|pm))/.exec(text);
  if (t) {
    out.start_time = to24(t[1], t[2], t[3]);
    if (/midnight/.test(t[0])) {
      out.end_time = "00:00";
      assumptions.push({ field: "end_time", text: "Midnight read as 00:00, the end of the day." });
    } else out.end_time = to24(t[4], t[5], t[6]);
  }

  const pay = /(?:₹|rs\.?\s*|rupees?\s*)(\d+)|(\d+)\s*(?:rupees|rs\b)/.exec(text);
  if (pay) out.pay_amount_rupees = Number(pay[1] ?? pay[2]);
  if (/per hour|an hour|hourly/.test(text)) out.pay_type = "hourly";
  else if (/per day|a day|daily/.test(text)) out.pay_type = "daily";
  else if (/per person|per worker|each|a head/.test(text) && out.pay_amount_rupees !== null) {
    out.pay_type = "fixed";
    assumptions.push({ field: "pay_type", text: `₹${out.pay_amount_rupees} per person treated as a fixed amount for the whole job.` });
  }

  const help = /help with ([^.]+?)(?:\.|$)/.exec(text);
  if (help) out.responsibilities = help[1].split(/,| and /).map((s) => s.trim()).filter(Boolean).map((s) => s[0].toUpperCase() + s.slice(1));

  if (out.category && out.locality) out.title = `${categories[out.category]}, ${out.locality}`;
  if (out.category) out.description = `${out.workers_needed ?? "Some"} helpers for ${categories[out.category].toLowerCase()}${out.locality ? ` in ${out.locality}` : ""}.`;

  // follow-up answers (stub understands the ones the E2E journey gives)
  const answers = [...user.matchAll(/Question: (.*)\nAnswer: (.*)/g)].map((m) => ({ q: m[1].toLowerCase(), a: m[2].toLowerCase() }));
  for (const { q, a } of answers) {
    if (/locality/.test(q)) out.locality = localities.find((l) => a.includes(l.toLowerCase())) ?? out.locality;
    if (/how much|pay/.test(q)) {
      const m = /(\d+)/.exec(a);
      if (m) out.pay_amount_rupees = Number(m[1]);
      out.pay_type = /hour/.test(a) ? "hourly" : /day/.test(a) ? "daily" : "fixed";
    }
    if (/how many/.test(q)) {
      const m = /(\d+)/.exec(a);
      if (m) out.workers_needed = Number(m[1]);
    }
    if (/time|start|end/.test(q)) {
      const tm = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:to|-|until|till)\s*(?:midnight|(\d{1,2})(?::(\d{2}))?\s*(am|pm))/.exec(a);
      if (tm) {
        out.start_time = to24(tm[1], tm[2], tm[3]);
        out.end_time = /midnight/.test(tm[0]) ? "00:00" : to24(tm[4], tm[5], tm[6]);
      }
    }
    if (/what kind|type of work/.test(q)) {
      const c = CATEGORY_KEYWORDS.find(([slug, re]) => categories[slug] && re.test(a));
      if (c) out.category = c[0];
    }
  }
  if (out.category && out.locality && !out.title) out.title = `${categories[out.category]}, ${out.locality}`;

  if (!out.locality) questions.push({ field: "locality", question: "Which locality in Vadodara is the work in?" });
  if (!out.category) questions.push({ field: "category", question: "What kind of work is this?" });
  if (out.workers_needed === null) questions.push({ field: "workers_needed", question: "How many workers do you need?" });
  if (out.pay_amount_rupees === null) questions.push({ field: "pay_amount", question: "How much will you pay each worker (in rupees)?" });
  return out;
}

export function startAnthropicStub(port = 4010) {
  const log = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const fail = (status, message) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }));
      };
      if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) return fail(404, "not found");
      let p;
      try {
        p = JSON.parse(body);
      } catch {
        return fail(400, "invalid json");
      }
      log.push({ headers: req.headers, body: p });

      // Validate the request we promise to send. A violation is a 400, so the E2E run fails loudly.
      const problems = [];
      if (!req.headers["x-api-key"] && !/^Bearer .+/.test(req.headers.authorization ?? "")) problems.push("missing API credentials");
      if (typeof p.model !== "string" || !p.model.startsWith("claude-")) problems.push("model not a claude-* id");
      if (!(p.max_tokens >= 1000)) problems.push("max_tokens too low");
      if (p.output_config?.format?.type !== "json_schema") problems.push("no json_schema output format");
      const schema = JSON.stringify(p.output_config?.format?.schema ?? {});
      for (const must of ["event_help", "Alkapuri", "workers_needed", "assumptions", "questions"]) if (!schema.includes(must)) problems.push(`schema lacks ${must}`);
      if (typeof p.system !== "string" || !/Today is \w+, \d{4}-\d{2}-\d{2}/.test(p.system)) problems.push("system prompt lacks today's date");
      if (!/cannot publish/i.test(p.system ?? "")) problems.push("system prompt does not say the model cannot publish");
      if (p.messages?.length !== 1 || p.messages[0].role !== "user") problems.push("expected exactly one user message");
      if (!String(p.messages?.[0]?.content ?? "").includes("<organiser_request>")) problems.push("user text not delimited");
      for (const banned of ["thinking", "temperature", "top_p", "top_k", "tool_choice"]) if (banned in p) problems.push(`must not send ${banned}`);
      if (problems.length) return fail(400, `stub rejected request: ${problems.join("; ")}`);

      const out = extract(p.system, p.messages[0].content);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_stub_not_claude",
          type: "message",
          role: "assistant",
          model: p.model,
          content: [{ type: "text", text: JSON.stringify(out) }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, log, close: () => server.close() })));
}
