// Real OpenSSH/SFTP + Linux secure follower verification on the developer's WSL distro.
// Run from the repository: node tests/wsl-integration.mjs
// Creates an isolated account/sshd/log directory, then removes them in finally.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(
  path.join(root, "src/LogDesk.Client/package.json"),
);
const { HubConnectionBuilder, LogLevel } = require("@microsoft/signalr");
const { Client: SshClient } = require("ssh2");
const distro = process.env.WSL_DISTRO ?? "Ubuntu";
const suffix = randomBytes(5).toString("hex");
const account = "ldwsl" + suffix;
const remoteRoot = "/var/tmp/logdesk-wsl-" + suffix;
const remoteLog = remoteRoot + "/logs/api space's.log";
const password = "WslTest-" + randomBytes(24).toString("base64url");
const adminPassword = "Admin-" + randomBytes(24).toString("base64url");
const bootstrap = randomBytes(32).toString("hex");
const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const children = [];
let appOutput = "",
  sshdOutput = "",
  browser,
  hub,
  sshd,
  sshPort,
  setupAttempted = false;
let storage, metadata;

async function wsl(script, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "wsl.exe",
      ["-d", distro, "-u", "root", "--", "sh", "-s"],
      { windowsHide: true },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (value) => (stdout += value));
    child.stderr.on("data", (value) => (stderr += value));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("WSL command timed out"));
    }, timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else
        reject(
          new Error(
            `WSL exit ${code}: ${stderr.replaceAll(password, "[redacted]")} ${stdout}`,
          ),
        );
    });
    child.stdin.end("set -eu\n" + script + "\n");
  });
}
async function until(check, description, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(150);
  }
  throw new Error("Timed out: " + description);
}
async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}
async function ssh(command) {
  return new Promise((resolve, reject) => {
    const client = new SshClient();
    client.on("error", reject);
    client.on("ready", () =>
      client.exec(command, (error, stream) => {
        if (error) {
          client.end();
          reject(error);
          return;
        }
        let output = "";
        stream.on("data", (value) => (output += value));
        stream.stderr.on("data", (value) => (output += value));
        stream.on("close", (code) => {
          client.end();
          if (code === 0) resolve(output.trim());
          else reject(new Error("SSH command exited " + code + ": " + output));
        });
      }),
    );
    client.connect({
      host: "127.0.0.1",
      port: sshPort,
      username: account,
      password,
      readyTimeout: 10000,
    });
  });
}
class Api {
  cookies = new Map();
  csrf = "";
  constructor(base) {
    this.base = base;
  }
  cookie() {
    return [...this.cookies]
      .map(([key, value]) => `${key}=${value}`)
      .join("; ");
  }
  async request(
    route,
    body,
    method = body === undefined ? "GET" : "POST",
    expected = 200,
  ) {
    const response = await fetch(this.base + "/api" + route, {
      method,
      headers: {
        Cookie: this.cookie(),
        "X-CSRF-Token": this.csrf,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const raw of response.headers.getSetCookie()) {
      const [key, ...value] = raw.split(";")[0].split("=");
      this.cookies.set(key, value.join("="));
    }
    const raw = await response.text();
    assert.equal(response.status, expected, `${method} ${route}: ${raw}`);
    return raw ? JSON.parse(raw) : null;
  }
  async session() {
    const result = await this.request("/session");
    this.csrf = result.csrfToken;
    return result;
  }
}
function pass(name, details = {}) {
  results.push({ name, passed: true, ...details });
  console.log(
    "PASS " +
      name +
      (Object.keys(details).length ? " " + JSON.stringify(details) : ""),
  );
}
async function mutate(code) {
  return wsl(
    "python3 - <<'PY'\nimport os, pathlib, json\np=pathlib.Path(" +
      JSON.stringify(remoteLog) +
      ")\n" +
      code +
      "\nPY",
  );
}
async function followerPids() {
  const listing = await wsl(`ps -u ${account} -o pid=,comm=,args= || true`);
  return listing
    .split("\n")
    .filter((line) => /^\s*\d+\s+python3\s+python3 -u -c/.test(line))
    .join("\n");
}
async function exerciseFollower(group, file, label) {
  let output = "",
    streamError;
  const subscription = hub.stream("Watch", group.id, file.id).subscribe({
    next: (chunk) => (output += chunk),
    error: (error) => {
      streamError = error;
    },
    complete: () => {},
  });
  try {
    await until(() => {
      if (streamError) throw streamError;
      return output.includes("服务已启动");
    }, label + " initial UTF-8");
    assert.ok(await followerPids(), "A real remote follower process must be running");
    const start = Date.now();
    await mutate(
      `with p.open('a', encoding='utf-8') as f: f.write(${JSON.stringify(label + " append 实时追加 ✓\n")})`,
    );
    await until(() => {
      if (streamError) throw streamError;
      return output.includes(label + " append 实时追加 ✓");
    }, label + " append");
    const appendMs = Date.now() - start;
    const beforeTruncate = output.length;
    await mutate(
      `p.write_text(${JSON.stringify(label + " truncate 截断后继续\n")}, encoding='utf-8')`,
    );
    await until(() => {
      if (streamError) throw streamError;
      return output
        .slice(beforeTruncate)
        .includes(label + " truncate 截断后继续");
    }, label + " truncate");
    const rotationStart = Date.now(),
      beforeRotate = output.length;
    await mutate(
      `p.rename(str(p)+'.1')\np.write_text(${JSON.stringify(label + " rotate 轮转新文件\n")}, encoding='utf-8')`,
    );
    await until(() => {
      if (streamError) throw streamError;
      return output.slice(beforeRotate).includes(label + " rotate 轮转新文件");
    }, label + " rotation");
    const rotationMs = Date.now() - rotationStart;
    const beforeRecreate = output.length;
    await mutate("p.unlink()");
    await delay(1200);
    await mutate(
      `p.write_text(${JSON.stringify(label + " recreate 文件重建\n")}, encoding='utf-8')`,
    );
    await until(() => {
      if (streamError) throw streamError;
      return output
        .slice(beforeRecreate)
        .includes(label + " recreate 文件重建");
    }, label + " deletion/recreation");
    pass(label + ": real follower initial/append/truncate/rotate/recreate", {
      appendMs,
      rotationMs,
    });
  } finally {
    subscription.dispose();
    await until(
      async () => !(await followerPids()),
      label + " follower process cleanup",
      10000,
    );
  }
  pass(label + ": cancelling stream removes remote follower");
}

try {
  assert.equal(
    process.platform,
    "win32",
    "Run this verifier on the Windows development host with WSL.",
  );
  await mkdir(path.join(root, ".local"), { recursive: true });
  storage = await mkdtemp(path.join(root, ".local/wsl-integration-"));
  metadata = await wsl(
    "cat /etc/os-release; /usr/sbin/sshd -V 2>&1; python3 --version",
  );
  console.log(metadata);
  // Reserve separate free ports in Windows and Linux; no changes to port 22 or system sshd configuration.
  for (let i = 0; i < 10; i++) {
    const candidate = await freePort();
    const available = await wsl(
      `python3 - <<'PY'\nimport socket\ns=socket.socket()\ntry:\n s.bind(('127.0.0.1', ${candidate})); print('yes')\nexcept OSError:\n print('no')\nfinally:\n s.close()\nPY`,
    );
    if (available === "yes") {
      sshPort = candidate;
      break;
    }
  }
  assert.ok(sshPort, "No available SSH port");
  setupAttempted = true;
  await wsl(`test ! -e ${remoteRoot}
! id ${account} >/dev/null 2>&1
mkdir -m 755 ${remoteRoot}
mkdir -m 755 ${remoteRoot}/logs ${remoteRoot}/bin
useradd --no-create-home --home-dir ${remoteRoot}/home --shell /bin/sh ${account}
mkdir -m 700 ${remoteRoot}/home
chown ${account}:${account} ${remoteRoot}/home
printf '%s\\n' ${quote(account + ":" + password)} | chpasswd
ssh-keygen -q -t ed25519 -N '' -f ${remoteRoot}/host_key
mkdir -p /run/sshd
cat > ${remoteRoot}/sshd_config <<'CONFIG'
Port ${sshPort}
ListenAddress 127.0.0.1
HostKey ${remoteRoot}/host_key
PidFile ${remoteRoot}/sshd.pid
AllowUsers ${account}
PermitRootLogin no
PasswordAuthentication yes
AuthenticationMethods password
KbdInteractiveAuthentication no
UsePAM no
AllowTcpForwarding no
AllowAgentForwarding no
X11Forwarding no
PermitTunnel no
PermitUserEnvironment no
PrintMotd no
LogLevel ERROR
SetEnv PATH=${remoteRoot}/bin:/usr/bin:/bin
Subsystem sftp internal-sftp
CONFIG
chmod 600 ${remoteRoot}/sshd_config
/usr/sbin/sshd -t -f ${remoteRoot}/sshd_config
python3 - <<'PY'
import pathlib
d=pathlib.Path(${JSON.stringify(remoteRoot + "/logs")})
for n in range(250): (d/('archive-%03d.log'%n)).write_text('archive %d\\n'%n, encoding='utf-8')
(d/"api space's.log").write_text('INFO 服务已启动 ✓\\n', encoding='utf-8')
(d/'worker.log').write_text('INFO worker ready\\n', encoding='utf-8')
(d/'empty.log').write_text('', encoding='utf-8')
(d/'ignored.txt').write_text('not a log\\n', encoding='utf-8')
(d/'link.log').symlink_to(d/'worker.log')
PY`);
  sshd = spawn(
    "wsl.exe",
    [
      "-d",
      distro,
      "-u",
      "root",
      "--",
      "/usr/sbin/sshd",
      "-D",
      "-e",
      "-f",
      remoteRoot + "/sshd_config",
    ],
    { windowsHide: true },
  );
  children.push(sshd);
  sshd.stdout.on("data", (value) => (sshdOutput += value));
  sshd.stderr.on("data", (value) => (sshdOutput += value));
  await until(async () => {
    try {
      return (await ssh("printf ready")) === "ready";
    } catch {
      return false;
    }
  }, "WSL SSH from Windows");
  pass("Windows → WSL OpenSSH password authentication", {
    address: "127.0.0.1",
    port: sshPort,
  });
  const pythonVersion = await ssh("python3 --version");
  console.log("Remote reader runtime: " + pythonVersion);
  assert.match(pythonVersion, /Python 3/);
  const pinned = (
    await wsl(`ssh-keygen -l -E sha256 -f ${remoteRoot}/host_key.pub`)
  ).split(/\s+/)[1];

  const appPort = await freePort(),
    base = `http://127.0.0.1:${appPort}`;
  const dotnet =
    process.env.DOTNET_EXE ?? path.join(root, ".tools/dotnet/dotnet.exe");
  const app = spawn(
    dotnet,
    [
        process.env.TEST_SERVER_DLL ?? path.join(
        root,
        "src/LogDesk.Server/bin/Debug/net10.0/LogDesk.Server.dll",
      ),
    ],
    {
      cwd: path.join(root, "src/LogDesk.Server"),
      windowsHide: true,
      env: {
        ...process.env,
        ASPNETCORE_ENVIRONMENT: "Development",
        ASPNETCORE_URLS: base,
        Database__Provider: "Sqlite",
        Storage__Root: storage,
        Bootstrap__Token: bootstrap,
      },
    },
  );
  children.push(app);
  app.stdout.on("data", (value) => (appOutput += value));
  app.stderr.on("data", (value) => (appOutput += value));
  await until(
    async () => {
      try {
        return (await fetch(base + "/api/health")).ok;
      } catch {
        return false;
      }
    },
    "isolated LogDesk app",
    30000,
  );
  const api = new Api(base);
  assert.equal((await api.session()).setupRequired, true);
  await api.request("/setup", {
    username: "wsladmin",
    password: adminPassword,
    setupToken: bootstrap,
  });
  await api.session();
  const host = await api.request("/hosts", {
    name: "WSL Ubuntu · 真实 SSH",
    address: "127.0.0.1",
    port: sshPort,
    username: account,
    password,
  });
  const unknown = await api.request(`/hosts/${host.id}/probe`, {});
  assert.equal(unknown.connected, false);
  assert.equal(unknown.fingerprint, pinned);
  await api.request(`/hosts/${host.id}/trust`, { fingerprint: pinned });
  const connected = await api.request(`/hosts/${host.id}/probe`, {});
  assert.equal(connected.connected, true, connected.message);
  pass(
    "SSH.NET host key pin matches actual OpenSSH key, trusted login succeeds",
  );
  const source = await api.request("/sources", {
    hostId: host.id,
    name: "WSL 实际日志目录",
    directory: remoteRoot + "/logs",
    pattern: "*.log",
    encoding: "utf-8",
  });
  const group = await api.request("/groups", {
    name: "WSL 实机验证",
    description: "真实 Linux 文件 · OpenSSH / SFTP / tail",
    sourceIds: [source.id],
  });
  await api.request(
    `/groups/${group.id}/scan`,
    { sourceIds: [source.id] },
    "POST",
    202,
  );
  let first;
  await until(async () => {
    first = await api.request(`/groups/${group.id}/files`);
    const failed = first.sources.find((item) => item.scan?.state === "failed");
    if (failed) throw new Error(JSON.stringify(failed));
    return first.sources.every((item) => item.scan?.state === "completed");
  }, "real SFTP scan");
  assert.equal(first.total, 253);
  assert.equal(first.files.length, 200);
  const second = await api.request(
    `/groups/${group.id}/files?cursor=${first.nextCursor}`,
  );
  assert.equal(second.files.length, 53);
  assert.equal(
    new Set([...first.files, ...second.files].map((file) => file.id)).size,
    253,
  );
  pass(
    "Real SFTP listing, glob filtering, symlink exclusion and keyset paging",
    { total: first.total, pages: [200, 53] },
  );
  const file = (
    await api.request(
      `/groups/${group.id}/files?q=${encodeURIComponent("api space's.log")}`,
    )
  ).files[0];
  const empty = (await api.request(`/groups/${group.id}/files?q=empty.log`))
    .files[0];
  const raw = await fetch(
    `${base}/api/groups/${group.id}/files/${file.id}/download`,
    { headers: { Cookie: api.cookie() } },
  );
  assert.equal(raw.status, 200);
  assert.deepEqual(
    Buffer.from(await raw.arrayBuffer()),
    Buffer.from("INFO 服务已启动 ✓\n"),
  );
  pass(
    "UTF-8 SFTP download bytes match the actual Linux file (space and apostrophe in filename)",
  );
  hub = new HubConnectionBuilder()
    .withUrl(base + "/hubs/logs", { headers: { Cookie: api.cookie() } })
    .configureLogging(LogLevel.None)
    .build();
  await hub.start();
  let acknowledged = false,
    emptyText = "",
    emptyError;
  const emptySubscription = hub.stream("Watch", group.id, empty.id).subscribe({
    next: (value) => {
      acknowledged = true;
      emptyText += value;
    },
    error: (error) => {
      emptyError = error;
    },
  });
  await until(() => {
    if (emptyError) throw emptyError;
    return acknowledged;
  }, "empty file connected");
  await wsl(
    `printf '%s\\n' 'empty became nonempty' >> ${remoteRoot}/logs/empty.log`,
  );
  await until(
    () => emptyText.includes("empty became nonempty"),
    "first output from initially empty file",
  );
  emptySubscription.dispose();
  await until(async () => !(await followerPids()), "empty follower cleanup");
  pass(
    "Initially empty file reports connected and streams its first appended line",
  );
  await exerciseFollower(group, file, pythonVersion + ' secure follower');

  // Read an existing system log as well; never write to or rotate system files.
  const existingLog = await ssh("if test -r /var/log/dpkg.log && test -s /var/log/dpkg.log; then printf /var/log/dpkg.log; elif test -r /var/log/dpkg.log.1 && test -s /var/log/dpkg.log.1; then printf /var/log/dpkg.log.1; fi");
  if (existingLog) {
    const systemSource = await api.request("/sources", {
      hostId: host.id,
      name: "WSL dpkg 系统日志",
      directory: "/var/log",
      pattern: existingLog.split('/').at(-1),
      encoding: "utf-8",
    });
    const systemGroup = await api.request("/groups", {
      name: "WSL 系统日志（只读验证）",
      description: "现有 dpkg.log，只读取",
      sourceIds: [systemSource.id],
    });
    await api.request(
      `/groups/${systemGroup.id}/scan`,
      { sourceIds: [systemSource.id] },
      "POST",
      202,
    );
    let systemPage;
    await until(async () => {
      systemPage = await api.request(`/groups/${systemGroup.id}/files`);
      return systemPage.sources.every(
        (item) => item.scan?.state === "completed",
      );
    }, "existing system log scan");
    assert.equal(systemPage.total, 1);
    const systemFile = systemPage.files[0];
    const hashBefore = (await wsl("sha256sum " + quote(existingLog))).split(
      /\s+/,
    )[0];
    const response = await fetch(
      `${base}/api/groups/${systemGroup.id}/files/${systemFile.id}/download`,
      { headers: { Cookie: api.cookie() } },
    );
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    const hashAfter = (await wsl("sha256sum " + quote(existingLog))).split(
      /\s+/,
    )[0];
    assert.equal(
      hashBefore,
      hashAfter,
      "System log changed while testing; retry with a stable log",
    );
    assert.equal(createHash("sha256").update(bytes).digest("hex"), hashBefore);
    const expectedTail = await ssh("tail -n 200 -- " + quote(existingLog));
    assert.ok(expectedTail.length, "Existing system log has content");
    let systemText = "",
      systemError;
    const systemSubscription = hub
      .stream("Watch", systemGroup.id, systemFile.id)
      .subscribe({
        next: (value) => (systemText += value),
        error: (error) => {
          systemError = error;
        },
      });
    try {
      await until(() => {
        if (systemError) throw systemError;
        return systemText.includes(expectedTail);
      }, "existing system log last 200 lines");
    } finally {
      systemSubscription.dispose();
    }
    await until(async () => !(await followerPids()), "system log follower cleanup");
    pass(
      "Existing " + existingLog + ": listing, full download SHA-256 and last 200 lines match Linux",
      { bytes: bytes.length },
    );
  }

  if (process.env.SKIP_BROWSER !== "1") {
    const { chromium } = require("@playwright/test");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 940 },
      locale: "zh-CN",
    });
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    await page.getByLabel("登录名", { exact: true }).fill("wsladmin");
    await page.getByLabel("密码", { exact: true }).fill(adminPassword);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("button", { name: "日志清单" }).click();
    // The inventory is virtualized: locate each filename using its search control.
    // Selection must survive changing the filter, even across separate pages.
    await page.getByLabel("搜索日志文件").fill("api space's.log");
    await page.getByLabel("选择 api space's.log").check();
    await page.getByLabel("搜索日志文件").fill("worker.log");
    await page.getByLabel("选择 worker.log").check();
    await page.getByRole("button", { name: "加入并阅读" }).click();
    await page
      .locator(".log-line")
      .getByText("INFO worker ready", { exact: true })
      .waitFor();
    await mutate(
      "with p.open('a', encoding='utf-8') as f: f.write('INFO 浏览器收到 WSL 实时追加 ✓\\n')",
    );
    await page
      .getByText("INFO 浏览器收到 WSL 实时追加 ✓", { exact: true })
      .waitFor();
    assert.equal(
      (await followerPids()).split("\n").filter(Boolean).length,
      2,
      await wsl(`ps -u ${account} -o pid=,comm=,args=`),
    );
    await page.screenshot({
      path: path.join(root, ".local/wsl-live-workspace.png"),
      fullPage: true,
    });
    await page.locator(".log-pane").first().getByRole("button", { name: /更多操作/ }).click();
    await page.getByRole("menuitem", { name: "停止接收", exact: true }).click();
    await until(
      async () => (await followerPids()).split("\n").filter(Boolean).length === 1,
      "browser independent stop",
    );
    assert.equal(await page.locator(".log-pane").count(), 2);
    assert.deepEqual(errors, []);
    await context.close();
    await browser.close();
    browser = null;
    await until(
      async () => !(await followerPids()),
      "browser close process cleanup",
    );
    pass(
      "Chromium: two real WSL log panes, live append and independent stop; zero page errors",
    );
  }
  if (process.env.WSL_LOAD === "1") {
    const connections = [], counts = Array(32).fill(0), partials = Array(32).fill(""), failures = [];
    const histogram = new Uint32Array(10001);
    try {
      for (let userIndex = 0; userIndex < 8; userIndex++) {
        const username = "wslviewer" + userIndex;
        const viewer = await api.request("/users", { username, displayName: username, password: "WslViewerTest123", role: "Viewer", enabled: true });
        await api.request(`/users/${viewer.id}/grants`, [{ scope: "host", resourceId: host.id, download: false, manage: false }, { scope: "group", resourceId: group.id, download: false, manage: false }], "PUT", 204);
        const client = new Api(base); await client.session(); await client.request("/login", { username, password: "WslViewerTest123" }); await client.session();
        for (let slot = 0; slot < 4; slot++) {
          const index = connections.length;
          const connection = new HubConnectionBuilder().withUrl(base + "/hubs/logs", { headers: { Cookie: client.cookie() } }).configureLogging(LogLevel.None).build();
          await connection.start(); let ready = false;
          connection.stream("WatchV2", group.id, file.id).subscribe({ next: frame => {
            if (frame.kind === "ready") ready = true;
            partials[index] += frame.text ?? "";
            let end;
            while ((end = partials[index].indexOf("\n")) >= 0) {
              const line = partials[index].slice(0, end); partials[index] = partials[index].slice(end + 1);
              const match = /^__wsl_seq=(\d+) __wsl_ts=(\d+)/.exec(line);
              if (match) {
                if (Number(match[1]) !== counts[index] + 1) failures.push("sequence gap at client " + index);
                counts[index]++;
                histogram[Math.max(0, Math.min(10000, Date.now() - Number(match[2])))]++;
              }
            }
          }, error: error => failures.push(String(error)) });
          connections.push(connection);
          await until(() => ready, "load subscriber ready");
        }
      }
      assert.equal((await followerPids()).split("\n").filter(Boolean).length, 1);
      const status = await api.request("/streams/status"); assert.equal(status.readers, 1); assert.equal(status.subscriptions, 32);
      const started = Date.now();
      await wsl("python3 - <<'PY'\nimport pathlib,time\np=pathlib.Path(" + JSON.stringify(remoteLog) + ")\nwith p.open('a',encoding='utf-8',buffering=1) as f:\n for batch in range(250):\n  lines=[]\n  for offset in range(20):\n   seq=batch*20+offset+1\n   lines.append('__wsl_seq=%d __wsl_ts=%d INFO 中文真实 Linux 压测'%(seq,int(time.time()*1000))+chr(10))\n  f.write(''.join(lines)); time.sleep(0.02)\nPY");
      await until(() => counts.every(count => count === 5000), "all 32 clients receive all 5000 real Linux lines", 15000);
      assert.deepEqual(failures, []);
      let seen = 0, p95 = 0;
      for (; p95 < histogram.length; p95++) { seen += histogram[p95]; if (seen >= 5000 * 32 * .95) break; }
      pass("Real WSL secure follower: 8 users, 32 subscriptions share 1 SSH reader; 5000 lines each without gaps", { totalDelivered: counts.reduce((a,b) => a+b, 0), p95Ms: p95, elapsedMs: Date.now() - started });
    } finally {
      for (const connection of connections) await connection.stop();
      await until(async () => !(await followerPids()), "load reader cleanup");
    }
  }
  await hub.stop();
  hub = null;
  const events = await api.request("/audit");
  for (const action of [
    "scan.completed",
    "download.completed",
    "stream.started",
    "stream.stopped",
  ]) {
    assert.ok(
      events.some((event) => event.action === action),
      action,
    );
  }
  assert.ok(!JSON.stringify(events).includes(password));
  pass(
    "Real WSL scan/download/stream audit events recorded without SSH password",
  );
} catch (error) {
  if (browser) {
    for (const context of browser.contexts())
      for (const page of context.pages())
        await page
          .screenshot({
            path: path.join(storage, "browser-failure.png"),
            fullPage: true,
          })
          .catch(() => {});
  }
  console.error("FAIL " + error.stack);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (hub) await hub.stop().catch(() => {});
  for (const child of children.reverse()) child.kill();
  if (setupAttempted) {
    try {
      await wsl(`if id ${account} >/dev/null 2>&1; then pkill -TERM -u ${account} || true; fi
if test -f ${remoteRoot}/sshd.pid; then
 pid=$(cat ${remoteRoot}/sshd.pid)
 if test -r /proc/$pid/cmdline && tr '\\0' ' ' < /proc/$pid/cmdline | grep -Fq '${remoteRoot}/sshd_config'; then kill "$pid" || true; fi
fi
if id ${account} >/dev/null 2>&1; then userdel ${account}; fi
test "$(readlink -m ${remoteRoot})" = '${remoteRoot}'
case '${remoteRoot}' in /var/tmp/logdesk-wsl-*) rm -rf -- '${remoteRoot}';; *) exit 1;; esac`);
      pass("Temporary WSL account, sshd and Linux files removed");
    } catch (error) {
      console.error("Cleanup failure: " + error.message);
      process.exitCode = 1;
    }
  }
  if (storage) {
    await writeFile(path.join(storage, "app.log"), appOutput);
    await writeFile(
      path.join(storage, "sshd.log"),
      sshdOutput.replaceAll(password, "[redacted]"),
    );
    await writeFile(
      path.join(storage, "result.json"),
      JSON.stringify(
        {
          date: new Date().toISOString(),
          passed: !process.exitCode,
          distro,
          metadata,
          results,
        },
        null,
        2,
      ),
    );
    console.log("Verification report: " + path.join(storage, "result.json"));
  }
}
