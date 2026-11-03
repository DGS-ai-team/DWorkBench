import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Search,
  RefreshCw,
  FolderOpen,
  ArrowUpRight,
  Download,
  Server,
  ChevronDown,
  FileText,
  Clock,
  AlertCircle,
} from "lucide-react";
import {
  api,
  date,
  size,
  type Config,
  type Group,
  type LogFile,
  type FilePage,
} from "./api";
import { ago } from "./logActivity";
import { Modal, Spinner, Empty, download } from "./ui";

export function Inventory({
  group,
  config,
  close,
  open,
  available,
  notify,
  tracked,
  reading,
  locate,
}: {
  group: Group;
  config: Config;
  close: () => void;
  open: (files: LogFile[], read?: boolean) => void;
  tracked: LogFile[];
  reading: LogFile[];
  locate: (file: LogFile) => void;
  available: number;
  notify: (text: string) => void;
}) {
  const [sourceQuery, setSourceQuery] = useState("");
  const [scopeOpen, setScopeOpen] = useState(false),
    [scanPending, setScanPending] = useState(false);
  function same(a: LogFile, b: LogFile) {
    return (
      a.hostId === b.hostId &&
      a.path === b.path &&
      config.sources.find((s) => s.id === a.sourceId)?.encoding ===
        config.sources.find((s) => s.id === b.sourceId)?.encoding
    );
  }
  const sources = config.sources.filter((s) => group.sourceIds.includes(s.id));
  const [scope, setScope] = useState(group.sourceIds),
    [q, setQ] = useState(""),
    [host, setHost] = useState(""),
    [sourceFilter, setSourceFilter] = useState(""),
    [period, setPeriod] = useState(""),
    [data, setData] = useState<FilePage | null>(null);
  const [selected, setSelected] = useState<Map<number, LogFile>>(new Map()),
    [busy, setBusy] = useState(true),
    [error, setError] = useState("");
  const selectedNew = [...selected.values()]
    .filter((f) => !tracked.some((t) => same(t, f)))
    .filter(
      (f, index, all) => all.findIndex((other) => same(other, f)) === index,
    ).length;
  const parent = useRef<HTMLDivElement>(null),
    version = useRef(0),
    debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const virtual = useVirtualizer({
    count: data?.files.length ?? 0,
    getScrollElement: () => parent.current,
    estimateSize: () => 48,
    overscan: 8,
  });
  async function load(more = false) {
    const n = ++version.current;
    setBusy(true);
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (host) params.set("hostId", host);
    if (sourceFilter) params.set("sourceId", sourceFilter);
    if (period)
      params.set("since", String(Date.now() - Number(period) * 86_400_000));
    if (more && data?.nextCursor) params.set("cursor", data.nextCursor);
    try {
      const value = await api<FilePage>(`/groups/${group.id}/files?${params}`);
      if (n !== version.current) return;
      setData((old) =>
        more && old
          ? { ...value, files: old.files.concat(value.files) }
          : value,
      );
      setError("");
    } catch (e) {
      if (n === version.current) setError((e as Error).message);
    } finally {
      if (n === version.current) setBusy(false);
    }
  }
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void load(), 200);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
      version.current++;
    };
  }, [q, host, sourceFilter, period, group.id]);
  const scanning =
    data?.sources.some(
      (s) => s.scan?.state === "scanning" || s.scan?.state === "queued",
    ) ?? false;
  useEffect(() => {
    if (!scanning) return;
    const timer = setInterval(() => void load(), 1500);
    return () => clearInterval(timer);
  }, [scanning, q, host, sourceFilter, period]);
  const scanErrors =
    data?.sources
      .filter((s) => s.scan?.error || s.lastScanError)
      .map((s) => `${s.id}:${s.scan?.error || s.lastScanError}`)
      .join("|") ?? "";
  useEffect(() => {
    if (scanErrors) setScopeOpen(true);
  }, [scanErrors]);
  async function scan() {
    if (!scope.length) {
      notify("请选择至少一个日志源。");
      return;
    }
    setScanPending(true);
    try {
      await api(`/groups/${group.id}/scan`, { sourceIds: scope });
      await load();
    } catch (e) {
      setError((e as Error).message);
      setScopeOpen(true);
    } finally {
      setScanPending(false);
    }
  }
  function select(file: LogFile) {
    setSelected((old) => {
      const next = new Map(old);
      next.has(file.id) ? next.delete(file.id) : next.set(file.id, file);
      return next;
    });
  }
  return (
    <Modal title="日志清单" close={close} drawer>
      <div className="drawer-subtitle">
        <span>{group.name}</span>
        <div className="inventory-refresh">
          {scanErrors && (
            <button
              className="text-button error-text"
              onClick={() => setScopeOpen(true)}
            >
              部分来源刷新失败
            </button>
          )}
          <button
            className="button secondary"
            disabled={busy || scanning || scanPending || !scope.length}
            onClick={() => void scan()}
          >
            <RefreshCw
              size={14}
              className={scanning || scanPending ? "spin" : ""}
            />
            {scanning || scanPending
              ? "正在刷新"
              : scope.length === sources.length
                ? "刷新清单"
                : `刷新 ${scope.length} 个来源`}
          </button>
          <button
            className="icon-button"
            title="选择刷新范围"
            aria-label="选择刷新范围"
            aria-expanded={scopeOpen}
            onClick={() => setScopeOpen((v) => !v)}
          >
            <ChevronDown size={16} />
          </button>
        </div>
      </div>
      <div className="inventory-body">
        <aside
          className="source-sidebar"
          hidden={!scopeOpen}
          aria-label="刷新范围"
        >
          <div className="section-label">
            刷新范围{" "}
            <span>
              {scope.length} / {sources.length}
            </span>
          </div>
          {sources.length > 8 && (
            <input
              className="source-search"
              aria-label="搜索扫描来源"
              placeholder="搜索来源或主机…"
              value={sourceQuery}
              onChange={(e) => setSourceQuery(e.target.value)}
            />
          )}
          {sources
            .filter((s) =>
              `${s.name} ${config.hosts.find((h) => h.id === s.hostId)?.name}`
                .toLowerCase()
                .includes(sourceQuery.toLowerCase()),
            )
            .map((source) => {
              const server = config.hosts.find((h) => h.id === source.hostId);
              const state =
                data?.sources.find((s) => s.id === source.id) ?? source;
              const active =
                state.scan?.state === "scanning" ||
                state.scan?.state === "queued";
              return (
                <label
                  key={source.id}
                  className={
                    "source-card " +
                    (scope.includes(source.id) ? "selected" : "")
                  }
                >
                  <div>
                    <input
                      type="checkbox"
                      checked={scope.includes(source.id)}
                      onChange={() =>
                        setScope((old) =>
                          old.includes(source.id)
                            ? old.filter((x) => x !== source.id)
                            : old.concat(source.id),
                        )
                      }
                    />
                    <strong>{source.name}</strong>
                    {active && <Spinner />}
                  </div>
                  <small>
                    <Server size={11} />
                    {server?.name}
                  </small>
                  <code title={source.directory}>{source.directory}</code>
                  <span
                    className={
                      "source-status " +
                      (state.scan?.error || state.lastScanError ? "error" : "")
                    }
                  >
                    {active
                      ? `${state.scan?.state === "queued" ? "排队中" : "扫描中"} · ${state.scan?.count ?? 0} 项`
                      : state.scan?.error ||
                        state.lastScanError ||
                        (state.lastScanAt
                          ? `清单更新于 ${ago(state.lastScanAt)}`
                          : "尚未扫描")}
                  </span>
                </label>
              );
            })}
        </aside>
        <div className="inventory-main">
          <div className="inventory-filters">
            <label className="search-field">
              <Search size={15} />
              <input
                aria-label="搜索日志文件"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜索文件名…"
              />
            </label>
            <select
              aria-label="筛选主机"
              value={host}
              onChange={(e) => setHost(e.target.value)}
            >
              <option value="">全部主机</option>
              {config.hosts
                .filter((h) => sources.some((s) => s.hostId === h.id))
                .map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
            </select>
            <select
              aria-label="筛选日志源"
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
            >
              <option value="">全部来源</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <select
              aria-label="筛选修改时间"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
            >
              <option value="">全部时间</option>
              <option value="1">最近 24 小时</option>
              <option value="7">最近 7 天</option>
              <option value="30">最近 30 天</option>
            </select>
          </div>
          <div className="inventory-summary">
            <span>{data?.total.toLocaleString() ?? "—"} 个文件</span>
            <span>
              {busy ? (
                <Spinner />
              ) : (
                <>
                  <Clock size={12} />
                  <span
                    title={data?.sources
                      .map((s) => date(s.lastScanAt))
                      .join(" / ")}
                  >
                    清单快照 ·{" "}
                    {data?.sources.some((s) => !s.lastScanAt)
                      ? "部分来源未扫描"
                      : `最早更新 ${ago(Math.min(...(data?.sources.map((s) => s.lastScanAt!) ?? [])))}`}
                  </span>
                </>
              )}
            </span>
          </div>
          {error && (
            <div className="alert error">
              <AlertCircle size={15} />
              {error}
            </div>
          )}
          <div className="file-table-head">
            <input
              type="checkbox"
              aria-label="选择当前已加载文件"
              checked={
                !!data?.files.length &&
                data.files.every((f) => selected.has(f.id))
              }
              onChange={() =>
                setSelected((old) => {
                  const next = new Map(old);
                  const all = data?.files.every((f) => next.has(f.id));
                  data?.files.forEach((f) =>
                    all ? next.delete(f.id) : next.set(f.id, f),
                  );
                  return next;
                })
              }
            />
            <span>文件名 / 来源</span>
            <span title="按修改时间从新到旧排列">修改时间 ↓</span>
            <span>大小</span>
            <span />
          </div>
          <div className="file-table-scroll" ref={parent}>
            {!data?.files.length ? (
              <Empty
                icon={<FolderOpen size={25} />}
                title={busy ? "正在读取清单" : "还没有匹配的日志"}
              >
                {q || host || sourceFilter || period
                  ? "调整筛选条件，或重新扫描日志源。"
                  : "点击刷新清单，获取所选来源的日志文件。"}
              </Empty>
            ) : (
              <div
                style={{ height: virtual.getTotalSize(), position: "relative" }}
              >
                {virtual.getVirtualItems().map((row) => {
                  const file = data.files[row.index];
                  const watching = tracked.some((t) => same(t, file)),
                    viewing = reading.some((t) => same(t, file));
                  return (
                    <div
                      role="row"
                      key={file.id}
                      className={
                        "file-table-row " +
                        (selected.has(file.id) ? "selected" : "")
                      }
                      style={{
                        height: row.size,
                        transform: `translateY(${row.start}px)`,
                      }}
                      onDoubleClick={() => open([file])}
                    >
                      <input
                        type="checkbox"
                        aria-label={`选择 ${file.name}`}
                        checked={selected.has(file.id)}
                        onChange={() => select(file)}
                      />
                      <div className="file-name">
                        <strong title={file.path}>
                          <FileText size={14} />
                          {file.name}
                          {watching && (
                            <button
                              className="badge file-locate"
                              title="定位到阅读窗格"
                              onClick={() => locate(file)}
                            >
                              {viewing ? "阅读中" : "已关注"} ↗
                            </button>
                          )}
                        </strong>
                        <small>
                          {file.hostName} / {file.sourceName}
                        </small>
                      </div>
                      <time>{date(file.modifiedAt)}</time>
                      <span className="mono muted">{size(file.size)}</span>
                      <button
                        className="icon-button"
                        title={`下载 ${file.name}`}
                        aria-label={`下载 ${file.name}`}
                        onClick={() =>
                          download(group.id, file)
                            .then(() => notify("下载已交给浏览器。"))
                            .catch((e) => notify(e.message))
                        }
                      >
                        <Download size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {data?.nextCursor && (
            <button
              className="load-more"
              disabled={busy}
              onClick={() => void load(true)}
            >
              {busy ? <Spinner /> : "加载更多文件"}
            </button>
          )}
        </div>
      </div>
      <footer className="drawer-footer">
        <div>
          已选 <strong>{selected.size}</strong> 个文件
          <span className="muted">· 还可关注 {available} 个</span>
          {selectedNew > available && (
            <span className="error-text">请减少选择数量</span>
          )}
        </div>
        <div>
          {selected.size > 0 && (
            <button
              className="button secondary"
              onClick={() => setSelected(new Map())}
            >
              清除选择
            </button>
          )}
          <button
            className="button secondary"
            disabled={!selected.size || selectedNew > available}
            onClick={() => open([...selected.values()], false)}
          >
            仅加入关注
          </button>
          <button
            className="button primary"
            disabled={!selected.size || selectedNew > available}
            onClick={() => open([...selected.values()])}
          >
            加入并阅读
            <ArrowUpRight size={16} />
          </button>
        </div>
      </footer>
    </Modal>
  );
}
