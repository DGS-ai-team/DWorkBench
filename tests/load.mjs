// Isolated SSH protocol fixture + real authenticated SignalR clients. No user hosts/config.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  root,
  require,
  delay,
  until,
  sshFixture,
  startApp,
  configure,
  viewer,
  HubConnectionBuilder,
  LogLevel,
} from "./load-support.mjs";
const seconds = Number(process.env.LOAD_SECONDS ?? 15),
  short = process.env.LOAD_SHORT === "1";
const report = {
  startedAt: new Date().toISOString(),
  environment: {
    os: os.platform(),
    cpus: os.availableParallelism(),
    node: process.version,
    database: process.env.TEST_DATABASE_PROVIDER ?? "Sqlite",
    transport: "loopback SSH/SFTP fixture + HTTP/WebSocket",
    tls: false,
  },
  stages: [],
  checks: [],
};
const fixture = await sshFixture();
let application, browser;
const clients = [];

async function sample(app, label) {
  const output = path.join(app.storage, label + "-process.json");
  if (process.platform === "win32") {
    const powershell = path.join(
      process.env.SystemRoot,
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    );
    const p = spawn(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        path.join(root, "tests/measure-process.ps1"),
        "-AppProcessId",
        String(app.child.pid),
        "-Seconds",
        String(seconds),
        "-OutputFile",
        output,
      ],
      { windowsHide: true },
    );
    let error = "";
    p.stderr.on("data", (v) => (error += v));
    await new Promise((resolve, reject) => {
      p.on("error", reject);
      p.on("exit", (code) => (code === 0 ? resolve() : reject(Error(error))));
    });
    return JSON.parse((await readFile(output, "utf8")).replace(/^\uFEFF/, ""));
  }
  const began = performance.now();
  let peak = 0,
    before;
  const snapshot = async () => {
    const stat = (await readFile(`/proc/${app.child.pid}/stat`, "utf8"))
      .slice(
        (await readFile(`/proc/${app.child.pid}/stat`, "utf8")).lastIndexOf(
          ")",
        ) + 1,
      )
      .trim()
      .split(/\s+/);
    const status = await readFile(`/proc/${app.child.pid}/status`, "utf8");
    return {
      ticks: Number(stat[11]) + Number(stat[12]),
      rss: Number(status.match(/VmRSS:\s+(\d+)/)[1]) / 1024,
    };
  };
  before = await snapshot();
  while (performance.now() - began < seconds * 1000) {
    await delay(500);
    peak = Math.max(peak, (await snapshot()).rss);
  }
  const after = await snapshot(),
    duration = (performance.now() - began) / 1000;
  return {
    seconds: duration,
    logicalCores: os.availableParallelism(),
    cpuOneCorePercent: (after.ticks - before.ticks) / duration,
    cpuMachinePercent:
      (after.ticks - before.ticks) / duration / os.availableParallelism(),
    workingSetPeakMiB: peak,
  };
}
class ReaderClient {
  text = "";
  ready = false;
  closed = false;
  errors = [];
  measurement;
  rawCharacters = 0;
  constructor(api, target) {
    this.api = api;
    this.target = target;
  }
  async start() {
    this.hub = new HubConnectionBuilder()
      .withUrl(this.api.base + "/hubs/logs", {
        headers: { Cookie: this.api.cookie() },
      })
      .configureLogging(LogLevel.None)
      .build();
    await this.hub.start();
    this.subscription = this.hub
      .stream("Watch", this.target.group.id, this.target.file.id)
      .subscribe({
        next: (text) => {
          this.ready = true;
          this.accept(text);
        },
        error: (e) => {
          if (!this.closed) this.errors.push(String(e));
        },
      });
  }
  accept(text) {
    this.rawCharacters += text.length;
    this.text += text;
    let end;
    while ((end = this.text.indexOf("\n")) >= 0) {
      const line = this.text.slice(0, end);
      this.text = this.text.slice(end + 1);
      const match = /__seq=(\d+) __ts=(\d+)/.exec(line);
      if (!match || !this.measurement) continue;
      const seq = Number(match[1]),
        at = Number(match[2]),
        m = this.measurement;
      if (seq < m.first || seq > m.last) continue;
      m.received++;
      m.bytes += Buffer.byteLength(line) + 1;
      if (m.previous && seq !== m.previous + 1)
        m.gaps += Math.abs(seq - m.previous - 1);
      m.previous = seq;
      const latency = Math.max(0, Date.now() - at);
      m.hist[Math.min(latency, 10000)]++;
      m.max = Math.max(m.max, latency);
    }
  }
  begin(first) {
    this.measurement = {
      first,
      last: Infinity,
      received: 0,
      bytes: 0,
      gaps: 0,
      previous: 0,
      hist: new Uint32Array(10001),
      max: 0,
    };
  }
  async close() {
    this.closed = true;
    this.subscription?.dispose();
    await this.hub?.stop();
  }
}
async function addClients(users, target, count) {
  while (clients.length < count) {
    const used = users
      .map((user) => ({
        user,
        count: clients.filter((c) => c.api === user.api).length,
      }))
      .sort((a, b) => a.count - b.count);
    assert.ok(used[0].count < 4);
    const c = new ReaderClient(used[0].user.api, target);
    await c.start();
    clients.push(c);
  }
  await until(() => clients.every((c) => c.ready), "reader readiness");
}
async function closeClients() {
  for (const c of clients.splice(0)) await c.close();
}
function percentile(hist, count, p) {
  const target = Math.ceil(count * p);
  let seen = 0;
  for (let i = 0; i < hist.length; i++) {
    seen += hist[i];
    if (seen >= target) return i;
  }
  return null;
}
async function phase(label, app, target, users, count, rate, expectedReaders) {
  console.log(
    `START ${label}: ${count} subscriptions, ${rate} lines/s, ${seconds}s`,
  );
  await addClients(users, target, count);
  fixture.setRate(rate);
  await delay(3000);
  assert.equal(fixture.active, expectedReaders, "actual SSH exec readers");
  const first = fixture.seq + 1,
    bytesBefore = fixture.bytes,
    sshBefore = fixture.sshBytes,
    began = performance.now(),
    generatorCpu = process.cpuUsage();
  for (const c of clients) c.begin(first);
  const processSample = sample(app, label);
  await delay(seconds * 1000);
  fixture.setRate(0);
  const last = fixture.seq,
    elapsed = (performance.now() - began) / 1000;
  for (const c of clients) c.measurement.last = last;
  await delay(1200);
  const resources = await processSample;
  const hist = new Uint32Array(10001);
  let received = 0,
    deliveredBytes = 0,
    gaps = 0;
  for (const c of clients) {
    const m = c.measurement;
    received += m.received;
    deliveredBytes += m.bytes;
    gaps += m.gaps;
    for (let i = 0; i < hist.length; i++) hist[i] += m.hist[i];
    assert.equal(c.errors.length, 0, c.errors.join(";"));
  }
  const generated = last - first + 1;
  assert.equal(
    received,
    generated * count,
    "every measured line must reach every healthy subscriber",
  );
  assert.equal(gaps, 0, "no duplicate/gap at healthy subscribers");
  let broker;
  if (expectedReaders === 1) {
    broker = await app.admin.request("/streams/status");
    assert.equal(broker.readers, 1);
    assert.equal(broker.subscriptions, count);
    assert.ok(
      broker.bufferedCharacters <= count * broker.limits.subscriberCharacters,
    );
  }
  const generator = process.cpuUsage(generatorCpu);
  const result = {
    label,
    subscriptions: count,
    users: new Set(clients.map((c) => c.api)).size,
    requestedLinesPerSecond: rate,
    actualLinesPerSecond: generated / elapsed,
    seconds: elapsed,
    remoteReaders: fixture.active,
    generatedLines: generated,
    receivedLines: received,
    gaps,
    inputMiBPerSecond: (fixture.bytes - bytesBefore) / elapsed / 1048576,
    sshPayloadMiBPerSecond: (fixture.sshBytes - sshBefore) / elapsed / 1048576,
    deliveredMiBPerSecond: deliveredBytes / elapsed / 1048576,
    p50Ms: percentile(hist, received, 0.5),
    p95Ms: percentile(hist, received, 0.95),
    p99Ms: percentile(hist, received, 0.99),
    resources,
    generatorAndClientsOneCorePercent:
      (generator.user + generator.system) / (elapsed * 10000),
    broker,
  };
  assert.ok(
    result.p95Ms < 1000,
    "p95 latency must remain below one second in this workload",
  );
  assert.ok(
    resources.workingSetPeakMiB < 1024,
    "process working set must remain below 1 GiB in this workload",
  );
  report.stages.push(result);
  console.log("RESULT " + JSON.stringify(result));
  return result;
}
async function buildUsers(app, target, count) {
  const users = [];
  for (let i = 0; i < count; i++) users.push(await viewer(app, target, i));
  return users;
}

async function slowClientCheck(app, target) {
  const WebSocket = require("ws");
  const raw = new WebSocket(app.base.replace("http:", "ws:") + "/hubs/logs", {
    headers: { Cookie: app.admin.cookie() },
  });
  raw.on("error", () => {});
  let ready = false;
  raw.on("message", (data) => {
    for (const part of data.toString().split("\x1e").filter(Boolean)) {
      const value = JSON.parse(part);
      if (value.type === undefined)
        raw.send(
          JSON.stringify({
            type: 4,
            invocationId: "slow-load",
            target: "WatchV2",
            arguments: [target.group.id, target.file.id],
          }) + "\x1e",
        );
      if (value.type === 2 && value.item?.kind === "ready") {
        ready = true;
        raw._socket.pause();
      }
    }
  });
  await new Promise((resolve, reject) => {
    raw.once("open", () => {
      raw.send('{"protocol":"json","version":1}\x1e');
      resolve();
    });
    raw.once("error", reject);
  });
  await until(() => ready, "slow connection handshake");
  const initial = await app.admin.request("/streams/status");
  const healthy = clients.map((c) => c.rawCharacters);
  fixture.setRate(5000);
  const ping = setInterval(() => {
    if (raw.readyState === WebSocket.OPEN) raw.send('{"type":6}\x1e');
  }, 4000);
  try {
    await until(
      async () => {
        const status = await app.admin.request("/streams/status");
        return status.slowDisconnected > initial.slowDisconnected;
      },
      "only stalled client is detached",
      25000,
    );
    for (let i = 0; i < clients.length; i++) {
      assert.equal(clients[i].errors.length, 0);
      assert.ok(
        clients[i].rawCharacters > healthy[i],
        "healthy client must continue receiving",
      );
    }
    assert.equal(fixture.active, 1);
    report.checks.push({
      name: "stalled TCP client detached while healthy readers and one shared SSH reader remain",
      passed: true,
    });
    console.log("PASS slow client isolation");
  } finally {
    clearInterval(ping);
    fixture.setRate(0);
    raw.terminate();
  }
}

async function browserCheck(app, target) {
  const { chromium } = require("@playwright/test");
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 940 },
    locale: "zh-CN",
  });
  await context.addCookies(
    [...app.admin.cookies].map(([name, value]) => ({
      name,
      value,
      url: app.base,
      httpOnly: true,
      sameSite: "Strict",
    })),
  );
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(app.base);
  await page.getByRole("button", { name: "日志清单" }).click();
  await page.getByLabel("选择 bench.log", { exact: true }).check();
  await page.getByRole("button", { name: "加入并阅读" }).click();
  await page.locator(".live-label.is-live").waitFor();
  await page.evaluate(() => {
    window.__load = {
      start: performance.now(),
      frames: 0,
      longTasks: 0,
      maxTask: 0,
    };
    const tick = () => {
      window.__load.frames++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        window.__load.longTasks++;
        window.__load.maxTask = Math.max(window.__load.maxTask, e.duration);
      }
    }).observe({ entryTypes: ["longtask"] });
  });
  fixture.setRate(5000);
  await delay(3000);
  await page.getByLabel("bench.log 匹配方式").selectOption("regex");
  await page
    .getByLabel("筛选 bench.log 当前缓存", { exact: true })
    .fill("trace_id=keep");
  await page
    .getByRole("button", { name: "bench.log 筛选与格式设置", exact: true })
    .click();
  await page
    .getByLabel("bench.log 排除模式", { exact: true })
    .fill("duration_ms=499");
  await page
    .getByLabel("bench.log 日志格式", { exact: true })
    .selectOption("text");
  await until(
    async () =>
      page
        .locator(".log-line")
        .evaluateAll(
          (items) =>
            items.length > 0 &&
            items.every(
              (e) =>
                e.dataset.level === "unknown" &&
                e.textContent.includes("trace_id=keep"),
            ),
        ),
    "worker filtered plain-text rendering",
  );
  await page.getByLabel("筛选 bench.log 当前缓存", { exact: true }).fill("(a)\\1");
  await page.getByRole("alert").waitFor();
  await page
    .getByLabel("筛选 bench.log 当前缓存", { exact: true })
    .fill("trace_id=keep");
  await page.getByRole("alert").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "冻结显示", exact: true }).click();
  await page.locator(".pane-frozen").waitFor();
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const frozenText = await page.locator(".log-line").allTextContents();
  await delay(1200);
  assert.deepEqual(
    await page.locator(".log-line").allTextContents(),
    frozenText,
    "frozen rows do not move",
  );
  await page
    .getByLabel("筛选 bench.log 当前缓存", { exact: true })
    .fill("never_match_this");
  await page.getByText("当前缓冲中没有匹配的日志。", { exact: true }).waitFor();
  await page
    .getByLabel("筛选 bench.log 当前缓存", { exact: true })
    .fill("trace_id=keep");
  await page.getByRole("button", { name: "关闭筛选设置" }).click();
  await page
    .getByRole("button", { name: "恢复实时显示", exact: true })
    .first()
    .click();
  await delay(4000);
  assert.ok((await page.locator(".pane-foot").innerText()).includes("已淘汰"));
  assert.ok((await page.locator(".log-line").count()) < 200);
  assert.deepEqual(errors, []);
  const perf = await page.evaluate(() => ({
    ...window.__load,
    seconds: (performance.now() - window.__load.start) / 1000,
    mainThreadHeapBytes: performance.memory?.usedJSHeapSize ?? null,
  }));
  perf.averageRafPerSecond = perf.frames / perf.seconds;
  report.browser = {
    passed: true,
    rate: 5000,
    ...perf,
    note: "Heap statistic covers the page main realm only; workers and Chromium native memory are not included.",
  };
  await page.screenshot({
    path: path.join(root, ".local/load-browser.png"),
    fullPage: true,
  });
  fixture.setRate(0);
  await context.close();
  await browser.close();
  browser = null;
  console.log(
    "PASS browser worker filtering/format/invalid regex/freeze/virtualization " +
      JSON.stringify(report.browser),
  );
}

try {
  if (process.env.LOAD_BASELINE_DLL) {
    application = await startApp(
      "load-baseline",
      process.env.LOAD_BASELINE_DLL,
    );
    const target = await configure(application, fixture),
      users = await buildUsers(application, target, 8);
    // One stream per user in the baseline; old per-host quota is eight.
    for (const user of users) {
      const client = new ReaderClient(user.api, target);
      await client.start();
      clients.push(client);
    }
    await until(() => clients.every((c) => c.ready), "baseline readiness");
    await phase("baseline-8x1000", application, target, users, 8, 1000, 8);
    await closeClients();
    await until(() => fixture.active === 0, "baseline SSH cleanup");
    await application.close();
    application = null;
  }
  application = await startApp("load-shared");
  const target = await configure(application, fixture);
  const loginWindow = Date.now();
  const users =
    process.env.LOAD_BROWSER_ONLY === "1"
      ? []
      : await buildUsers(application, target, 8);
  if (process.env.LOAD_BROWSER_ONLY !== "1") {
    await phase("shared-8x1000", application, target, users, 8, 1000, 1);
    await phase("shared-32x1000", application, target, users, 32, 1000, 1);
    if (!short) {
      await phase("shared-32x5000", application, target, users, 32, 5000, 1);
      const remaining = 61000 - (Date.now() - loginWindow);
      if (remaining > 0) {
        console.log(
          "Waiting " +
            Math.ceil(remaining / 1000) +
            "s for normal login rate-limit window",
        );
        await delay(remaining);
      }
      for (let i = 8; i < 16; i++)
        users.push(await viewer(application, target, i));
      await phase("shared-64x1000", application, target, users, 64, 1000, 1);
      await slowClientCheck(application, target);
    }
  }
  await closeClients();
  await until(async () => {
    const status = await application.admin.request("/streams/status");
    return status.subscriptions === 0;
  }, "all load client reservations released");
  if (process.env.SKIP_BROWSER !== "1") await browserCheck(application, target);
  await until(
    async () => {
      const status = await application.admin.request("/streams/status");
      return status.readers === 0 && status.subscriptions === 0;
    },
    "idle reader shutdown",
    15000,
  );
  assert.equal(fixture.active, 0);
  assert.equal(fixture.upstreamSlow, 0);
  report.checks.push({
    name: "all subscribers and remote readers released",
    passed: true,
  });
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack;
  console.error(error.stack);
  if (browser)
    for (const c of browser.contexts())
      for (const p of c.pages())
        await p
          .screenshot({
            path: path.join(root, ".local/load-browser-failure.png"),
            fullPage: true,
          })
          .catch(() => {});
  process.exitCode = 1;
} finally {
  fixture.setRate(0);
  if (browser) await browser.close();
  await closeClients();
  if (application) await application.close();
  await fixture.close();
  report.finishedAt = new Date().toISOString();
  const filename = process.env.LOAD_REPORT ?? ".local/load-results.json";
  await writeFile(filename, JSON.stringify(report, null, 2));
  console.log("Report: " + filename);
}
