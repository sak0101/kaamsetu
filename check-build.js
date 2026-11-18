// Runs as "npm run build" on GoDaddy. The frontend and server are compiled
// before packaging, so this verifies the artefacts instead of rebuilding them.
const fs = require("node:fs");
const path = require("node:path");
const required = ["server.js", path.join("public", "index.html")];
const missing = required.filter((f) => !fs.existsSync(path.join(__dirname, f)));
if (missing.length) {
  console.error("Build check failed. Missing: " + missing.join(", "));
  process.exit(1);
}
console.log("Build check passed: " + required.join(", ") + " present.");
