import { useEffect, useRef, useState } from "react";
import {
  HubConnectionBuilder,
  LogLevel,
  type ISubscription,
} from "@microsoft/signalr";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Play,
  Pause,
  X,
  Download,
  Search,
  WrapText,
  Eraser,
  RotateCw,
  Copy,
  ChevronDown,
  SlidersHorizontal,
  Snowflake,
  PanelLeftClose,
  Pin,
} from "lucide-react";
import { type LogFile } from "./api";
import { download, ActionMenu } from "./ui";
import {
  defaultLogSettings,
  type LogRow,
  type LogSettings,
  type LogStats,
  type LogUpdate,
} from "./logProcessing";

import { ago, type Activity, type WatchRule } from "./logActivity";

const hub = new HubConnectionBuilder()
  .withUrl("/hubs/logs")
  .withAutomaticReconnect([0, 2000, 5000, 10000])
  .configureLogging(LogLevel.None)
  .build();
hub.onreconnecting(() =>
  window.dispatchEvent(new Event("logdesk-stream-disconnected")),
);
hub.onclose(() =>
  window.dispatchEvent(new Event("logdesk-stream-disconnected")),
);
let starting: Promise<void> | null = null;
async function connect() {
  if (hub.state === "Connected") return;
  if (!starting)
    starting = hub.start().finally(() => {
      starting = null;
    });
  await starting;
}
export async function disconnectLogs() {
  if (starting) await starting.catch(() => {});
  await hub.stop();
}
export type PaneDefinition = {
  key: string;
  groupId: string;
  file: LogFile;
  watchRule: WatchRule;
  settings: LogSettings;
  wrap: boolean;
  encoding: string;
  deferred: boolean;
  restoreIssue: string | null;
  startVersion: number;
};
export type SessionSummary = {
  activity: Activity | null;
  status: string;
  error: string;
  lastReceived: number | null;
  frozen: boolean;
};
export type SessionCommand = {
  id: number;
  type: "toggle" | "acknowledge" | "jump";
  rowId?: number;
};
type Frame = {
  kind: "ready" | "data" | "snapshot" | "notice";
  sequence: number;
  text: string;
  message?: string;
};
const emptyStats: LogStats = {
  total: 0,
  retained: 0,
  evicted: 0,
  truncated: 0,
  unknown: 0,
};

export function LogPane({
  pane,
  canPin,
  notify,
  visible,
  slot,
  active,
  onActivate,
  onHide,
  pinned,
  onPin,
  onSummary,
  command,
  onPreferences,
  onResume,
  resuming,
}: {
  visible: boolean;
  slot: number;
  active: boolean;
  pinned: boolean;
  onActivate: () => void;
  onHide: () => void;
  onPin: () => void;
  onSummary: (key: string, summary: SessionSummary) => void;
  command?: SessionCommand;
  pane: PaneDefinition;
  canPin: boolean;
  notify: (text: string) => void;
  onPreferences: (
    key: string,
    patch: { settings?: LogSettings; wrap?: boolean },
  ) => void;
  onResume: (key: string) => void;
  resuming: boolean;
}) {
  const [activity, setActivity] = useState<Activity | null>(null);
  const [highlightedId, setHighlightedId] = useState<number | null>(null);
  const lastReceived = useRef<number | null>(null),
    scrollAnchor = useRef<number | null>(null),
    restore = useRef(false),
    jump = useRef<number | null>(null);
  const viewReady = useRef(false),
    jumpRevision = useRef(0);
  const settings = pane.settings;
  const setSettings = (
    value: LogSettings | ((old: LogSettings) => LogSettings),
  ) =>
    onPreferences(pane.key, {
      settings: typeof value === "function" ? value(settings) : value,
    });
  const wrap = pane.wrap;
  const setWrap = (value: boolean | ((old: boolean) => boolean)) =>
    onPreferences(pane.key, {
      wrap: typeof value === "function" ? value(wrap) : value,
    });
  const [running, setRunning] = useState(!pane.deferred),
    [generation, setGeneration] = useState(0),
    [status, setStatus] = useState(pane.deferred ? "deferred" : "connecting");
  const [error, setError] = useState(""),
    [filterError, setFilterError] = useState(""),
    [notice, setNotice] = useState("");
  const [rows, setRows] = useState<LogRow[]>([]),
    [stats, setStats] = useState<LogStats>(emptyStats),
    [displayedRetained, setDisplayedRetained] = useState(0);
  const [follow, setFollow] = useState(true),
    [options, setOptions] = useState(false),
    [frozen, setFrozen] = useState(false);
  const frozenAt = useRef(0),
    pending = useRef<{ chunk: string; live: boolean; at: number }[]>([]),
    pendingSize = useRef(0),
    worker = useRef<Worker | null>(null),
    inFlight = useRef(false),
    epoch = useRef(0),
    revision = useRef(0);
  const freezeRequested = useRef(false);
  const restartNotice = useRef(false);
  const subscription = useRef<ISubscription<Frame> | undefined>(undefined),
    scrollRef = useRef<HTMLDivElement>(null),
    ignoreScrollUntil = useRef(0);
  const currentSettings = useRef(settings);
  currentSettings.current = settings;
  const virtual = useVirtualizer({
    enabled: visible,
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 21,
    overscan: 12,
    getItemKey: (index) => rows[index]?.id ?? index,
  });
  function change(patch: Partial<LogSettings>) {
    setSettings((old) => ({ ...old, ...patch }));
  }
  function stopWithError(message: string) {
    subscription.current?.dispose();
    setStatus("error");
    setError(message);
    setRunning(false);
  }

  useEffect(() => {
    const instance = new Worker(new URL("./log.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.current = instance;
    instance.onmessage = (
      event: MessageEvent<
        LogUpdate & {
          type: string;
          epoch: number;
          revision: number;
          displayedRetained: number;
          frozen: boolean;
          activity: Activity;
        }
      >,
    ) => {
      const value = event.data;
      if (value.type === "activity") {
        setActivity(value.activity);
        return;
      }
      if (value.type === "ack") {
        inFlight.current = false;
        return;
      }
      if (value.epoch !== epoch.current || value.revision !== revision.current)
        return;
      viewReady.current = true;
      setStats(value.stats);
      setDisplayedRetained(value.displayedRetained);
      setFilterError(value.error);
      setFrozen(value.frozen);
      setRows((old) => {
        if (value.reset) return value.rows;
        const first = old.findIndex((row) => row.id >= value.trimBefore);
        const retained = first < 0 ? [] : first === 0 ? old : old.slice(first);
        return value.rows.length ? retained.concat(value.rows) : retained;
      });
    };
    instance.onerror = () =>
      stopWithError("日志处理线程异常，请刷新页面后重试。");
    instance.postMessage({
      type: "settings",
      settings: currentSettings.current,
      epoch: epoch.current,
      revision: revision.current,
    });
    const timer = setInterval(() => {
      if (!pending.current.length || inFlight.current) return;
      inFlight.current = true;
      const segments = pending.current;
      pending.current = [];
      pendingSize.current = 0;
      instance.postMessage({ type: "append", segments, epoch: epoch.current });
    }, 40);
    return () => {
      clearInterval(timer);
      instance.terminate();
      worker.current = null;
    };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      revision.current++;
      worker.current?.postMessage({
        type: "settings",
        settings,
        epoch: epoch.current,
        revision: revision.current,
      });
    }, 150);
    return () => clearTimeout(timer);
  }, [settings]);

  useEffect(() => {
    if (pane.startVersion > 0) restartStream();
  }, [pane.startVersion]);

  useEffect(() => {
    if (!running) {
      setStatus((old) =>
        pane.deferred ? "deferred" : old === "error" ? old : "stopped",
      );
      return;
    }
    let alive = true,
      acknowledged = false;
    setStatus("connecting");
    setError("");
    setNotice("");
    const lost = () => {
      if (alive)
        stopWithError(
          "连接已中断。重新连接将读取最近快照，断线期间内容可能未显示。",
        );
    };
    window.addEventListener("logdesk-stream-disconnected", lost);
    connect()
      .then(() => {
        if (!alive) return;
        subscription.current = hub
          .stream<Frame>("WatchV2", pane.groupId, pane.file.id)
          .subscribe({
            next: (frame) => {
              if (!alive) return;
              if (!acknowledged) {
                acknowledged = true;
                setStatus("live");
                if (restartNotice.current) {
                  restartNotice.current = false;
                  setNotice(
                    "已重新读取最近快照；中断期间的记录可能未显示，统计重新开始。",
                  );
                }
              }
              if (frame.kind === "notice") {
                setNotice(frame.message ?? "快照内容已受容量限制。");
                return;
              }
              if (!frame.text) return;
              if (pendingSize.current + frame.text.length > 1_000_000) {
                pending.current = [];
                pendingSize.current = 0;
                stopWithError(
                  "日志接收超过当前页面处理能力，已停止此窗格以保护内存。请调整范围后重试；原始文件仍可下载。",
                );
                return;
              }
              lastReceived.current = Date.now();
              pendingSize.current += frame.text.length;
              pending.current.push({
                chunk: frame.text,
                live: frame.kind === "data",
                at: lastReceived.current,
              });
            },
            error: (value) => {
              if (alive)
                stopWithError(
                  String(value.message ?? value).replace(
                    /^.*HubException:\s*/,
                    "",
                  ),
                );
            },
            complete: () => {
              if (alive) {
                setStatus("stopped");
                setRunning(false);
              }
            },
          });
      })
      .catch(() => {
        if (alive) stopWithError("无法连接日志服务，请检查网络后重试。");
      });
    return () => {
      alive = false;
      subscription.current?.dispose();
      subscription.current = undefined;
      window.removeEventListener("logdesk-stream-disconnected", lost);
    };
  }, [running, generation, pane.groupId, pane.file.id]);

  useEffect(() => {
    virtual.measure();
  }, [wrap, settings]);
  useEffect(() => {
    if (!visible || !follow || frozen || !rows.length) return;
    const frame = requestAnimationFrame(() => {
      ignoreScrollUntil.current = Date.now() + 200;
      virtual.scrollToIndex(rows.length - 1, { align: "end" });
    });
    return () => cancelAnimationFrame(frame);
  }, [rows, follow, visible, frozen]);

  useEffect(() => {
    worker.current?.postMessage({ type: "visibility", visible });
    if (visible) {
      restore.current = true;
      viewReady.current = false;
    } else setOptions(false);
  }, [visible]);
  useEffect(() => {
    worker.current?.postMessage({ type: "watch-rule", rule: pane.watchRule });
  }, [pane.watchRule]);
  useEffect(() => {
    onSummary(pane.key, {
      activity,
      status,
      error: pane.restoreIssue || error,
      lastReceived: lastReceived.current,
      frozen,
    });
  }, [activity, status, error, frozen, onSummary, pane.key, pane.restoreIssue]);
  function toggleStream() {
    if (running) {
      setRunning(false);
      return;
    }
    if (!resuming) onResume(pane.key);
  }
  function restartStream() {
    restartNotice.current = true;
    clearDisplay();
    setRunning(true);
    setGeneration((value) => value + 1);
  }
  useEffect(() => {
    if (!command) return;
    if (command.type === "toggle") toggleStream();
    if (command.type === "acknowledge")
      worker.current?.postMessage({ type: "acknowledge" });
    if (command.type === "jump" && command.rowId) {
      jump.current = command.rowId;
      setHighlightedId(command.rowId);
      jumpRevision.current = revision.current + 1;
      freezeRequested.current = false;
      setFollow(false);
      setFrozen(false);
      change({ include: "", exclude: "", levels: "all", context: 0 });
      worker.current?.postMessage({ type: "freeze", frozen: false });
      notify("定位命中原文：已解除冻结并清除阅读筛选，关注规则保持生效。");
    }
  }, [command?.id]);
  useEffect(() => {
    if (
      !visible ||
      !viewReady.current ||
      (!rows.length && jump.current === null)
    )
      return;
    if (jump.current !== null && revision.current < jumpRevision.current)
      return;
    const id =
      jump.current ??
      (!follow && restore.current ? scrollAnchor.current : null);
    if (id === null) {
      restore.current = false;
      return;
    }
    const index = rows.findIndex((row) => row.id === id);
    if (
      index < 0 &&
      jump.current !== null &&
      (settings.include || settings.exclude || settings.levels !== "all")
    )
      return;
    if (index < 0) {
      setNotice(
        "目标记录已超出当前缓存或仍被格式规则筛除，可下载原始文件查看。",
      );
    } else
      requestAnimationFrame(() =>
        virtual.scrollToIndex(index, { align: "start" }),
      );
    jump.current = null;
    restore.current = false;
  }, [visible, rows, settings, follow]);

  function clearDisplay() {
    epoch.current++;
    pending.current = [];
    pendingSize.current = 0;
    lastReceived.current = null;
    jump.current = null;
    scrollAnchor.current = null;
    setRows([]);
    setHighlightedId(null);
    setStats(emptyStats);
    setFrozen(false);
    setFollow(true);
    freezeRequested.current = false;
    worker.current?.postMessage({ type: "clear", epoch: epoch.current });
  }
  function freezeDisplay() {
    frozenAt.current = stats.total;
    freezeRequested.current = !freezeRequested.current;
    setFollow(!freezeRequested.current);
    worker.current?.postMessage({
      type: "freeze",
      frozen: freezeRequested.current,
      epoch: epoch.current,
    });
  }
  const live = status === "live",
    filtered =
      !!settings.include || !!settings.exclude || settings.levels !== "all";
  if (!visible) return null;
  return (
    <section
      style={{ gridArea: slot === 0 ? "primary" : "secondary" }}
      onFocusCapture={onActivate}
      onPointerDown={onActivate}
      className={"log-pane " + (active ? "active-pane" : "")}
      aria-label={`${pane.file.name} · ${pane.file.hostName}`}
    >
      <header className="pane-head">
        <div className="pane-title">
          <span
            className={
              "status-dot " +
              (live ? "live" : status === "error" ? "failed" : "")
            }
          />
          <strong title={pane.file.path}>{pane.file.name}</strong>
          <span className="pane-host">
            {pane.file.hostName} / {pane.file.sourceName}
          </span>
        </div>
        <div className="pane-actions">
          <span
            className="receive-age"
            title="最近收到内容的时间；连接成功不代表文件持续写入"
          >
            {ago(lastReceived.current)}
          </span>
          {(canPin || pinned) && (
            <button
              className={"icon-button " + (pinned ? "active" : "")}
              aria-label={pinned ? "取消固定窗格" : "固定此窗格"}
              title={pinned ? "取消固定窗格" : "固定此窗格，切换时保留"}
              onClick={onPin}
            >
              <Pin size={14} />
            </button>
          )}
          <span className={"live-label " + (live ? "is-live" : "")}>
            {status === "connecting"
              ? "连接中"
              : live
                ? "已连接"
                : status === "error"
                  ? "连接异常"
                  : pane.deferred
                    ? "待恢复"
                    : "已停止"}
          </span>
          <button
            className={"icon-button " + (frozen ? "active" : "")}
            title={frozen ? "恢复实时显示" : "冻结显示，继续接收日志"}
            aria-label={frozen ? "恢复实时显示" : "冻结显示"}
            onClick={freezeDisplay}
          >
            <Snowflake size={15} />
          </button>
          <button
            className="icon-button"
            title="下载原始日志文件"
            aria-label="下载原始日志文件"
            disabled={pane.file.id <= 0 || !!pane.restoreIssue}
            onClick={() =>
              download(pane.groupId, pane.file)
                .then(() =>
                  notify("已交给浏览器下载，筛选不改变原始文件内容。"),
                )
                .catch((value) => notify(value.message))
            }
          >
            <Download size={15} />
          </button>
          <ActionMenu
            label={`${pane.file.name} 更多操作`}
            items={[
              {
                label: "自动换行",
                icon: <WrapText size={15} />,
                checked: wrap,
                action: () => setWrap((value) => !value),
              },
              {
                label: "复制当前显示的日志",
                icon: <Copy size={15} />,
                action: () => {
                  void navigator.clipboard
                    .writeText(rows.map((row) => row.text).join("\n"))
                    .then(
                      () => notify("已复制当前显示的日志。"),
                      () => notify("无法访问剪贴板，请使用 HTTPS 并授权。"),
                    );
                },
              },
              {
                label: "清空显示",
                icon: <Eraser size={15} />,
                action: clearDisplay,
              },
              {
                label: running
                  ? "停止接收"
                  : pane.deferred
                    ? "恢复接收"
                    : "继续接收",
                icon: running ? <Pause size={15} /> : <Play size={15} />,
                action: toggleStream,
              },
            ]}
          />
          <button
            className="icon-button close-pane"
            title={
              pane.deferred ? "收起到关注列表" : "收起到关注列表，继续接收"
            }
            aria-label={`收起 ${pane.file.name}`}
            onClick={onHide}
          >
            <PanelLeftClose size={16} />
          </button>
        </div>
      </header>
      <div className="pane-search">
        <Search size={13} />
        <input
          aria-label={`筛选 ${pane.file.name} 当前缓存`}
          title="仅筛选已接收并保留的日志，不搜索远端整个文件"
          placeholder={
            settings.mode === "glob"
              ? "筛选已接收日志 · *timeout*"
              : settings.mode === "regex"
                ? "筛选已接收日志 · timeout|失败"
                : "筛选已接收日志…"
          }
          value={settings.include}
          onChange={(event) => change({ include: event.target.value })}
          maxLength={512}
        />
        <select
          aria-label={`${pane.file.name} 匹配方式`}
          value={settings.mode}
          onChange={(event) =>
            change({ mode: event.target.value as LogSettings["mode"] })
          }
        >
          <option value="text">文本</option>
          <option value="glob">通配符</option>
          <option value="regex">正则</option>
        </select>
        {filtered && (
          <button
            className="text-button"
            aria-label="清除阅读筛选"
            onClick={() =>
              change({ include: "", exclude: "", levels: "all", context: 0 })
            }
          >
            清除
          </button>
        )}
        <span
          className="match-count"
          title="当前保留的日志；筛选仅作用于这些内容"
        >
          {filtered ? `${rows.length.toLocaleString()} / ` : ""}
          {displayedRetained.toLocaleString()} 行
        </span>
        <button
          className={"icon-button " + (options ? "active" : "")}
          title="筛选与格式设置"
          aria-label={`${pane.file.name} 筛选与格式设置`}
          aria-expanded={options}
          onClick={() => setOptions((value) => !value)}
        >
          <SlidersHorizontal size={14} />
        </button>
      </div>
      {options && (
        <div
          className="log-options"
          role="region"
          aria-label={`${pane.file.name} 筛选与格式设置`}
        >
          <div className="log-options-title">
            <strong>筛选与格式</strong>
            <button
              className="icon-button"
              aria-label="关闭筛选设置"
              onClick={() => setOptions(false)}
            >
              <X size={15} />
            </button>
          </div>
          <label className="option-check">
            <input
              type="checkbox"
              aria-label={`${pane.file.name} 区分大小写`}
              checked={settings.caseSensitive}
              onChange={(e) => change({ caseSensitive: e.target.checked })}
            />
            区分大小写
          </label>
          <label>
            排除模式
            <input
              aria-label={`${pane.file.name} 排除模式`}
              value={settings.exclude}
              maxLength={512}
              placeholder="例如健康检查或心跳"
              title="与包含条件使用相同匹配方式，排除条件优先"
              onChange={(event) => change({ exclude: event.target.value })}
            />
          </label>
          <div className="log-options-grid">
            <label>
              日志格式
              <select
                aria-label={`${pane.file.name} 日志格式`}
                value={settings.format}
                onChange={(event) =>
                  change({
                    format: event.target.value as LogSettings["format"],
                    levels:
                      event.target.value === "text" ? "all" : settings.levels,
                  })
                }
              >
                <option value="auto">自动识别明确等级</option>
                <option value="text">纯文本，不推断等级</option>
                <option value="json">JSON 字段</option>
                <option value="custom">自定义等级提取</option>
              </select>
            </label>
            {settings.format !== "text" && (
              <label>
                等级范围
                <select
                  aria-label={`${pane.file.name} 等级范围`}
                  value={settings.levels}
                  onChange={(event) =>
                    change({
                      levels: event.target.value as LogSettings["levels"],
                    })
                  }
                >
                  <option value="all">全部等级</option>
                  <option value="warnings">警告及错误</option>
                  <option value="errors">仅错误</option>
                  <option value="unknown">仅未识别</option>
                </select>
              </label>
            )}
          </div>
          {settings.format === "json" && (
            <label>
              JSON 等级字段
              <input
                aria-label={`${pane.file.name} JSON 等级字段`}
                value={settings.jsonField}
                maxLength={128}
                placeholder="例如 level、severity、log.level"
                onChange={(event) => change({ jsonField: event.target.value })}
              />
            </label>
          )}
          {settings.format === "custom" && (
            <label>
              等级提取正则
              <input
                aria-label={`${pane.file.name} 等级提取正则`}
                value={settings.levelPattern}
                maxLength={512}
                placeholder="例如 severity=(INFO|WARN|ERROR)，第 1 组为等级"
                onChange={(event) =>
                  change({ levelPattern: event.target.value })
                }
              />
            </label>
          )}
          <label>
            匹配行前后文
            <select
              aria-label={`${pane.file.name} 匹配行前后文`}
              value={settings.context}
              onChange={(event) =>
                change({ context: Number(event.target.value) })
              }
            >
              <option value={0}>不显示上下文</option>
              <option value={2}>前后各 2 行</option>
              <option value={5}>前后各 5 行</option>
              <option value={10}>前后各 10 行</option>
            </select>
          </label>
          {settings.mode === "glob" && <p>通配符匹配整行，例如 *timeout*。</p>}
          {(settings.mode === "regex" || settings.format === "custom") && (
            <p>正则不支持环视与反向引用。</p>
          )}
          <details className="filter-help">
            <summary>筛选与缓存说明</summary>
            <p>
              按行筛选当前保留的日志，不搜索远端文件；排除条件优先。最多保留
              10,000 行 / 200 万字符，超出后淘汰最早内容。未识别等级保持原色。
            </p>
          </details>
          <button
            className="text-button"
            onClick={() => setSettings({ ...defaultLogSettings })}
          >
            重置筛选与格式
          </button>
        </div>
      )}
      {(error || filterError) && (
        <div className="pane-error" role="alert">
          <span>{error || filterError}</span>
          {error && (
            <button disabled={resuming} onClick={() => onResume(pane.key)}>
              <RotateCw size={13} />
              重新连接
            </button>
          )}
        </div>
      )}
      {notice && (
        <div className="pane-notice">
          <span>{notice}</span>
          <button
            className="icon-button"
            aria-label="关闭快照提示"
            onClick={() => setNotice("")}
          >
            <X size={12} />
          </button>
        </div>
      )}
      {pane.deferred && (
        <div
          className={pane.restoreIssue ? "pane-error" : "pane-notice"}
          role={pane.restoreIssue ? "alert" : "status"}
        >
          <span>
            {pane.restoreIssue || "工作台已恢复，接收后将读取最近日志。"}
          </span>
          <button
            className="text-button"
            disabled={resuming}
            onClick={() => onResume(pane.key)}
          >
            {resuming
              ? "正在检查…"
              : pane.restoreIssue
                ? "重新检查"
                : "恢复接收"}
          </button>
        </div>
      )}
      {frozen && (
        <div className="pane-frozen">
          <Snowflake size={12} />
          {running ? "显示已冻结，继续接收" : "显示已冻结，接收已停止"} · 新收{" "}
          {Math.max(0, stats.total - frozenAt.current).toLocaleString()} 行
          <button className="text-button" onClick={freezeDisplay}>
            恢复实时显示
          </button>
        </div>
      )}
      <div
        className={"log-scroll " + (wrap ? "wrap" : "")}
        ref={scrollRef}
        onWheel={(event) => {
          if (event.deltaY < 0) setFollow(false);
        }}
        onPointerDown={() => setFollow(false)}
        onScroll={() => {
          const element = scrollRef.current;
          const first = virtual.getVirtualItemForOffset(
            element?.scrollTop ?? 0,
          );
          if (first && !restore.current)
            scrollAnchor.current = rows[first.index]?.id ?? null;
          if (
            element &&
            Date.now() > ignoreScrollUntil.current &&
            element.scrollHeight - element.scrollTop - element.clientHeight >
              120
          )
            setFollow(false);
        }}
      >
        {!rows.length ? (
          <div className="log-wait">
            {status === "connecting"
              ? "正在建立安全连接…"
              : filtered
                ? "当前缓冲中没有匹配的日志。"
                : live
                  ? "已连接，等待日志输出…"
                  : pane.deferred
                    ? "等待恢复接收"
                    : "接收已停止，可在更多菜单中继续接收。"}
          </div>
        ) : (
          <div
            className="virtual-lines"
            style={{ height: virtual.getTotalSize() }}
          >
            {virtual.getVirtualItems().map((row) => {
              const entry = rows[row.index];
              return (
                <div
                  key={row.key}
                  ref={virtual.measureElement}
                  data-index={row.index}
                  data-level={entry.level}
                  className={
                    "log-line " +
                    entry.level +
                    (entry.id === highlightedId ? " located-line" : "")
                  }
                  style={{ transform: `translateY(${row.start}px)` }}
                >
                  <span
                    className="line-number"
                    title="本次接收序号，筛选后保持不变"
                  >
                    {entry.id}
                  </span>
                  <span>{entry.text || " "}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {!follow && !frozen && rows.length > 0 && (
        <button className="follow-pill" onClick={() => setFollow(true)}>
          <ChevronDown size={14} />
          回到最新日志
        </button>
      )}
      {(stats.evicted > 0 || stats.truncated > 0) && (
        <footer className="pane-foot" aria-label="缓存状态">
          <span>
            {[
              stats.evicted
                ? `已淘汰 ${stats.evicted.toLocaleString()} 行`
                : "",
              stats.truncated ? `已截断 ${stats.truncated} 行` : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <span>可下载原始文件查看完整内容</span>
        </footer>
      )}
    </section>
  );
}
