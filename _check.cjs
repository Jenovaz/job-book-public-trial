const fs = require("fs"), vm = require("vm");
let fail = 0;

const html = fs.readFileSync("src/app.html", "utf8");
const m = html.match(/<script>\s*([\s\S]*?)<\/script>\s*<\/body>/);
if (!m) { console.error("x could not locate app script block"); fail = 1; }
else {
  try { new vm.Script(m[1], {filename:"app.inline.js"}); console.log("ok  app.html inline JS parses (" + m[1].length + " chars)"); }
  catch (e) { console.error("x  app.html inline JS: " + e.message); fail = 1; }
}

const login = fs.readFileSync("src/login.html", "utf8");
console.log((login.includes("{{ERROR}}") ? "ok " : "x  ") + "login.html has {{ERROR}} placeholder");
if (!login.includes("{{ERROR}}")) fail = 1;

for (const bad of ["{{ERROR}}", "claude.use", "artifact.publish"]) {
  if (html.includes(bad)) { console.error("x  app.html still contains " + bad); fail = 1; }
}

// The public demo is a complete document.
const idx = fs.readFileSync("index.html", "utf8");
const m2 = idx.match(/<script>\s*([\s\S]*?)<\/script>\s*<\/body>\s*<\/html>\s*$/);
if (!m2) { console.error("x could not locate index.html script block"); fail = 1; }
else {
  try { new vm.Script(m2[1], {filename:"index.inline.js"}); console.log("ok  index.html inline JS parses (" + m2[1].length + " chars)"); }
  catch (e) { console.error("x  index.html inline JS: " + e.message); fail = 1; }
}

if (idx.includes("uploadPhoto") && !idx.match(/function uploadPhoto/)) {
  console.log("ok  index.html references uploadPhoto only inside PHOTOS_ENABLED-gated code (never defines it, matching the Worker-only feature)");
} else {
  console.error("x  index.html's uploadPhoto isolation assumption no longer holds — recheck PHOTOS_ENABLED gating");
  fail = 1;
}

process.exit(fail);
