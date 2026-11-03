import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
export const root = process.cwd();
export const require = createRequire(
  path.join(root, "src/LogDesk.Client/package.json"),
);
const { Server } = require("ssh2");
export const { HubConnectionBuilder, LogLevel } = require("@microsoft/signalr");
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(check, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(50);
  }
  throw Error("Timed out: " + label);
}
export async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

export class Api {
  cookies = new Map();
  csrf = "";
  constructor(base) {
    this.base = base;
  }
  cookie() {
    return [...this.cookies].map(([k, v]) => k + "=" + v).join("; ");
  }
  async request(
    route,
    body,
    method = body === undefined ? "GET" : "POST",
    status = 200,
  ) {
    const r = await fetch(this.base + "/api" + route, {
      method,
      headers: {
        Cookie: this.cookie(),
        "X-CSRF-Token": this.csrf,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const raw of r.headers.getSetCookie()) {
      const [k, ...v] = raw.split(";")[0].split("=");
      this.cookies.set(k, v.join("="));
    }
    const text = await r.text();
    assert.equal(r.status, status, route + ": " + text);
    return text ? JSON.parse(text) : null;
  }
  async session() {
    const value = await this.request("/session");
    this.csrf = value.csrfToken;
    return value;
  }
  async login(username, password) {
    await this.session();
    await this.request("/login", { username, password });
    await this.session();
  }
}

export async function startApp(label, dll) {
  await mkdir(path.join(root, ".local"), { recursive: true });
  const storage = await mkdtemp(path.join(root, ".local/" + label + "-"));
  const base = "http://127.0.0.1:" + (await freePort());
  const dotnet =
    process.env.DOTNET_EXE ??
    path.join(
      root,
      ".tools/dotnet",
      process.platform === "win32" ? "dotnet.exe" : "dotnet",
    );
  const child = spawn(
    dotnet,
    [
      dll ??
        process.env.TEST_SERVER_DLL ??
        path.join(
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
        Storage__Root: storage,
        Database__Provider: process.env.TEST_DATABASE_PROVIDER ?? "Sqlite",
        Bootstrap__Token: "load-test-only-" + label,
      },
    },
  );
  let output = "";
  child.stdout.on("data", (v) => (output += v));
  child.stderr.on("data", (v) => (output += v));
  await until(
    async () => {
      try {
        return (await fetch(base + "/api/health")).ok;
      } catch {
        return false;
      }
    },
    "app " + label,
    30000,
  ).catch(() => {
    throw Error(output);
  });
  const admin = new Api(base);
  await admin.session();
  await admin.request("/setup", {
    username: "admin",
    password: "LoadTestAdmin123",
    setupToken: "load-test-only-" + label,
  });
  await admin.session();
  return {
    base,
    storage,
    child,
    admin,
    close: async () => {
      child.kill();
      await writeFile(path.join(storage, "server.log"), output);
    },
  };
}

export async function sshFixture(name = "bench.log") {
  const key = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
  const directory = "/var/log/bench",
    filename = directory + "/" + name;
  const contents = Buffer.from("INFO benchmark ready\n");
  const connections = new Set(),
    sessions = new Set();
  let timer,
    rate = 0,
    seq = 0,
    bytes = 0,
    sshBytes = 0,
    starts = 0,
    upstreamSlow = 0,
    history = [];
  function setRate(next) {
    clearInterval(timer);
    rate = next;
    if (!rate) return;
    const began = Date.now();
    let emitted = 0;
    timer = setInterval(() => {
      const due = Math.min(
        5000,
        Math.floor(((Date.now() - began) * rate) / 1000) - emitted,
      );
      if (due <= 0) return;
      const at = Date.now(),
        lines = [];
      for (let i = 0; i < due; i++) {
        const number = ++seq;
        const body = `__seq=${number} __ts=${at} trace_id=${number % 100 === 0 ? "keep" : "drop"} duration_ms=${number % 500} 中文压测日志 ${"x".repeat(48)}`;
        lines.push(
          number % 4 === 0
            ? JSON.stringify({
                level: number % 20 === 0 ? 50 : 30,
                msg: body,
              }) + "\n"
            : number % 4 === 1
              ? new Date(at).toISOString() + " INFO [bench] " + body + "\n"
              : number % 4 === 2
                ? "unstructured ERROR in message " + body + "\n"
                : "time=" + at + " severity=WARN " + body + "\n",
        );
      }
      history = history.concat(lines).slice(-200);
      const payload = lines.join("");
      emitted += due;
      bytes += Buffer.byteLength(payload);
      for (const stream of sessions) {
        if (stream.writableLength > 512 * 1024) {
          upstreamSlow++;
          stream.close();
          continue;
        }
        stream.write(payload);
        sshBytes += Buffer.byteLength(payload);
      }
    }, 20);
  }
  const server = new Server({ hostKeys: [key] }, (client) => {
    connections.add(client);
    client.on("error", () => {});
    client.on("close", () => connections.delete(client));
    client.on("authentication", (ctx) =>
      ctx.method === "password" &&
      ctx.username === "reader" &&
      ctx.password === "LoadFixtureSecret123"
        ? ctx.accept()
        : ctx.reject(["password"]),
    );
    client.on("ready", () =>
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (accept, reject, info) => {
          if (info.command !== `tail -n 200 -F -- '${filename}'`)
            return reject();
          const stream = accept();
          starts++;
          sessions.add(stream);
          stream.write(history.length ? history.join("") : contents);
          const close = () => {
            sessions.delete(stream);
            client.off("close", close);
          };
          stream.on("close", close);
          stream.on("error", close);
          client.on("close", close);
          stream.on("signal", () => {
            close();
            stream.exit(0);
            stream.end();
          });
        });
        session.on("sftp", (accept) => {
          const s = accept(),
            handles = new Map();
          let next = 1;
          const attrs = (p) => ({
            mode: p === directory ? 0o040755 : 0o100644,
            size: contents.length,
            uid: 1000,
            gid: 1000,
            atime: Math.floor(Date.now() / 1000),
            mtime: Math.floor(Date.now() / 1000),
          });
          const handle = (value) => {
            const b = Buffer.alloc(4);
            b.writeUInt32BE(next++);
            handles.set(b.toString("hex"), value);
            return b;
          };
          s.on("REALPATH", (id, p) =>
            s.name(id, [{ filename: p, longname: p, attrs: attrs(p) }]),
          );
          for (const cmd of ["STAT", "LSTAT"])
            s.on(cmd, (id, p) =>
              p === directory || p === filename
                ? s.attrs(id, attrs(p))
                : s.status(id, 2),
            );
          s.on("OPENDIR", (id, p) =>
            p === directory
              ? s.handle(id, handle({ directory: true, done: false }))
              : s.status(id, 2),
          );
          s.on("READDIR", (id, h) => {
            const value = handles.get(h.toString("hex"));
            if (!value || value.done) return s.status(id, 1);
            value.done = true;
            s.name(id, [
              {
                filename: name,
                longname: name,
                attrs: attrs(filename),
              },
            ]);
          });
          s.on("OPEN", (id, p) =>
            p === filename
              ? s.handle(id, handle({ file: true }))
              : s.status(id, 2),
          );
          s.on("READ", (id, h, offset, len) =>
            offset >= contents.length
              ? s.status(id, 1)
              : s.data(id, contents.subarray(offset, offset + len)),
          );
          s.on("CLOSE", (id, h) => {
            handles.delete(h.toString("hex"));
            s.status(id, 0);
          });
          s.on("EXTENDED", (id) => s.status(id, 8));
        });
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    directory,
    filename,
    setRate,
    disconnect: () => { for (const client of connections) client.end(); },
    get seq() {
      return seq;
    },
    get bytes() {
      return bytes;
    },
    get sshBytes() {
      return sshBytes;
    },
    get active() {
      return sessions.size;
    },
    get starts() {
      return starts;
    },
    get upstreamSlow() {
      return upstreamSlow;
    },
    close: async () => {
      clearInterval(timer);
      for (const c of connections) c.end();
      await new Promise((r) => server.close(r));
    },
  };
}

export async function configure(app, fixture) {
  const host = await app.admin.request("/hosts", {
    name: "isolated-load-fixture",
    address: "127.0.0.1",
    port: fixture.port,
    username: "reader",
    password: "LoadFixtureSecret123",
  });
  const probe = await app.admin.request(`/hosts/${host.id}/probe`, {});
  assert.ok(probe.fingerprint);
  await app.admin.request(`/hosts/${host.id}/trust`, {
    fingerprint: probe.fingerprint,
  });
  const source = await app.admin.request("/sources", {
    name: "压测日志",
    hostId: host.id,
    directory: fixture.directory,
    pattern: path.posix.basename(fixture.filename),
    encoding: "utf-8",
  });
  const group = await app.admin.request("/groups", {
    name: "隔离压测",
    description: "仅模拟日志，不连接用户主机",
    sourceIds: [source.id],
  });
  await app.admin.request(
    `/groups/${group.id}/scan`,
    { sourceIds: [source.id] },
    "POST",
    202,
  );
  let page;
  await until(async () => {
    page = await app.admin.request(`/groups/${group.id}/files`);
    return (
      page.files.length &&
      page.sources.every((s) => s.scan?.state === "completed")
    );
  }, "scan");
  return { host, source, group, file: page.files[0] };
}

export async function viewer(app, target, index) {
  const username = "loaduser" + index,
    password = "LoadViewer123";
  const user = await app.admin.request("/users", {
    username,
    password,
    displayName: username,
    role: "Viewer",
    enabled: true,
  });
  await app.admin.request(
    `/users/${user.id}/grants`,
    [
      {
        scope: "host",
        resourceId: target.host.id,
        download: false,
        manage: false,
      },
      {
        scope: "group",
        resourceId: target.group.id,
        download: false,
        manage: false,
      },
    ],
    "PUT",
    204,
  );
  const api = new Api(app.base);
  await api.login(username, password);
  return { api, user };
}
