import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = process.cwd();
const require = createRequire(
  path.join(root, "src/LogDesk.Client/package.json"),
);
const esbuild = require("esbuild");
await mkdir(".local", { recursive: true });
const result = await esbuild.build({
  entryPoints: ["src/LogDesk.Client/src/logProcessing.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const bundle = path.join(root, ".local/log-processing-check.mjs");
await writeFile(bundle, result.outputFiles[0].contents);
const {
  LogBuffer,
  defaultLogSettings: defaults,
  levelOf,
} = await import(pathToFileURL(bundle));
assert.equal(
  levelOf("message contains ERROR but is not a level", defaults),
  "unknown",
);
assert.equal(levelOf("INFO message contains ERROR", defaults), "info");
assert.equal(
  levelOf("2026-11-02T14:01:01.001+08:00 WARN slow", defaults),
  "warn",
);
assert.equal(levelOf('{"level":50,"msg":"failed"}', defaults), "error");
assert.equal(levelOf('{"severity":3}', defaults), "error");
assert.equal(levelOf('{"log":{"level":"fatal"}}', defaults), "fatal");
assert.equal(
  levelOf(
    '{"LogLevel":"Information","Message":"ERROR appears in body"}',
    defaults,
  ),
  "info",
);
assert.equal(levelOf('{"LogLevel":4}', defaults), "error");
assert.equal(levelOf('{"severityNumber":17}', defaults), "error");
assert.equal(levelOf('{"SeverityNumber":24}', defaults), "fatal");
assert.equal(levelOf('{"severityNumber":17.5}', defaults), "unknown");
assert.equal(
  levelOf("<14>1 2026-11-02 host process - - - text", defaults),
  "info",
);
assert.equal(levelOf("ERROR text", { ...defaults, format: "text" }), "unknown");
assert.equal(
  levelOf('{"meta":{"priority":3}}', {
    ...defaults,
    format: "json",
    jsonField: "meta.priority",
  }),
  "error",
);
console.log(
  "PASS conservative prefix / JSON / syslog detection; neutral plain text; nested JSON fields",
);
const b = new LogBuffer();
b.ingest(
  "INFO ready\nWARN timeout trace=abc\nERROR heartbeat timeout\nplain failure\n",
);
b.drain();
b.setSettings({ ...defaults, include: "timeout", exclude: "heartbeat" });
assert.equal(b.drain().rows.length, 1);
b.setSettings({ ...defaults, mode: "glob", include: "*trace=abc*" });
assert.equal(b.drain().rows.length, 1);
b.setSettings({
  ...defaults,
  mode: "regex",
  include: "TIMEOUT|failure",
  exclude: "heartbeat",
});
assert.equal(b.drain().rows.length, 2);
assert.equal(
  b.setSettings({ ...defaults, mode: "regex", include: "(?=timeout)" }),
  false,
);
assert.match(b.drain().error, /条件无效/);
b.setSettings({
  ...defaults,
  format: "custom",
  levelPattern: "^(INFO|WARN|ERROR)",
  levels: "errors",
});
assert.equal(b.drain().rows[0].level, "error");
const c = new LogBuffer();
c.ingest("before\nERROR marker\nafter\nheartbeat\n");
c.drain();
c.setSettings({
  ...defaults,
  include: "marker",
  exclude: "heartbeat",
  context: 2,
});
assert.equal(c.drain().rows.length, 3);
console.log(
  "PASS literal/glob/linear regex, exclusions, custom levels, invalid rules and context",
);
const ring = new LogBuffer();
ring.ingest(
  Array.from({ length: 15000 }, (_, i) => `INFO row ${i}\n`).join(""),
);
const state = ring.drain();
assert.equal(state.stats.retained, 10000);
assert.equal(state.stats.evicted, 5000);
const characterBound = new LogBuffer();
characterBound.ingest(("INFO " + "x".repeat(15_995) + "\n").repeat(200));
const bounded = characterBound.drain();
assert.ok(bounded.rows.reduce((sum, row) => sum + row.text.length, 0) <= 2_000_000);
assert.equal(bounded.stats.retained, 125);
assert.equal(bounded.stats.evicted, 75);
ring.ingest("a".repeat(100000));
ring.ingest("discard remainder\nINFO next\r\n");
const long = ring.drain();
assert.equal(long.stats.truncated, 1);
assert.ok(long.rows.some((r) => r.text === "INFO next"));
const frozen = ring.clone();
ring.ingest("INFO live after freeze\n");
assert.ok(
  !frozen.drain().rows.some((r) => r.text === "INFO live after freeze"),
);
const regex = new LogBuffer();
regex.setSettings({ ...defaults, mode: "regex", include: "(a+)+$" });
const started = performance.now();
regex.ingest("a".repeat(16000) + "!\n");
assert.ok(performance.now() - started < 1000);
console.log(
  "PASS bounded buffers, long-line truncation, frozen snapshot and pathological-pattern protection",
);
