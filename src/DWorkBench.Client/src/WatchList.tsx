import { useState } from "react";
import {
  Columns2,
  SlidersHorizontal,
  X,
  Play,
  Square,
  Check,
  Pin,
  PanelLeftClose,
  Activity as ActivityIcon,
} from "lucide-react";
import {
  type PaneDefinition,
  type SessionSummary,
  type SessionCommand,
} from "./LogPane";
import { ago, type WatchRule } from "./logActivity";
import { compilePattern, defaultLogSettings } from "./logProcessing";
import { Modal, ActionMenu, type MenuAction } from "./ui";

export function WatchList({
  panes,
  summaries,
  reading,
  active,
  pinned,
  open,
  remove,
  issue,
  setRule,
  collapse,
}: {
  panes: PaneDefinition[];
  summaries: Record<string, SessionSummary>;
  reading: string[];
  active: string;
  pinned: string;
  open: (key: string, beside?: boolean) => void;
  remove: (key: string) => void;
  issue: (key: string, type: SessionCommand["type"], rowId?: number) => void;
  setRule: (key: string, rule: WatchRule) => void;
  collapse: () => void;
}) {
  const [editing, setEditing] = useState<PaneDefinition | null>(null);
  const [details, setDetails] = useState<string | null>(null);
  const detailPane = panes.find((p) => p.key === details);
  const detailState = details ? summaries[details] : undefined;
  const detailActivity = detailState?.activity;
  return (
    <aside className="watch-sidebar" aria-label="关注列表">
      <div className="watch-heading">
        <div>
          <strong>关注列表</strong>
          <span>{panes.length} / 4</span>
        </div>
        <button
          className="icon-button"
          aria-label="收起关注列表"
          onClick={collapse}
        >
          <PanelLeftClose size={16} />
        </button>
      </div>
      <div className="watch-cards">
        {panes.map((p) => {
          const state = summaries[p.key],
            activity = state?.activity;
          const live = state?.status === "live";
          const stopped =
            p.deferred ||
            state?.status === "stopped" ||
            state?.status === "error";
          const isReading = reading.includes(p.key);
          const excerpt = activity?.rule.pattern
            ? activity.hit
            : activity?.last;
          const status = p.deferred
            ? p.restoreIssue
              ? "待重新检查"
              : "待恢复"
            : state?.status === "error"
              ? "连接异常"
              : stopped
                ? "已停止"
                : live
                  ? "已连接"
                  : "连接中";
          const jumpToHit = () => {
            open(p.key);
            if (activity?.hit) issue(p.key, "jump", activity.hit.id);
          };
          const actions: MenuAction[] = [
            {
              label: "关注规则",
              icon: <SlidersHorizontal size={15} />,
              action: () => setEditing(p),
            },
            {
              label: "接收详情",
              icon: <ActivityIcon size={15} />,
              action: () => setDetails(p.key),
            },
            ...(activity?.unseen
              ? [
                  {
                    label: "标为已查看",
                    icon: <Check size={15} />,
                    action: () => issue(p.key, "acknowledge"),
                  },
                ]
              : []),
            {
              label: p.deferred
                ? "恢复接收"
                : stopped
                  ? "继续接收"
                  : "停止接收",
              icon: stopped ? <Play size={15} /> : <Square size={14} />,
              action: () => issue(p.key, "toggle"),
            },
            {
              label: "移除关注",
              icon: <X size={15} />,
              danger: true,
              action: () => remove(p.key),
            },
          ];
          return (
            <article
              className={
                "watch-card " +
                (active === p.key ? "selected " : "") +
                (isReading ? "reading" : "")
              }
              key={p.key}
            >
              <div className="watch-card-head">
                <button
                  className="watch-open"
                  aria-label={`阅读 ${p.file.name} · ${p.file.hostName}`}
                  onClick={() => open(p.key)}
                >
                  <span className="watch-name">
                    <strong title={p.file.path}>{p.file.name}</strong>
                    {pinned === p.key && <Pin size={12} />}
                    <span className="badge">
                      {isReading ? "阅读中" : "后台"}
                    </span>
                  </span>
                  <span
                    className="watch-origin"
                    title={`${p.file.hostName} / ${p.file.sourceName}\n${p.file.path}`}
                  >
                    {p.file.hostName} / {p.file.sourceName}
                  </span>
                </button>
                <ActionMenu label={`${p.file.name} 关注操作`} items={actions} />
              </div>
              <div className="watch-status">
                <span
                  className={
                    "status-dot " +
                    (live ? "live" : state?.status === "error" ? "failed" : "")
                  }
                />
                {status}
                {state?.frozen && " · 已冻结"}
                <span title="最近接收到日志内容的时间">
                  {ago(state?.lastReceived ?? null)}
                </span>
              </div>
              {state?.error && <p className="watch-error">{state.error}</p>}
              {(!isReading || !!activity?.unseen) &&
                (activity?.hit ? (
                  <button
                    className="watch-excerpt excerpt-link"
                    title="定位最近命中，会清除阅读筛选并解除冻结"
                    aria-label={`定位 ${p.file.name} 最近命中`}
                    onClick={jumpToHit}
                  >
                    <small>最近命中 · {activity.rule.pattern}</small>
                    <code>{activity.hit.text}</code>
                  </button>
                ) : (
                  <div className="watch-excerpt">
                    <small>
                      {activity?.rule.pattern ? "最近命中" : "最近原文"}
                    </small>
                    <code title={excerpt?.text}>
                      {excerpt?.text ||
                        (activity?.rule.pattern
                          ? "尚无规则命中"
                          : p.deferred
                            ? "恢复接收后显示最近内容"
                            : "等待日志内容…")}
                    </code>
                  </div>
                ))}
              {activity?.error && (
                <p className="watch-error">{activity.error}</p>
              )}
              {((activity?.unseen ?? 0) > 0 ||
                (!isReading && reading.length > 0)) && (
                <div className="watch-actions">
                  {!!activity?.unseen && (
                    <button
                      className="watch-unseen"
                      title="定位最近命中；可在更多菜单中标为已查看"
                      onClick={jumpToHit}
                    >
                      {activity.unseen > 999 ? "999+" : activity.unseen} 条待看
                    </button>
                  )}
                  {!isReading && reading.length > 0 && (
                    <button
                      className="text-button"
                      onClick={() => open(p.key, true)}
                      title="在另一个阅读窗格中查看"
                    >
                      <Columns2 size={13} />
                      并排
                    </button>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
      {detailPane && (
        <Modal
          title={`${detailPane.file.name} · 接收详情`}
          close={() => setDetails(null)}
        >
          <div className="form-body">
            <dl className="activity-details">
              <dt>最近接收</dt>
              <dd>{ago(detailState?.lastReceived ?? null)}</dd>
              <dt>近 60 秒接收</dt>
              <dd>{detailActivity?.received.toLocaleString() ?? "—"} 行</dd>
              {detailActivity?.rule.pattern && (
                <>
                  <dt>近 60 秒命中</dt>
                  <dd>{detailActivity.matches.toLocaleString()} 行</dd>
                  <dt>关注规则</dt>
                  <dd>{detailActivity.rule.pattern}</dd>
                </>
              )}
              {detailActivity && (
                <>
                  <dt>观察时长</dt>
                  <dd>
                    {Math.max(
                      0,
                      Math.floor((Date.now() - detailActivity.since) / 1000),
                    )}{" "}
                    秒
                  </dd>
                </>
              )}
            </dl>
            <p className="helper">
              按接收时间统计，包含首次返回的尾部日志，显式回放快照不计入。命中数按行计算；停止接收期间不统计。
            </p>
          </div>
        </Modal>
      )}
      {editing && (
        <WatchRuleModal
          key={editing.key}
          pane={editing}
          close={() => setEditing(null)}
          save={(rule) => {
            setRule(editing.key, rule);
            setEditing(null);
          }}
        />
      )}
    </aside>
  );
}

function WatchRuleModal({
  pane,
  close,
  save,
}: {
  pane: PaneDefinition;
  close: () => void;
  save: (rule: WatchRule) => void;
}) {
  const [rule, setRule] = useState(pane.watchRule),
    [error, setError] = useState("");
  return (
    <Modal title={`${pane.file.name} · 关注规则`} close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          try {
            compilePattern(
              rule.pattern,
              {
                ...defaultLogSettings,
                mode: rule.mode,
                caseSensitive: rule.caseSensitive,
              },
              false,
            );
            save(rule);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <div className="form-body">
          <p className="helper">
            独立于主窗格的阅读筛选。保存后从当前时刻重新统计命中；留空则只显示最近原文。
          </p>
          <label className="field">
            关注内容
            <input
              autoFocus
              aria-label="关注模式"
              value={rule.pattern}
              maxLength={512}
              placeholder="例如 timeout、订单号或请求 ID"
              onChange={(e) => setRule({ ...rule, pattern: e.target.value })}
            />
          </label>
          <label className="field">
            匹配方式
            <select
              aria-label="关注匹配方式"
              value={rule.mode}
              onChange={(e) =>
                setRule({ ...rule, mode: e.target.value as WatchRule["mode"] })
              }
            >
              <option value="text">包含文本</option>
              <option value="glob">通配符（整行）</option>
              <option value="regex">正则（RE2）</option>
            </select>
          </label>
          <label className="check-line">
            <input
              type="checkbox"
              checked={rule.caseSensitive}
              onChange={(e) =>
                setRule({ ...rule, caseSensitive: e.target.checked })
              }
            />
            区分大小写
          </label>
          {rule.mode === "regex" && (
            <p className="helper">正则不支持环视与反向引用。</p>
          )}
          {error && (
            <div role="alert" className="alert error">
              {error}
            </div>
          )}
        </div>
        <footer className="form-footer">
          <button type="button" className="button secondary" onClick={close}>
            取消
          </button>
          <button className="button primary">保存关注规则</button>
        </footer>
      </form>
    </Modal>
  );
}
