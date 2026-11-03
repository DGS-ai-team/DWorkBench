import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  Server,
  Folder,
  Layers,
  Users,
  ShieldCheck,
  ChevronDown,
  Plus,
  Maximize2,
  Minimize2,
  PanelRightOpen,
  ArrowUpRight,
  LogOut,
  KeyRound,
  Terminal,
  Search,
  X,
  CheckCircle2,
  ArrowRight,
  Columns2,
  Rows2,
  PanelLeftOpen,
  Play,
} from "lucide-react";
import {
  api,
  session,
  roles,
  type User,
  type Config,
  type LogFile,
} from "./api";
import { Brand, Empty, Spinner, Field } from "./ui";
import { Management, PasswordModal, type Page } from "./Management";
import { Inventory } from "./Inventory";
import {
  LogPane,
  disconnectLogs,
  type PaneDefinition,
  type SessionSummary,
  type SessionCommand,
} from "./LogPane";

import { WatchList } from "./WatchList";
import { emptyWatchRule, type WatchRule } from "./logActivity";
import { defaultLogSettings, type LogSettings } from "./logProcessing";
import {
  useWorkspacePersistence,
  type WorkspaceDocument,
  type WorkspaceItem,
  type ResolvedItem,
} from "./workspace";

const blank: Config = { hosts: [], sources: [], groups: [] };
export default function App() {
  const [ready, setReady] = useState(false),
    [user, setUser] = useState<User | null>(null),
    [setup, setSetup] = useState(false),
    [config, setConfig] = useState<Config>(blank);
  const [page, setPage] = useState<Page>("logs"),
    [groupId, setGroupId] = useState(""),
    [inventory, setInventory] = useState(false),
    [panes, setPanes] = useState<PaneDefinition[]>([]),
    [focus, setFocus] = useState(false),
    [vertical, setVertical] = useState(false);
  const [reading, setReading] = useState<string[]>([]),
    [active, setActive] = useState(""),
    [pinned, setPinned] = useState("");
  const [watchOpen, setWatchOpen] = useState(true),
    [summaries, setSummaries] = useState<Record<string, SessionSummary>>({});
  const [commands, setCommands] = useState<Record<string, SessionCommand>>({});
  const commandId = useRef(0);
  const onSummary = useCallback(
    (key: string, summary: SessionSummary) =>
      setSummaries((old) => ({ ...old, [key]: summary })),
    [],
  );
  useEffect(() => {
    setReading((old) => old.filter((key) => panes.some((p) => p.key === key)));
    if (!panes.some((p) => p.key === pinned)) setPinned("");
    setSummaries((old) =>
      Object.fromEntries(
        Object.entries(old).filter(([key]) => panes.some((p) => p.key === key)),
      ),
    );
    setCommands((old) =>
      Object.fromEntries(
        Object.entries(old).filter(([key]) => panes.some((p) => p.key === key)),
      ),
    );
  }, [panes]);
  function issue(key: string, type: SessionCommand["type"], rowId?: number) {
    setCommands((old) => ({
      ...old,
      [key]: { id: ++commandId.current, type, rowId },
    }));
  }
  function hide(key: string) {
    setReading((old) => old.filter((k) => k !== key));
    if (pinned === key) setPinned("");
    setWatchOpen(true);
  }
  function remove(key: string) {
    hide(key);
    setPanes((old) => old.filter((p) => p.key !== key));
  }
  function show(key: string, beside = false) {
    setReading((old) => {
      if (old.includes(key)) return old;
      if (!old.length || (old.length < 2 && (beside || old[0] === pinned)))
        return old.concat(key);
      const next = [...old];
      let target = beside ? next.length - 1 : Math.max(0, next.indexOf(active));
      if (next[target] === pinned) target = target === 0 ? 1 : 0;
      next[target] = key;
      return next.slice(0, 2);
    });
    setActive(key);
  }
  function updateRule(key: string, rule: WatchRule) {
    setPanes((old) =>
      old.map((p) => (p.key === key ? { ...p, watchRule: rule } : p)),
    );
  }
  const [account, setAccount] = useState(false),
    [password, setPassword] = useState(false),
    [toast, setToast] = useState(""),
    [fatal, setFatal] = useState("");
  const [split, setSplit] = useState(50),
    grid = useRef<HTMLDivElement>(null),
    toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [resuming, setResuming] = useState<string[]>([]);
  const [viewEpoch, setViewEpoch] = useState(0);
  const accountEpoch = useRef(0);
  const resumeLocks = useRef(new Set<string>());
  const onPreferences = useCallback(
    (key: string, patch: { settings?: LogSettings; wrap?: boolean }) => {
      setPanes((old) =>
        old.map((p) => (p.key === key ? { ...p, ...patch } : p)),
      );
    },
    [],
  );
  function saveItem(pane: PaneDefinition): WorkspaceItem {
    return {
      key: pane.key,
      groupId: pane.groupId,
      sourceId: pane.file.sourceId,
      hostId: pane.file.hostId,
      path: pane.file.path,
      encoding: pane.encoding,
      settings: pane.settings,
      wrap: pane.wrap,
      watchRule: pane.watchRule,
    };
  }
  const keptReading = reading
    .filter((key) => panes.some((p) => p.key === key))
    .slice(0, 2);
  const workspaceDocument: WorkspaceDocument = {
    version: 1,
    groupId: groupId || null,
    items: panes.map(saveItem),
    reading: keptReading,
    active: keptReading.includes(active) ? active : (keptReading[0] ?? ""),
    pinned: keptReading.includes(pinned) ? pinned : "",
    vertical,
    split,
    watchOpen,
  };
  function applyWorkspace(
    document: WorkspaceDocument,
    resolved: ResolvedItem[],
  ) {
    accountEpoch.current++;
    setViewEpoch((value) => value + 1);
    resumeLocks.current.clear();
    setResuming([]);
    setPanes(
      document.items.map((item) => {
        const result = resolved.find((r) => r.key === item.key);
        return {
          key: item.key,
          groupId: item.groupId,
          encoding: item.encoding,
          settings: item.settings,
          wrap: item.wrap,
          watchRule: item.watchRule,
          deferred: true,
          startVersion: 0,
          restoreIssue: result?.issue ?? null,
          file: result?.file ?? {
            id: 0,
            sourceId: item.sourceId,
            hostId: item.hostId,
            path: item.path,
            name: item.path.split("/").at(-1) || "日志",
            size: 0,
            modifiedAt: 0,
            hostName: "已失效主机或来源",
            sourceName: "待重新检查",
          },
        };
      }),
    );
    setGroupId(
      config.groups.some((g) => g.id === document.groupId)
        ? document.groupId!
        : (config.groups[0]?.id ?? ""),
    );
    setReading(document.reading);
    setActive(document.active);
    setPinned(document.pinned);
    setVertical(document.vertical);
    setSplit(document.split);
    setWatchOpen(document.watchOpen);
    setSummaries({});
    setCommands({});
    setFocus(false);
    setInventory(false);
    setPage("logs");
  }
  const workspace = useWorkspacePersistence(
    user?.id ?? null,
    workspaceDocument,
    applyWorkspace,
  );
  async function resume(keys: string[]) {
    if (!user) return;
    const targets = panes.filter(
      (p) => keys.includes(p.key) && !resumeLocks.current.has(p.key),
    );
    if (!targets.length) return;
    const epoch = accountEpoch.current;
    targets.forEach((p) => resumeLocks.current.add(p.key));
    setResuming([...resumeLocks.current]);
    try {
      const result = await api<{ resolved: ResolvedItem[] }>(
        "/workspace/resolve",
        { ownerId: user.id, items: targets.map(saveItem) },
      );
      if (epoch !== accountEpoch.current) return;
      setPanes((old) =>
        old.map((p) => {
          const resolved = result.resolved.find((r) => r.key === p.key);
          if (!resolved) return p;
          return resolved.file
            ? {
                ...p,
                file: resolved.file,
                deferred: false,
                restoreIssue: null,
                startVersion: p.startVersion + 1,
              }
            : {
                ...p,
                deferred: true,
                restoreIssue:
                  resolved.issue || "无法恢复此日志，请从清单重新选择。",
              };
        }),
      );
    } catch (e) {
      if (epoch === accountEpoch.current) notify((e as Error).message);
    } finally {
      if (epoch === accountEpoch.current) {
        targets.forEach((p) => resumeLocks.current.delete(p.key));
        setResuming([...resumeLocks.current]);
      }
    }
  }
  function notify(text: string) {
    setToast(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 6000);
  }
  async function reload() {
    setConfig(await api("/config"));
  }
  async function refresh() {
    const state = await session();
    if (state.user) await reload();
    setUser(state.user);
    setSetup(state.setupRequired);
    setReady(true);
  }
  useEffect(() => {
    void refresh().catch((e) => {
      setFatal(e.message);
      setReady(true);
    });
    const expired = () => {
      accountEpoch.current++;
      resumeLocks.current.clear();
      setResuming([]);
      setUser(null);
      setPanes([]);
      setInventory(false);
      setConfig(blank);
      void disconnectLogs();
      void session().catch(() => {});
    };
    window.addEventListener("session-expired", expired);
    return () => window.removeEventListener("session-expired", expired);
  }, []);
  useEffect(() => {
    if (!config.groups.some((g) => g.id === groupId))
      setGroupId(config.groups[0]?.id ?? "");
  }, [config.groups, groupId]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setFocus(false);
        setAccount(false);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        if (groupId) setInventory(true);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [groupId]);
  const group = config.groups.find((g) => g.id === groupId);
  const groupSources = config.sources.filter((s) =>
    group?.sourceIds.includes(s.id),
  );
  const hostCount = new Set(groupSources.map((s) => s.hostId)).size;
  function identity(file: LogFile) {
    return `${file.hostId}:${file.path}:${file.encoding ?? config.sources.find((s) => s.id === file.sourceId)?.encoding ?? "utf-8"}`;
  }
  function open(files: LogFile[], read = true) {
    const additions: PaneDefinition[] = [];
    for (const file of files) {
      if (
        panes
          .concat(additions)
          .some(
            (p) =>
              `${p.file.hostId}:${p.file.path}:${p.encoding}` ===
              identity(file),
          )
      )
        continue;
      additions.push({
        key: crypto.randomUUID(),
        groupId,
        file,
        watchRule: { ...emptyWatchRule },
        settings: { ...defaultLogSettings },
        wrap: false,
        encoding:
          file.encoding ??
          config.sources.find((s) => s.id === file.sourceId)?.encoding ??
          "utf-8",
        deferred: false,
        restoreIssue: null,
        startVersion: 0,
      });
    }
    if (panes.length + additions.length > 4) {
      notify(
        "本工作区最多关注 4 个文件，请先移除部分关注。后台日志也计入额度。",
      );
      return;
    }
    const next = panes.concat(additions);
    setPanes(next);
    setWatchOpen(true);
    setInventory(false);
    setPage("logs");
    if (read) {
      const selected = files.map(
        (file) =>
          next.find(
            (p) =>
              `${p.file.hostId}:${p.file.path}:${p.encoding}` ===
              identity(file),
          )!.key,
      );
      if (selected.length === 1) show(selected[0]);
      else {
        const targets = [
          ...new Set([...(pinned ? [pinned] : []), ...selected]),
        ].slice(0, 2);
        setReading(targets);
        setActive(targets.find((key) => key !== pinned) ?? targets[0]);
      }
    }
  }
  function viewGroup(id: string) {
    setGroupId(id);
    setPage("logs");
    setInventory(true);
  }
  if (!ready)
    return (
      <div className="boot">
        <Brand />
        <Spinner />
        <p>正在连接工作台…</p>
      </div>
    );
  if (fatal && !user)
    return (
      <div className="boot">
        <Brand />
        <p>{fatal}</p>
        <button className="button primary" onClick={() => location.reload()}>
          重新连接
        </button>
      </div>
    );
  if (!user) return <Login setup={setup} done={refresh} />;
  if (!workspace.loaded)
    return (
      <div className="boot">
        <Brand />
        <p>{workspace.error || "正在恢复工作台配置…"}</p>
        {workspace.error ? (
          <button
            className="button primary"
            disabled={workspace.loading}
            onClick={() => void workspace.retry()}
          >
            重新读取
          </button>
        ) : (
          <Spinner />
        )}
      </div>
    );
  const navigation: [Page, string, typeof Activity][] = [
    ["logs", "日志工作台", Activity],
    ...(user.role === "Admin"
      ? [["hosts", "主机管理", Server] as [Page, string, typeof Activity]]
      : []),
    ...(["Admin", "Maintainer"].includes(user.role)
      ? ([
          ["sources", "日志来源", Folder],
          ["groups", "日志组", Layers],
        ] as [Page, string, typeof Activity][])
      : []),
    ...(user.role === "Admin"
      ? [["users", "团队成员", Users] as [Page, string, typeof Activity]]
      : []),
    ...(["Admin", "Auditor"].includes(user.role)
      ? [["audit", "操作审计", ShieldCheck] as [Page, string, typeof Activity]]
      : []),
  ];
  function drag(e: React.PointerEvent) {
    e.currentTarget.setPointerCapture(e.pointerId);
    const move = (event: PointerEvent) => {
      const rect = grid.current?.getBoundingClientRect();
      if (rect)
        setSplit(
          Math.max(
            25,
            Math.min(
              75,
              vertical
                ? ((event.clientY - rect.top) / rect.height) * 100
                : ((event.clientX - rect.left) / rect.width) * 100,
            ),
          ),
        );
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  }
  return (
    <div className={"app " + (focus ? "focus" : "")}>
      <header className="app-header">
        <Brand small />
        <span className="header-divider" />
        <nav aria-label="主导航">
          {navigation.map(([value, label, Icon]) => (
            <button
              key={value}
              className={page === value ? "selected" : ""}
              onClick={() => {
                setPage(value);
                setAccount(false);
              }}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </nav>
        <div className="header-right">
          <div className="account">
            <button
              className="account-button"
              onClick={() => setAccount(!account)}
              aria-expanded={account}
            >
              <span className="avatar">
                {user.displayName.slice(0, 1).toUpperCase()}
              </span>
              <span>{user.displayName}</span>
              <ChevronDown size={12} />
            </button>
            {account && (
              <div className="account-menu">
                <small>
                  {user.username} · {roles[user.role]}
                </small>
                <button
                  onClick={() => {
                    setPassword(true);
                    setAccount(false);
                  }}
                >
                  <KeyRound size={14} />
                  修改密码
                </button>
                <button
                  onClick={async () => {
                    try {
                      await workspace.flush();
                      await api("/logout", {});
                      accountEpoch.current++;
                      await disconnectLogs();
                      setUser(null);
                      setPanes([]);
                      setConfig(blank);
                      await refresh();
                    } catch (e) {
                      notify((e as Error).message);
                    }
                  }}
                >
                  <LogOut size={14} />
                  退出登录
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
      <div className="workspace-shell" hidden={page !== "logs"}>
        <div className="workspace-toolbar">
          <div className="group-picker">
            <Layers size={15} />
            <select
              aria-label="当前日志组"
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
            >
              {!config.groups.length && <option value="">选择日志组</option>}
              {config.groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
            <ChevronDown size={13} />
          </div>
          <span className="toolbar-summary">
            <span className="status-dot live" />
            {hostCount} 台主机<span>·</span>
            {groupSources.length} 个日志源
          </span>
          <div className="toolbar-right">
            {panes.some((p) => p.deferred) && (
              <button
                className="button secondary"
                disabled={resuming.length > 0}
                onClick={() =>
                  void resume(panes.filter((p) => p.deferred).map((p) => p.key))
                }
              >
                <Play size={14} />
                {resuming.length ? "正在检查…" : "恢复接收"}
              </button>
            )}
            {!watchOpen && panes.length > 0 && (
              <button
                className="button quiet watch-toggle"
                aria-expanded={false}
                onClick={() => setWatchOpen(true)}
              >
                <PanelLeftOpen size={15} />
                关注列表
                {Object.values(summaries).some((s) => !!s.activity?.unseen) && (
                  <span className="badge amber">有新命中</span>
                )}
              </button>
            )}
            <button
              className="button inventory-button"
              disabled={!group}
              onClick={() => setInventory(true)}
            >
              <PanelRightOpen size={15} />
              日志清单<kbd>Ctrl K</kbd>
            </button>
            {reading.length === 2 && (
              <button
                className="icon-button"
                title={vertical ? "切换为左右分窗" : "切换为上下分窗"}
                onClick={() => setVertical((v) => !v)}
              >
                {vertical ? <Columns2 size={16} /> : <Rows2 size={16} />}
              </button>
            )}
            <button className="button quiet" onClick={() => setFocus(true)}>
              <Maximize2 size={15} />
              专注模式
            </button>
          </div>
        </div>
        {workspace.error && (
          <div className="workspace-save-error" role="alert">
            <span>{workspace.error}</span>
            {workspace.conflict ? (
              <>
                <button
                  className="text-button"
                  onClick={() => void workspace.loadSaved()}
                >
                  加载已保存版本
                </button>
                <button
                  className="text-button"
                  onClick={() => void workspace.keepCurrent()}
                >
                  保留当前工作台
                </button>
              </>
            ) : (
              <button
                className="text-button"
                onClick={() => void workspace.retry()}
              >
                重试保存
              </button>
            )}
          </div>
        )}
        <main
          className={
            "workspace " + (watchOpen && panes.length ? "with-watch" : "")
          }
        >
          {watchOpen && panes.length > 0 && (
            <WatchList
              panes={panes}
              summaries={summaries}
              reading={reading}
              active={active}
              pinned={pinned}
              open={show}
              remove={remove}
              issue={issue}
              setRule={updateRule}
              collapse={() => setWatchOpen(false)}
            />
          )}
          <div className="reading-area">
            {panes.length ? (
              <div
                ref={grid}
                className={
                  "pane-grid count-" +
                  reading.length +
                  (vertical && reading.length === 2 ? " vertical" : "")
                }
                style={
                  reading.length === 2
                    ? vertical
                      ? {
                          gridTemplateRows: `${split}% minmax(0,1fr)`,
                          gridTemplateAreas: '"primary" "secondary"',
                        }
                      : {
                          gridTemplateColumns: `${split}% minmax(0,1fr)`,
                          gridTemplateAreas: '"primary secondary"',
                        }
                    : { gridTemplateAreas: '"primary"' }
                }
              >
                {panes.map((pane) => (
                  <LogPane
                    key={`${viewEpoch}:${pane.key}`}
                    pane={pane}
                    canPin={reading.length === 2}
                    visible={reading.includes(pane.key) && page === "logs"}
                    slot={reading.indexOf(pane.key)}
                    active={active === pane.key}
                    onActivate={() => setActive(pane.key)}
                    onHide={() => hide(pane.key)}
                    pinned={pinned === pane.key}
                    onPin={() =>
                      setPinned((old) => (old === pane.key ? "" : pane.key))
                    }
                    onSummary={onSummary}
                    command={commands[pane.key]}
                    notify={notify}
                    onPreferences={onPreferences}
                    onResume={(key) => void resume([key])}
                    resuming={resuming.includes(pane.key)}
                  />
                ))}
                {!reading.length && (
                  <div className="reading-empty">
                    <EyePlaceholder />
                    <h2>选择一个关注日志开始阅读</h2>
                    <p>点击文件名展开，或选择“并排”查看。</p>
                    <button
                      className="button secondary"
                      onClick={() => setWatchOpen(true)}
                    >
                      展开关注列表
                    </button>
                  </div>
                )}
                {reading.length === 2 && (
                  <div
                    role="separator"
                    tabIndex={0}
                    aria-label="调整日志窗格大小"
                    aria-orientation={vertical ? "horizontal" : "vertical"}
                    aria-valuenow={Math.round(split)}
                    className={
                      "pane-splitter " + (vertical ? "horizontal" : "")
                    }
                    style={
                      vertical ? { top: `${split}%` } : { left: `${split}%` }
                    }
                    onPointerDown={drag}
                    onKeyDown={(e) => {
                      if (["ArrowLeft", "ArrowUp"].includes(e.key)) {
                        e.preventDefault();
                        setSplit((s) => Math.max(25, s - 2));
                      }
                      if (["ArrowRight", "ArrowDown"].includes(e.key)) {
                        e.preventDefault();
                        setSplit((s) => Math.min(75, s + 2));
                      }
                    }}
                  />
                )}
              </div>
            ) : (
              <div className="workspace-empty">
                <div className="empty-grid" />
                <div className="empty-content">
                  <span className="workspace-icon">
                    <Terminal size={32} />
                  </span>
                  <h1>{group ? "选择日志开始阅读" : "配置日志工作台"}</h1>
                  <p>
                    {group
                      ? "打开日志清单，选择你关心的文件。\n跨多台主机，在同一个工作区并排查看。"
                      : "连接你的 Linux 主机，把分散的日志组织在一起。\n团队共享配置，各自专注于当前的问题。"}
                  </p>
                  {group ? (
                    <button
                      className="button primary large"
                      onClick={() => setInventory(true)}
                    >
                      <PanelRightOpen size={17} />
                      选择日志文件
                      <ArrowUpRight size={17} />
                    </button>
                  ) : user.role === "Admin" ? (
                    <button
                      className="button primary large"
                      onClick={() =>
                        setPage(
                          !config.hosts.length
                            ? "hosts"
                            : !config.sources.length
                              ? "sources"
                              : "groups",
                        )
                      }
                    >
                      开始配置
                      <ArrowRight size={17} />
                    </button>
                  ) : (
                    <span className="helper">
                      请联系管理员为你分配日志组和主机访问权限。
                    </span>
                  )}
                  {!config.groups.length && (
                    <div className="onboarding">
                      <span className={config.hosts.length ? "done" : ""}>
                        <i>
                          {config.hosts.length ? <CheckCircle2 size={13} /> : 1}
                        </i>
                        连接主机
                      </span>
                      <span className="step-line" />
                      <span className={config.sources.length ? "done" : ""}>
                        <i>
                          {config.sources.length ? (
                            <CheckCircle2 size={13} />
                          ) : (
                            2
                          )}
                        </i>
                        配置日志源
                      </span>
                      <span className="step-line" />
                      <span className={config.groups.length ? "done" : ""}>
                        <i>
                          {config.groups.length ? (
                            <CheckCircle2 size={13} />
                          ) : (
                            3
                          )}
                        </i>
                        创建共享日志组
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
      {page !== "logs" && (
        <main className="management-scroll">
          <Management
            page={page}
            config={config}
            reload={reload}
            notify={notify}
            user={user}
            viewGroup={viewGroup}
            navigate={setPage}
          />
        </main>
      )}
      {focus && (
        <button
          className="exit-focus button secondary"
          onClick={() => setFocus(false)}
        >
          <Minimize2 size={14} />
          退出专注 <kbd>Esc</kbd>
        </button>
      )}
      {inventory && group && (
        <Inventory
          group={group}
          config={config}
          close={() => setInventory(false)}
          open={open}
          available={4 - panes.length}
          tracked={panes.map((p) => p.file)}
          reading={panes
            .filter((p) => reading.includes(p.key))
            .map((p) => p.file)}
          locate={(file) => {
            const found = panes.find(
              (p) => identity(p.file) === identity(file),
            );
            if (found) {
              show(found.key);
              setInventory(false);
            }
          }}
          notify={notify}
        />
      )}
      {password && (
        <PasswordModal close={() => setPassword(false)} notify={notify} />
      )}
      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          <button
            className="icon-button"
            aria-label="关闭消息"
            onClick={() => setToast("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

function EyePlaceholder() {
  return <Activity size={30} />;
}

function Login({ setup, done }: { setup: boolean; done: () => Promise<void> }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="login-page">
      <div className="login-intro">
        <Brand />
        <div className="login-copy">
          <span className="eyebrow">A CLEARER VIEW OF YOUR SYSTEMS</span>
          <h1>
            日志有序，
            <br />
            协作有据。
          </h1>
          <p>
            连接分散的主机，聚合关键的线索。
            <br />
            为团队提供一个清晰、专注的日志工作台。
          </p>
          <div className="login-feature">
            <Server size={17} />
            <span>跨主机日志组</span>
          </div>
          <div className="login-feature">
            <Layers size={17} />
            <span>多窗格实时跟随</span>
          </div>
          <div className="login-feature">
            <ShieldCheck size={17} />
            <span>团队权限与操作记录</span>
          </div>
        </div>
        <small>LogDesk · 团队 Linux 管理工作台</small>
      </div>
      <main className="login-main">
        <form
          className="login-card"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            if (setup && form.get("password") !== form.get("confirm")) {
              setError("两次输入的密码不一致。");
              return;
            }
            setBusy(true);
            setError("");
            try {
              await api(setup ? "/setup" : "/login", {
                username: String(form.get("username")),
                password: String(form.get("password")),
                setupToken: String(form.get("setupToken") ?? ""),
              });
              await done();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <span className="eyebrow">
            {setup ? "CREATE YOUR WORKSPACE" : "WELCOME BACK"}
          </span>
          <h2>{setup ? "初始化团队工作台" : "登录你的工作台"}</h2>
          <p>
            {setup
              ? "创建首个管理员账号，开始连接你的主机。"
              : "使用团队管理员为你创建的账号登录。"}
          </p>
          {setup && (
            <Field
              label="初始化令牌"
              hint="由部署管理员提供，用于保护首次账号创建。"
            >
              <input
                name="setupToken"
                type="password"
                required
                autoComplete="off"
              />
            </Field>
          )}
          <Field label={setup ? "管理员登录名" : "登录名"}>
            <input
              name="username"
              autoFocus
              required
              autoComplete="username"
              placeholder="输入登录名"
              maxLength={100}
            />
          </Field>
          <Field
            label="密码"
            hint={setup ? "至少 12 位，包含大写、小写字母和数字。" : undefined}
          >
            <input
              name="password"
              type="password"
              autoComplete={setup ? "new-password" : "current-password"}
              required
              minLength={setup ? 12 : undefined}
              placeholder="输入密码"
            />
          </Field>
          {setup && (
            <Field label="再次输入密码">
              <input
                name="confirm"
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
              />
            </Field>
          )}
          {error && (
            <div className="alert error" role="alert">
              {error}
            </div>
          )}
          <button className="button primary large login-submit" disabled={busy}>
            {busy ? <Spinner /> : setup ? "创建工作台" : "登录"}
            <ArrowRight size={16} />
          </button>
          <small className="login-note">
            {setup
              ? "凭据由服务端加密保存，团队访问按权限控制。"
              : "忘记密码？请联系团队管理员重置。"}
          </small>
        </form>
      </main>
    </div>
  );
}
