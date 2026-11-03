import { RE2JS } from "re2js";

export type Level =
  | "unknown"
  | "trace"
  | "debug"
  | "info"
  | "notice"
  | "warn"
  | "error"
  | "fatal";
export type LogRow = { id: number; text: string; level: Level };
export type LogSettings = {
  include: string;
  exclude: string;
  mode: "text" | "glob" | "regex";
  caseSensitive: boolean;
  format: "auto" | "text" | "json" | "custom";
  jsonField: string;
  levelPattern: string;
  levels: "all" | "warnings" | "errors" | "unknown";
  context: number;
};
export const defaultLogSettings: LogSettings = {
  include: "",
  exclude: "",
  mode: "text",
  caseSensitive: false,
  format: "auto",
  jsonField: "level",
  levelPattern: "",
  levels: "all",
  context: 0,
};
export type LogStats = {
  total: number;
  retained: number;
  evicted: number;
  truncated: number;
  unknown: number;
};
export type LogUpdate = {
  reset: boolean;
  rows: LogRow[];
  trimBefore: number;
  stats: LogStats;
  error: string;
};
const MAX_LINES = 10_000,
  MAX_CHARACTERS = 2_000_000,
  MAX_LINE = 16_384;
type Test = (text: string) => boolean;
type Rules = { include: Test; exclude: Test; level: (text: string) => Level };

function normalizeLevel(value: unknown, field = ""): Level {
  field = (field.split(".").at(-1) ?? field).toLowerCase();
  if (typeof value === "string" && /^\d{1,3}$/.test(value))
    value = Number(value);
  if (typeof value === "number") {
    if (!Number.isInteger(value)) return "unknown";
    if (field === "severitynumber" && value >= 1 && value <= 24)
      return ["trace", "debug", "info", "warn", "error", "fatal"][
        Math.floor((value - 1) / 4)
      ] as Level;
    if (field === "loglevel" && value >= 0 && value <= 5)
      return ["trace", "debug", "info", "warn", "error", "fatal"][
        value
      ] as Level;
    if (field === "severity" || field === "priority")
      return (
        ([
          "fatal",
          "fatal",
          "fatal",
          "error",
          "warn",
          "notice",
          "info",
          "debug",
        ][value] as Level) ?? "unknown"
      );
    return (
      (
        {
          10: "trace",
          20: "debug",
          30: "info",
          40: "warn",
          50: "error",
          60: "fatal",
        } as Record<number, Level>
      )[value] ?? "unknown"
    );
  }
  if (typeof value !== "string") return "unknown";
  return (
    (
      {
        TRACE: "trace",
        T: "trace",
        DEBUG: "debug",
        D: "debug",
        INFO: "info",
        INFORMATION: "info",
        I: "info",
        NOTICE: "notice",
        WARN: "warn",
        WARNING: "warn",
        W: "warn",
        ERROR: "error",
        ERR: "error",
        E: "error",
        FATAL: "fatal",
        CRITICAL: "fatal",
        CRIT: "fatal",
        EMERG: "fatal",
        ALERT: "fatal",
        F: "fatal",
      } as Record<string, Level>
    )[value.trim().toUpperCase()] ?? "unknown"
  );
}

function fieldAt(object: unknown, field: string): unknown {
  let value = object;
  for (const part of field.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part))
      return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

// Only explicit JSON fields, syslog PRI, or a level at a conventional line prefix
// are inferred. A message containing the word "error" is not itself an ERROR event.
export function levelOf(
  text: string,
  settings: LogSettings,
  custom?: RE2JS,
): Level {
  if (settings.format === "text") return "unknown";
  if (settings.format === "custom") {
    const match = custom!.matcher(text);
    return match.find() ? normalizeLevel(match.group(1)) : "unknown";
  }
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const object = JSON.parse(trimmed);
      const fields =
        settings.format === "json"
          ? [settings.jsonField]
          : [
              "level",
              "severity",
              "log.level",
              "levelname",
              "logLevel",
              "LogLevel",
              "severityText",
              "SeverityText",
              "severityNumber",
              "SeverityNumber",
              "lvl",
              "priority",
            ];
      for (const field of fields) {
        const level = normalizeLevel(fieldAt(object, field), field);
        if (level !== "unknown") return level;
      }
    } catch {
      /* A partial or non-JSON line keeps a neutral color. */
    }
    return "unknown";
  }
  if (settings.format === "json") return "unknown";
  const pri = /^<(\d{1,3})>/.exec(trimmed);
  if (pri && Number(pri[1]) <= 191)
    return normalizeLevel(Number(pri[1]) % 8, "severity");
  const prefix =
    /^(?:(?:\d{4}[-/]\d{2}[-/]\d{2}[T ][0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)\s+)?(?:\[[^\]\r\n]{1,64}\]\s+)?\[?(TRACE|DEBUG|INFO|NOTICE|WARN(?:ING)?|ERROR|FATAL|CRITICAL|ERR|CRIT)\]?(?=\s|:|$)/i.exec(
      trimmed.slice(0, 256),
    );
  return prefix ? normalizeLevel(prefix[1]) : "unknown";
}

export function compilePattern(
  pattern: string,
  settings: LogSettings,
  empty: boolean,
): Test {
  if (pattern.length > 512) throw new Error("匹配模式不能超过 512 个字符。");
  if (!pattern) return () => empty;
  if (settings.mode === "text") {
    const needle = settings.caseSensitive ? pattern : pattern.toLowerCase();
    return (text) =>
      (settings.caseSensitive ? text : text.toLowerCase()).includes(needle);
  }
  const expression =
    settings.mode === "glob"
      ? "^" +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replaceAll("*", ".*")
          .replaceAll("?", ".") +
        "$"
      : pattern;
  const regex = RE2JS.compile(
    expression,
    settings.caseSensitive ? 0 : RE2JS.CASE_INSENSITIVE,
  );
  return (text) => regex.matcher(text).find();
}

function compile(settings: LogSettings): Rules {
  let custom: RE2JS | undefined;
  if (settings.format === "custom") {
    if (!settings.levelPattern || settings.levelPattern.length > 512)
      throw new Error(
        "请填写等级提取正则，最多 512 字符，用第 1 个捕获组提取等级。",
      );
    custom = RE2JS.compile(settings.levelPattern, RE2JS.CASE_INSENSITIVE);
    if (custom.groupCount() < 1)
      throw new Error(
        "等级提取正则需要第 1 个捕获组，例如 severity=(WARN|ERROR|INFO)。",
      );
  }
  if (settings.jsonField.length > 128)
    throw new Error("JSON 等级字段路径不能超过 128 个字符。");
  return {
    include: compilePattern(settings.include, settings, true),
    exclude: compilePattern(settings.exclude, settings, false),
    level: (text) => levelOf(text, settings, custom),
  };
}

export class LogBuffer {
  constructor(private readonly onRow?: (row: LogRow) => void) {}
  private ring: (LogRow | undefined)[] = new Array(MAX_LINES);
  private head = 0;
  private count = 0;
  private characters = 0;
  private partial = "";
  private skipLongLine = false;
  private sequence = 0;
  private evicted = 0;
  private truncated = 0;
  private unknown = 0;
  private settings = { ...defaultLogSettings };
  private rules = compile(this.settings);
  private pending: LogRow[] = [];
  private pendingCharacters = 0;
  private reset = true;
  private lastPublishedId = 0;
  private contextUntil = 0;
  private error = "";

  setSettings(input: LogSettings) {
    const settings = {
      ...input,
      context: Math.max(0, Math.min(10, Number(input.context) || 0)),
    };
    try {
      const rules = compile(settings);
      this.settings = settings;
      this.rules = rules;
      this.error = "";
      const entries = this.entries();
      this.unknown = 0;
      for (const row of entries) {
        row.level = rules.level(row.text);
        if (row.level === "unknown") this.unknown++;
      }
      this.pending = [];
      this.pendingCharacters = 0;
      this.lastPublishedId = 0;
      this.contextUntil = 0;
      this.reset = true;
      for (let index = 0; index < entries.length; index++)
        this.select(
          entries[index],
          entries.slice(Math.max(0, index - settings.context), index),
        );
      return true;
    } catch (error) {
      this.error =
        "条件无效，仍按上一次有效规则显示：" + String((error as Error).message);
      this.resetView();
      return false;
    }
  }

  clear() {
    this.ring = new Array(MAX_LINES);
    this.head =
      this.count =
      this.characters =
      this.sequence =
      this.evicted =
      this.truncated =
      this.unknown =
        0;
    this.partial = "";
    this.skipLongLine = false;
    this.pending = [];
    this.pendingCharacters = 0;
    this.reset = true;
    this.lastPublishedId = this.contextUntil = 0;
  }

  resetView() {
    const entries = this.entries();
    this.pending = [];
    this.pendingCharacters = 0;
    this.lastPublishedId = this.contextUntil = 0;
    this.reset = true;
    for (let index = 0; index < entries.length; index++)
      this.select(
        entries[index],
        entries.slice(Math.max(0, index - this.settings.context), index),
      );
  }
  clone() {
    const copy = new LogBuffer();
    copy.ring = this.ring.map((row) => (row ? { ...row } : undefined));
    copy.head = this.head;
    copy.count = this.count;
    copy.characters = this.characters;
    copy.sequence = this.sequence;
    copy.evicted = this.evicted;
    copy.truncated = this.truncated;
    copy.unknown = this.unknown;
    copy.settings = this.settings;
    copy.rules = this.rules;
    copy.error = this.error;
    copy.resetView();
    return copy;
  }

  ingest(chunk: string) {
    const text = this.partial + chunk;
    this.partial = "";
    let start = 0,
      end;
    while ((end = text.indexOf("\n", start)) >= 0) {
      if (this.skipLongLine) this.skipLongLine = false;
      else this.add(text.slice(start, end).replace(/\r$/, ""));
      start = end + 1;
    }
    const rest = text.slice(start);
    if (!this.skipLongLine) {
      if (rest.length > MAX_LINE) {
        this.add(rest);
        this.skipLongLine = true;
      } else this.partial = rest;
    }
  }

  private entries(): LogRow[] {
    return Array.from(
      { length: this.count },
      (_, index) => this.ring[(this.head + index) % MAX_LINES]!,
    );
  }
  private firstId() {
    return this.count ? this.ring[this.head]!.id : this.sequence + 1;
  }
  private removeFirst() {
    const row = this.ring[this.head]!;
    this.characters -= row.text.length;
    if (row.level === "unknown") this.unknown--;
    this.ring[this.head] = undefined;
    this.head = (this.head + 1) % MAX_LINES;
    this.count--;
    this.evicted++;
  }
  private add(text: string) {
    if (text.length > MAX_LINE) {
      text = text.slice(0, MAX_LINE) + " … [超长行已截断]";
      this.truncated++;
    }
    while (
      this.count >= MAX_LINES ||
      (this.count && this.characters + text.length > MAX_CHARACTERS)
    )
      this.removeFirst();
    const row: LogRow = {
      id: ++this.sequence,
      text,
      level: this.rules.level(text),
    };
    const previous: LogRow[] = [];
    for (
      let index = Math.max(0, this.count - this.settings.context);
      index < this.count;
      index++
    )
      previous.push(this.ring[(this.head + index) % MAX_LINES]!);
    this.ring[(this.head + this.count) % MAX_LINES] = row;
    this.count++;
    this.characters += text.length;
    if (row.level === "unknown") this.unknown++;
    this.select(row, previous);
    this.onRow?.(row);
    if (
      this.pending.length > MAX_LINES * 2 ||
      this.pendingCharacters > MAX_CHARACTERS * 2
    ) {
      this.pending = this.pending.filter((entry) => entry.id >= this.firstId());
      this.pendingCharacters = this.pending.reduce(
        (sum, entry) => sum + entry.text.length,
        0,
      );
    }
  }
  private select(row: LogRow, previous: LogRow[]) {
    const allowedLevel =
      this.settings.levels === "all" ||
      (this.settings.levels === "unknown"
        ? row.level === "unknown"
        : this.settings.levels === "errors"
          ? ["error", "fatal"].includes(row.level)
          : ["warn", "error", "fatal"].includes(row.level));
    const excluded = this.rules.exclude(row.text);
    const hit = !excluded && allowedLevel && this.rules.include(row.text);
    if (hit) {
      for (const before of previous)
        if (
          before.id > this.lastPublishedId &&
          !this.rules.exclude(before.text)
        ) {
          this.pending.push(before);
          this.pendingCharacters += before.text.length;
          this.lastPublishedId = before.id;
        }
      this.contextUntil = row.id + this.settings.context;
    }
    if (
      !excluded &&
      (hit || row.id <= this.contextUntil) &&
      row.id > this.lastPublishedId
    ) {
      this.pending.push(row);
      this.pendingCharacters += row.text.length;
      this.lastPublishedId = row.id;
    }
  }
  drain(): LogUpdate {
    const result = {
      reset: this.reset,
      rows: this.pending.filter((row) => row.id >= this.firstId()),
      trimBefore: this.firstId(),
      stats: {
        total: this.sequence,
        retained: this.count,
        evicted: this.evicted,
        truncated: this.truncated,
        unknown: this.unknown,
      },
      error: this.error,
    };
    this.pending = [];
    this.pendingCharacters = 0;
    this.reset = false;
    return result;
  }
}
