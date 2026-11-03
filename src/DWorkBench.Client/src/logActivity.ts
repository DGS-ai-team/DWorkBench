import {
  compilePattern,
  defaultLogSettings,
  type LogRow,
} from "./logProcessing";

export type WatchRule = {
  pattern: string;
  mode: "text" | "glob" | "regex";
  caseSensitive: boolean;
};
export const emptyWatchRule: WatchRule = {
  pattern: "",
  mode: "text",
  caseSensitive: false,
};
export type Activity = {
  since: number;
  received: number;
  matches: number;
  unseen: number;
  last: { id: number; text: string; at: number } | null;
  hit: { id: number; text: string; at: number } | null;
  rule: WatchRule;
  error: string;
};

// Fixed time buckets and short excerpts keep activity memory independent of log rate.
export class LogActivity {
  private buckets = new Map<number, { received: number; matches: number }>();
  private value: Activity;
  private matches: (text: string) => boolean = () => false;
  constructor(now = Date.now()) {
    this.value = {
      since: now,
      received: 0,
      matches: 0,
      unseen: 0,
      last: null,
      hit: null,
      rule: { ...emptyWatchRule },
      error: "",
    };
  }
  setRule(rule: WatchRule, now = Date.now()) {
    try {
      const matcher = compilePattern(
        rule.pattern,
        {
          ...defaultLogSettings,
          mode: rule.mode,
          caseSensitive: rule.caseSensitive,
        },
        false,
      );
      this.matches = matcher;
      this.buckets.clear();
      this.value = {
        ...this.value,
        since: now,
        received: 0,
        matches: 0,
        unseen: 0,
        hit: null,
        rule: { ...rule },
        error: "",
      };
    } catch (error) {
      this.value.error =
        "规则无效，继续使用上一次有效规则：" + (error as Error).message;
    }
  }
  add(row: LogRow, at: number, live: boolean) {
    const excerpt = { id: row.id, text: row.text.slice(0, 320), at };
    this.value.last = excerpt;
    if (!live) return;
    const second = Math.floor(at / 1000);
    const bucket = this.buckets.get(second) ?? { received: 0, matches: 0 };
    bucket.received++;
    if (this.matches(row.text)) {
      bucket.matches++;
      this.value.unseen++;
      this.value.hit = excerpt;
    }
    this.buckets.set(second, bucket);
    this.prune(at);
  }
  acknowledge() {
    this.value.unseen = 0;
  }
  reset(now = Date.now()) {
    const rule = this.value.rule;
    this.value.last = null;
    this.setRule(rule, now);
  }
  private prune(now: number) {
    const start = Math.floor(now / 1000) - 59;
    for (const second of this.buckets.keys())
      if (second < start) this.buckets.delete(second);
  }
  snapshot(now = Date.now()): Activity {
    this.prune(now);
    let received = 0,
      matches = 0;
    for (const bucket of this.buckets.values()) {
      received += bucket.received;
      matches += bucket.matches;
    }
    return { ...this.value, received, matches };
  }
}

export function ago(at: number | null, now = Date.now()) {
  if (!at) return "尚未收到数据";
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  return seconds < 5
    ? "刚刚"
    : seconds < 60
      ? `${seconds} 秒前`
      : seconds < 3600
        ? `${Math.floor(seconds / 60)} 分钟前`
        : seconds < 86400
          ? `${Math.floor(seconds / 3600)} 小时前`
          : `${Math.floor(seconds / 86400)} 天前`;
}
