import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Plus,
  Pencil,
  Trash2,
  Copy,
  ShieldCheck,
  Server,
  Folder,
  Layers,
  Users,
  Search,
  Fingerprint,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
  KeyRound,
  ArrowRight,
  Eye,
} from "lucide-react";
import {
  api,
  roles,
  date,
  size,
  type Config,
  type Host,
  type Source,
  type Group,
  type User,
  type Grant,
  type Audit,
} from "./api";
import {
  Field,
  Modal,
  Empty,
  Spinner,
  ActionMenu,
  type MenuAction,
} from "./ui";

type Props = {
  config: Config;
  reload: () => Promise<void>;
  notify: (text: string) => void;
  user: User;
  viewGroup: (id: string) => void;
  navigate: (page: Page) => void;
};
export type Page = "logs" | "hosts" | "sources" | "groups" | "users" | "audit";
const text = (form: FormData, name: string) => String(form.get(name) ?? "");
export function FormModal({
  title,
  close,
  children,
  save,
  wide = false,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  save: (data: FormData) => Promise<void>;
  wide?: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal title={title} close={close} wide={wide}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          setBusy(true);
          setError("");
          try {
            await save(data);
            close();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-body">
          {children}
          {error && <div className="alert error">{error}</div>}
        </div>
        <footer className="form-footer">
          <button type="button" className="button secondary" onClick={close}>
            取消
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? <Spinner /> : <CheckCircle2 size={15} />}保存
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function Management({ page, ...props }: Props & { page: Page }) {
  if (page === "users") return <UserManager {...props} />;
  if (page === "audit") return <AuditPage />;
  return <Resources page={page} {...props} />;
}

function Resources({
  page,
  config,
  reload,
  notify,
  user,
  viewGroup,
  navigate,
}: Props & { page: Page }) {
  const [editing, setEditing] = useState<{
      kind: Page;
      item?: Host | Source | Group;
      copy?: boolean;
      hostId?: string;
      sourceId?: string;
    } | null>(null),
    [probe, setProbe] = useState<Host | null>(null),
    [q, setQ] = useState("");
  const [nextStep, setNextStep] = useState<{
    kind: Page;
    id: string;
    name: string;
  } | null>(null);
  const [groupQuery, setGroupQuery] = useState("");
  const [guideOpen, setGuideOpen] = useState(false);
  const setupIncomplete =
    user.role === "Admin" &&
    !config.groups.some((g) =>
      g.sourceIds.some((id) =>
        config.sources.some(
          (s) =>
            s.id === id &&
            config.hosts.some((h) => h.id === s.hostId && h.fingerprint),
        ),
      ),
    );
  const titles = {
    hosts: "主机管理",
    sources: "日志来源",
    groups: "日志组",
  };
  const kind = (page === "hosts" || page === "sources" ? page : "groups") as
    "hosts" | "sources" | "groups";
  const title = titles[kind];
  const formKind = editing?.kind ?? kind;
  const items = config[kind].filter((item) =>
    item.name.toLowerCase().includes(q.toLowerCase()),
  );
  async function remove(id: string, name: string) {
    if (!window.confirm(`删除“${name}”？此操作不会删除远端日志文件。`)) return;
    try {
      await api(`/${kind}/${id}`, undefined, "DELETE");
      await reload();
      notify("配置已删除。");
    } catch (e) {
      notify((e as Error).message);
    }
  }
  async function save(form: FormData) {
    const item = editing?.item;
    const update = item && !editing?.copy;
    let payload: unknown;
    if (formKind === "hosts")
      payload = {
        name: text(form, "name"),
        address: text(form, "address"),
        port: Number(form.get("port")),
        username: text(form, "username"),
        password: text(form, "password") || null,
      };
    else if (formKind === "sources")
      payload = {
        hostId: text(form, "hostId"),
        name: text(form, "name"),
        directory: text(form, "directory"),
        pattern: text(form, "pattern"),
        encoding: text(form, "encoding"),
      };
    else
      payload = {
        name: text(form, "name"),
        description: text(form, "description"),
        sourceIds: form.getAll("sourceIds"),
      };
    const saved = await api<Host | { id: string } | undefined>(
      `/${formKind}${update ? "/" + item.id : ""}`,
      payload,
      update ? "PUT" : "POST",
    );
    await reload();
    notify(update ? "配置已更新。" : "配置已添加。");
    const id = saved?.id ?? item?.id;
    if (id) setNextStep({ kind: formKind, id, name: text(form, "name") });
    if (formKind === "hosts" && saved && "address" in saved) setProbe(saved);
  }
  return (
    <div className="management">
      <div className="page-heading">
        <div>
          <h1>
            {title}
            <span>{config[kind].length}</span>
          </h1>
        </div>
        {user.role === "Admin" && (
          <button
            className="button primary"
            onClick={() => setEditing({ kind })}
          >
            <Plus size={16} />
            添加
            {kind === "hosts"
              ? "主机"
              : kind === "sources"
                ? "日志源"
                : "日志组"}
          </button>
        )}
      </div>
      {(setupIncomplete || guideOpen) && (
        <div className="setup-route" aria-label="配置步骤">
          <button onClick={() => navigate("hosts")}>1 连接主机</button>
          <ArrowRight size={12} />
          <button onClick={() => navigate("sources")}>2 预览日志源</button>
          <ArrowRight size={12} />
          <button onClick={() => navigate("groups")}>3 组织日志组</button>
          <ArrowRight size={12} />
          <button
            onClick={() => navigate(user.role === "Admin" ? "users" : "logs")}
          >
            {user.role === "Admin" ? "4 分配权限" : "4 查看日志"}
          </button>
        </div>
      )}
      {nextStep && (
        <div className="setup-next" role="status">
          <CheckCircle2 size={18} />
          <span>已保存「{nextStep.name}」</span>
          {nextStep.kind === "sources" && user.role === "Admin" && (
            <button
              className="button secondary"
              onClick={() =>
                setEditing({ kind: "groups", sourceId: nextStep.id })
              }
            >
              加入新日志组
              <ArrowRight size={14} />
            </button>
          )}
          {nextStep.kind === "groups" && (
            <>
              <button
                className="button primary"
                onClick={() => viewGroup(nextStep.id)}
              >
                查看本组日志
                <ArrowRight size={14} />
              </button>
              {user.role === "Admin" && (
                <button
                  className="button secondary"
                  onClick={() => navigate("users")}
                >
                  分配团队权限
                </button>
              )}
            </>
          )}
          {nextStep.kind === "hosts" && (
            <button
              className="button secondary"
              onClick={() => {
                const host = config.hosts.find((h) => h.id === nextStep.id);
                if (host) setProbe(host);
              }}
            >
              测试连接并继续
            </button>
          )}
        </div>
      )}
      <div className="resource-toolbar">
        <label className="search-field">
          <Search size={15} />
          <input
            aria-label={`搜索${title}`}
            placeholder={`搜索${title}…`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        {user.role === "Admin" && !setupIncomplete && (
          <button
            className="text-button"
            aria-expanded={guideOpen}
            onClick={() => setGuideOpen((v) => !v)}
          >
            {guideOpen ? "收起指引" : "配置指引"}
          </button>
        )}
      </div>
      {!items.length ? (
        <Empty
          icon={
            kind === "hosts" ? (
              <Server size={28} />
            ) : kind === "sources" ? (
              <Folder size={28} />
            ) : (
              <Layers size={28} />
            )
          }
          title={
            q
              ? "没有找到匹配项"
              : `添加第一个${kind === "hosts" ? "Linux 主机" : kind === "sources" ? "日志源" : "跨主机日志组"}`
          }
        >
          {kind === "hosts"
            ? "保存连接后，测试连接并核验主机指纹。"
            : kind === "sources"
              ? "选择一台主机，填写目录与文件名模式。"
              : "日志组可以包含多台主机上的不同日志源。"}
        </Empty>
      ) : (
        <div className="resource-list">
          {items.map((item) => {
            const host = item as Host,
              source = item as Source,
              group = item as Group;
            const actions: MenuAction[] = [
              ...(user.role === "Admin" && kind === "hosts"
                ? [
                    {
                      label: "添加日志源",
                      icon: <Folder size={15} />,
                      action: () =>
                        setEditing({ kind: "sources", hostId: host.id }),
                    },
                  ]
                : []),
              ...(user.role === "Admin" && kind === "sources"
                ? [
                    {
                      label: "创建日志组",
                      icon: <Layers size={15} />,
                      action: () =>
                        setEditing({ kind: "groups", sourceId: source.id }),
                    },
                  ]
                : []),
              ...(user.role === "Admin"
                ? [
                    {
                      label: "复制配置",
                      icon: <Copy size={15} />,
                      action: () => setEditing({ kind, item, copy: true }),
                    },
                  ]
                : []),
              {
                label: "删除配置",
                icon: <Trash2 size={15} />,
                danger: true,
                action: () => {
                  void remove(item.id, item.name);
                },
              },
            ];
            return (
              <article className="resource-card" key={item.id}>
                <span className="resource-icon">
                  {kind === "hosts" ? (
                    <Server size={21} />
                  ) : kind === "sources" ? (
                    <Folder size={21} />
                  ) : (
                    <Layers size={21} />
                  )}
                </span>
                <div className="resource-main">
                  <h3>
                    {item.name}
                    {kind === "hosts" && (
                      <span
                        className={
                          "badge " + (host.fingerprint ? "green" : "amber")
                        }
                      >
                        {host.fingerprint ? "指纹已确认" : "待核验身份"}
                      </span>
                    )}
                  </h3>
                  {kind === "hosts" ? (
                    <>
                      <p className="mono">
                        {host.username}@{host.address}:{host.port}
                      </p>
                      <small
                        className="fingerprint"
                        title={host.fingerprint ?? ""}
                      >
                        {host.fingerprint ??
                          "首次连接需通过可信渠道核对 SSH 指纹"}
                      </small>
                    </>
                  ) : kind === "sources" ? (
                    <>
                      <p>
                        <span className="resource-host">
                          {
                            config.hosts.find((h) => h.id === source.hostId)
                              ?.name
                          }
                        </span>
                        <code>
                          {source.directory}/{source.pattern}
                        </code>
                      </p>
                      <small>
                        {source.encoding.toLowerCase() !== "utf-8"
                          ? `${source.encoding.toUpperCase()} · `
                          : ""}
                        最近扫描：
                        {date(source.lastScanAt)}
                      </small>
                    </>
                  ) : (
                    <>
                      {group.description && <p>{group.description}</p>}
                      <div className="source-tags">
                        {group.sourceIds.map((id) => (
                          <span key={id}>
                            {config.sources.find((s) => s.id === id)?.name}
                          </span>
                        ))}
                        {!group.sourceIds.length && (
                          <small>尚未添加日志源</small>
                        )}
                      </div>
                    </>
                  )}
                </div>
                <div className="resource-actions">
                  {kind === "groups" && (
                    <button
                      className="button primary"
                      onClick={() => viewGroup(group.id)}
                    >
                      <Eye size={14} />
                      查看日志
                    </button>
                  )}
                  {kind === "hosts" && (
                    <button
                      className="button secondary"
                      onClick={() => setProbe(host)}
                    >
                      <ShieldCheck size={14} />
                      测试连接
                    </button>
                  )}
                  <button
                    className="icon-button"
                    title="编辑配置"
                    aria-label={`编辑 ${item.name}`}
                    onClick={() => setEditing({ kind, item })}
                  >
                    <Pencil size={16} />
                  </button>
                  <ActionMenu label={`${item.name} 更多操作`} items={actions} />
                </div>
              </article>
            );
          })}
        </div>
      )}
      {editing && (
        <FormModal
          title={`${editing.item && !editing.copy ? "编辑" : "添加"}${formKind === "hosts" ? "主机" : formKind === "sources" ? "日志源" : "日志组"}`}
          close={() => setEditing(null)}
          save={save}
          key={`${editing.kind}:${editing.item?.id ?? editing.hostId ?? editing.sourceId ?? "new"}`}
        >
          <Field label="名称">
            <input
              autoFocus
              required
              maxLength={100}
              name="name"
              defaultValue={
                editing.item
                  ? editing.item.name + (editing.copy ? " · 副本" : "")
                  : ""
              }
              placeholder={
                formKind === "hosts"
                  ? "例如 prod-api-01"
                  : formKind === "sources"
                    ? "例如 API 访问日志"
                    : "例如 生产环境排查"
              }
            />
          </Field>
          {formKind === "hosts" ? (
            <>
              <div className="form-grid">
                <Field label="主机地址 / IP">
                  <input
                    required
                    name="address"
                    defaultValue={(editing.item as Host)?.address}
                    placeholder="10.0.0.8"
                  />
                </Field>
                <Field label="SSH 端口">
                  <input
                    required
                    type="number"
                    min={1}
                    max={65535}
                    name="port"
                    defaultValue={(editing.item as Host)?.port ?? 22}
                  />
                </Field>
              </div>
              <Field label="SSH 用户名">
                <input
                  required
                  name="username"
                  autoComplete="off"
                  defaultValue={(editing.item as Host)?.username}
                  placeholder="logreader"
                />
              </Field>
              <Field
                label={
                  editing.item && !editing.copy
                    ? "新密码（留空保留原密码）"
                    : "SSH 密码"
                }
                hint="密码经加密保存在服务端，保存后不会回显。"
              >
                <input
                  type="password"
                  name="password"
                  required={!editing.item || editing.copy}
                  autoComplete="new-password"
                />
              </Field>
            </>
          ) : formKind === "sources" ? (
            <SourcePreview
              sourceId={editing.copy ? undefined : editing.item?.id}
            >
              <Field label="Linux 主机">
                <select
                  required
                  name="hostId"
                  defaultValue={
                    (editing.item as Source)?.hostId ?? editing.hostId ?? ""
                  }
                >
                  <option value="">请选择主机</option>
                  {config.hosts.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name} · {h.address}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="日志目录"
                hint="绝对 Linux 路径；只扫描此目录，不递归子目录。"
              >
                <input
                  required
                  name="directory"
                  defaultValue={(editing.item as Source)?.directory}
                  placeholder="/var/log/myapp"
                />
              </Field>
              <div className="form-grid">
                <Field label="文件名模式">
                  <input
                    required
                    name="pattern"
                    defaultValue={(editing.item as Source)?.pattern ?? "*.log"}
                  />
                </Field>
                <Field label="文本编码">
                  <select
                    name="encoding"
                    defaultValue={(editing.item as Source)?.encoding ?? "utf-8"}
                  >
                    {["utf-8", "gb18030", "gb2312", "utf-16", "iso-8859-1"].map(
                      (x) => (
                        <option key={x}>{x}</option>
                      ),
                    )}
                  </select>
                </Field>
              </div>
            </SourcePreview>
          ) : (
            <>
              <Field label="描述">
                <textarea
                  name="description"
                  rows={2}
                  maxLength={500}
                  defaultValue={(editing.item as Group)?.description}
                  placeholder="这个日志组用于什么场景？"
                />
              </Field>
              <span className="field-label">选择日志源 · 可以跨主机</span>
              <input
                aria-label="搜索可选日志源"
                placeholder="搜索日志源或主机…"
                value={groupQuery}
                onChange={(e) => setGroupQuery(e.target.value)}
              />
              <div className="checkbox-list">
                {config.sources.map((s) => (
                  <label
                    key={s.id}
                    style={{
                      display:
                        `${s.name} ${config.hosts.find((h) => h.id === s.hostId)?.name}`
                          .toLowerCase()
                          .includes(groupQuery.toLowerCase())
                          ? undefined
                          : "none",
                    }}
                  >
                    <input
                      name="sourceIds"
                      value={s.id}
                      type="checkbox"
                      defaultChecked={
                        (editing.item as Group)?.sourceIds?.includes(s.id) ||
                        editing.sourceId === s.id
                      }
                    />
                    <span>
                      <strong>{s.name}</strong>
                      <small>
                        {config.hosts.find((h) => h.id === s.hostId)?.name} ·{" "}
                        {s.directory}
                      </small>
                    </span>
                  </label>
                ))}
                {!config.sources.length && (
                  <p className="helper">
                    先添加主机与日志源，再把来源加入此组。
                  </p>
                )}
              </div>
            </>
          )}
        </FormModal>
      )}
      {probe && (
        <Probe
          host={probe}
          close={() => setProbe(null)}
          changed={reload}
          next={() => {
            setEditing({ kind: "sources", hostId: probe.id });
            setProbe(null);
          }}
        />
      )}
    </div>
  );
}

function Probe({
  host,
  close,
  changed,
  next,
}: {
  next: () => void;
  host: Host;
  close: () => void;
  changed: () => Promise<void>;
}) {
  const [data, setData] = useState<{
      fingerprint: string | null;
      connected: boolean;
      message: string;
      previousFingerprint: string | null;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [checked, setChecked] = useState(false);
  async function test() {
    setBusy(true);
    setError("");
    try {
      setData(await api(`/hosts/${host.id}/probe`, {}));
      await changed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void test();
  }, []);
  const unknown =
    data?.fingerprint && data.fingerprint !== data.previousFingerprint;
  return (
    <Modal title={`连接测试 · ${host.name}`} close={close}>
      <div className="form-body">
        <div
          className={"connection-result " + (data?.connected ? "success" : "")}
        >
          <span>
            {busy ? (
              <Spinner />
            ) : data?.connected ? (
              <CheckCircle2 size={24} />
            ) : (
              <Fingerprint size={26} />
            )}
          </span>
          <h3>
            {busy
              ? "正在探测主机身份…"
              : data?.connected
                ? "SSH 连接成功"
                : "核验服务器身份"}
          </h3>
          <p>{data?.message}</p>
        </div>
        {data?.previousFingerprint && unknown && (
          <div className="alert error">
            <AlertTriangle size={16} />
            主机指纹与已保存的记录不同，请先联系服务器管理员核验。
          </div>
        )}
        {data?.fingerprint && (
          <Field label="探测到的 SSH SHA-256 指纹">
            <code className="fingerprint-box">{data.fingerprint}</code>
          </Field>
        )}
        {unknown && (
          <>
            <p className="helper">
              请通过服务器控制台或可信管理员核对指纹，再允许连接。未知主机不会进行密码认证。
            </p>
            <label className="check-line">
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => setChecked(e.target.checked)}
              />
              我已通过可信渠道核对上述主机指纹
            </label>
          </>
        )}
        {error && <div className="alert error">{error}</div>}
      </div>
      <footer className="form-footer">
        <button className="button secondary" onClick={close}>
          关闭
        </button>
        {data?.connected && !busy && (
          <button className="button primary" onClick={next}>
            添加此主机的日志源
            <ArrowRight size={14} />
          </button>
        )}
        {unknown ? (
          <button
            className="button primary"
            disabled={!checked || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api(`/hosts/${host.id}/trust`, {
                  fingerprint: data.fingerprint,
                });
                setChecked(false);
                await test();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <ShieldCheck size={15} />
            确认指纹并连接
          </button>
        ) : (
          <button
            className="button primary"
            disabled={busy}
            onClick={() => void test()}
          >
            重新测试
          </button>
        )}
      </footer>
    </Modal>
  );
}

function UserManager({ config, notify, user: actor }: Props) {
  const [users, setUsers] = useState<User[]>([]),
    [editing, setEditing] = useState<User | true | null>(null),
    [permissionUser, setPermissionUser] = useState<User | null>(null),
    [error, setError] = useState("");
  async function load() {
    try {
      setUsers(await api("/users"));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  const item = editing && editing !== true ? editing : null;
  return (
    <div className="management">
      <div className="page-heading">
        <div>
          <h1>
            团队成员<span>{users.length}</span>
          </h1>
        </div>
        <button className="button primary" onClick={() => setEditing(true)}>
          <Plus size={16} />
          添加成员
        </button>
      </div>
      {error && <div className="alert error">{error}</div>}
      <div className="resource-list">
        {users.map((u) => (
          <article className="resource-card" key={u.id}>
            <span className="avatar large">
              {u.displayName.slice(0, 1).toUpperCase()}
            </span>
            <div className="resource-main">
              <h3>
                {u.displayName}
                {u.id === actor.id && <span className="badge">当前账号</span>}
                <span className={"badge " + (u.enabled ? "green" : "")}>
                  {u.enabled ? "已启用" : "已停用"}
                </span>
              </h3>
              <p>
                {u.username} <span className="muted">· {roles[u.role]}</span>
              </p>
            </div>
            <div className="resource-actions">
              <button
                className="button secondary"
                onClick={() => setPermissionUser(u)}
              >
                <ShieldCheck size={14} />
                资源权限
              </button>
              <button
                className="icon-button"
                aria-label={`编辑成员 ${u.username}`}
                onClick={() => setEditing(u)}
              >
                <Pencil size={16} />
              </button>
            </div>
          </article>
        ))}
      </div>
      {editing && (
        <FormModal
          title={item ? "编辑团队成员" : "添加团队成员"}
          close={() => setEditing(null)}
          save={async (form) => {
            await api(
              `/users${item ? "/" + item.id : ""}`,
              {
                username: item?.username ?? text(form, "username"),
                displayName: text(form, "displayName"),
                role: text(form, "role"),
                password: text(form, "password") || null,
                enabled: form.has("enabled"),
              },
              item ? "PUT" : "POST",
            );
            await load();
            notify("成员信息已保存。");
          }}
        >
          <Field label="登录名">
            <input
              name="username"
              required
              disabled={!!item}
              defaultValue={item?.username}
              autoComplete="off"
            />
          </Field>
          <Field label="显示名称">
            <input
              name="displayName"
              required
              defaultValue={item?.displayName}
            />
          </Field>
          <Field label="角色">
            <select name="role" defaultValue={item?.role ?? "Viewer"}>
              {Object.entries(roles).map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label={item ? "重置密码（留空不修改）" : "初始密码"}
            hint="至少 12 位，包含大写、小写字母和数字。"
          >
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              required={!item}
            />
          </Field>
          <label className="check-line">
            <input
              type="checkbox"
              name="enabled"
              defaultChecked={item?.enabled ?? true}
            />
            启用此成员账号
          </label>
        </FormModal>
      )}
      {permissionUser && (
        <Permissions
          user={permissionUser}
          config={config}
          close={() => setPermissionUser(null)}
          notify={notify}
        />
      )}
    </div>
  );
}
function Permissions({
  user,
  config,
  close,
  notify,
}: {
  user: User;
  config: Config;
  close: () => void;
  notify: (text: string) => void;
}) {
  const [grants, setGrants] = useState<Grant[] | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api<Grant[]>(`/users/${user.id}/grants`)
      .then(setGrants)
      .catch((e) => setError(e.message));
  }, [user.id]);
  function change(
    scope: "host" | "group",
    id: string,
    field: "read" | "download" | "manage",
    value: boolean,
  ) {
    setGrants((old) => {
      const next = (old ?? []).filter(
        (g) => !(g.scope === scope && g.resourceId === id),
      );
      let grant = old?.find((g) => g.scope === scope && g.resourceId === id);
      if (field === "read" && !value) return next;
      grant = {
        scope,
        resourceId: id,
        download: false,
        manage: false,
        ...grant,
      };
      if (field !== "read") grant[field] = value;
      return next.concat(grant);
    });
  }
  return (
    <Modal title={`${user.displayName} · 资源权限`} close={close} wide>
      <div className="form-body">
        <div className="alert">
          <ShieldCheck size={16} />
          {user.role === "Admin"
            ? "管理员拥有全部资源权限，下方为实际权限，无需单独勾选。"
            : "访问日志需要同时获得日志组和对应主机的权限；下载也需两侧授权。"}
        </div>
        {error && <div className="alert error">{error}</div>}
        {grants === null ? (
          <Spinner />
        ) : (
          (["group", "host"] as const).map((scope) => (
            <div className="grant-section" key={scope}>
              <h3>{scope === "group" ? "共享日志组" : "Linux 主机"}</h3>
              <div className="grant-head">
                <span>资源</span>
                <span>读取</span>
                <span>下载</span>
                <span>维护</span>
              </div>
              {config[scope === "group" ? "groups" : "hosts"].map((item) => {
                const grant = grants.find(
                  (g) => g.scope === scope && g.resourceId === item.id,
                );
                return (
                  <div className="grant-row" key={item.id}>
                    <span>{item.name}</span>
                    {(["read", "download", "manage"] as const).map((field) => (
                      <input
                        key={field}
                        type="checkbox"
                        aria-label={`${item.name} ${field}`}
                        disabled={
                          user.role === "Admin" ||
                          (field === "manage" && user.role !== "Maintainer")
                        }
                        checked={
                          user.role === "Admin" ||
                          (field === "read"
                            ? !!grant
                            : field === "manage"
                              ? user.role === "Maintainer" && !!grant?.manage
                              : !!grant?.download)
                        }
                        onChange={(e) =>
                          change(scope, item.id, field, e.target.checked)
                        }
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          ))
        )}
        {grants !== null && (
          <div className="effective-access">
            <h3>
              实际可访问的日志源{" "}
              <small>
                {user.role === "Admin"
                  ? "管理员全部可用"
                  : "按当前勾选预览，保存后生效"}
              </small>
            </h3>
            {!user.enabled && (
              <p className="error-text">账号已停用，保存的授权暂不生效。</p>
            )}
            {config.groups.map((group) => {
              const groupGrant = grants.find(
                (g) => g.scope === "group" && g.resourceId === group.id,
              );
              return (
                <div className="effective-group" key={group.id}>
                  <strong>{group.name}</strong>
                  {group.sourceIds.map((id) => {
                    const source = config.sources.find((s) => s.id === id);
                    if (!source) return null;
                    const hostGrant = grants.find(
                      (g) =>
                        g.scope === "host" && g.resourceId === source.hostId,
                    );
                    const admin = user.role === "Admin",
                      allowed =
                        user.enabled &&
                        (admin || (!!groupGrant && !!hostGrant));
                    const canDownload =
                      allowed &&
                      (admin ||
                        (!!groupGrant?.download && !!hostGrant?.download));
                    const reason = !user.enabled
                      ? "账号已停用"
                      : !groupGrant && !hostGrant
                        ? "缺少组和主机授权"
                        : !groupGrant
                          ? "缺少日志组授权"
                          : "缺少主机授权";
                    return (
                      <div className="effective-row" key={id}>
                        <span>
                          {source.name}
                          <small>
                            {
                              config.hosts.find((h) => h.id === source.hostId)
                                ?.name
                            }
                          </small>
                        </span>
                        <span className={allowed ? "access-ok" : "error-text"}>
                          {allowed
                            ? `可读取 · ${canDownload ? "可下载" : "下载未授权"}`
                            : reason}
                        </span>
                      </div>
                    );
                  })}
                  {!group.sourceIds.length && (
                    <p className="helper">此组尚无日志源</p>
                  )}
                </div>
              );
            })}
            {user.role !== "Admin" && user.role !== "Maintainer" && (
              <p className="helper">
                当前角色不执行维护操作；读取和下载仍需日志组与主机两侧授权。
              </p>
            )}
          </div>
        )}
      </div>
      <footer className="form-footer">
        <button className="button secondary" onClick={close}>
          {user.role === "Admin" ? "完成" : "取消"}
        </button>
        {user.role !== "Admin" && (
          <button
            className="button primary"
            disabled={busy || grants === null}
            onClick={async () => {
              setBusy(true);
              try {
                await api(`/users/${user.id}/grants`, grants, "PUT");
                notify("资源权限已更新。");
                close();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            保存权限
          </button>
        )}
      </footer>
    </Modal>
  );
}

export function PasswordModal({
  close,
  notify,
}: {
  close: () => void;
  notify: (text: string) => void;
}) {
  return (
    <FormModal
      title="修改我的密码"
      close={close}
      save={async (data) => {
        if (data.get("newPassword") !== data.get("confirmPassword"))
          throw new Error("两次输入的新密码不一致。");
        await api("/password", {
          currentPassword: text(data, "currentPassword"),
          newPassword: text(data, "newPassword"),
        });
        notify("密码已更新。");
      }}
    >
      <Field label="当前密码">
        <input
          name="currentPassword"
          type="password"
          required
          autoComplete="current-password"
        />
      </Field>
      <Field label="新密码" hint="至少 12 位，包含大写、小写字母和数字。">
        <input
          name="newPassword"
          type="password"
          minLength={12}
          required
          autoComplete="new-password"
        />
      </Field>
      <Field label="再次输入新密码">
        <input
          name="confirmPassword"
          type="password"
          minLength={12}
          required
          autoComplete="new-password"
        />
      </Field>
    </FormModal>
  );
}

const actionLabel: Record<string, string> = {
  login: "账号登录",
  logout: "退出登录",
  "stream.started": "打开日志流",
  "stream.stopped": "停止日志流",
  "stream.failed": "日志流异常",
  "scan.started": "开始扫描",
  "scan.completed": "扫描完成",
  "scan.failed": "扫描失败",
  "download.started": "开始下载",
  "download.completed": "下载完成",
  "download.failed": "下载失败",
  "access.denied": "访问被拒绝",
  "permissions.updated": "更新资源权限",
  "host.created": "添加主机",
  "host.updated": "更新主机",
  "host.deleted": "删除主机",
  "host.probed": "测试主机连接",
  "host.fingerprint.confirmed": "确认主机指纹",
  "source.previewed": "预览目录匹配",
  "source.created": "添加日志源",
  "source.updated": "更新日志源",
  "source.deleted": "删除日志源",
  "group.created": "添加日志组",
  "group.updated": "更新日志组",
  "group.deleted": "删除日志组",
  "user.created": "添加成员",
  "user.updated": "更新成员",
  "setup.completed": "初始化工作台",
  "password.changed": "修改密码",
};
function AuditPage() {
  const [events, setEvents] = useState<Audit[]>([]),
    [q, setQ] = useState(""),
    [result, setResult] = useState(""),
    [period, setPeriod] = useState(""),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(""),
    [more, setMore] = useState(false);
  async function load(append = false) {
    setBusy(true);
    try {
      const params = new URLSearchParams({ q, result });
      if (period)
        params.set("since", String(Date.now() - Number(period) * 86400000));
      if (append && events.length)
        params.set("before", String(events.at(-1)!.id));
      const rows = await api<Audit[]>(`/audit?${params}`);
      setEvents((old) => (append ? old.concat(rows) : rows));
      setMore(rows.length === 100);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [q, result, period]);
  return (
    <div className="management">
      <div className="page-heading">
        <div>
          <h1>操作审计</h1>
        </div>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => void load()}
        >
          刷新记录
        </button>
      </div>
      <div className="resource-toolbar">
        <label className="search-field">
          <Search size={15} />
          <input
            aria-label="搜索审计记录"
            placeholder="搜索操作者、动作或目标…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <select
          aria-label="筛选审计结果"
          value={result}
          onChange={(e) => setResult(e.target.value)}
        >
          <option value="">全部结果</option>
          <option value="success">成功</option>
          <option value="failed">失败</option>
          <option value="denied">拒绝</option>
          <option value="blocked">阻止</option>
        </select>
        <select
          aria-label="筛选审计时间"
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
        >
          <option value="">全部时间</option>
          <option value="1">最近 24 小时</option>
          <option value="7">最近 7 天</option>
          <option value="30">最近 30 天</option>
        </select>
      </div>
      {error && <div className="alert error">{error}</div>}
      <div className="audit-table">
        <div className="audit-row header">
          <span>发生时间</span>
          <span>操作者</span>
          <span>操作</span>
          <span>目标资源</span>
          <span>结果</span>
        </div>
        {events.map((event) => (
          <div className="audit-row" key={event.id}>
            <time>{date(event.at)}</time>
            <strong>{event.actor || "匿名"}</strong>
            <span>{actionLabel[event.action] ?? event.action}</span>
            <code title={`${event.target}\n请求 ID: ${event.correlationId}`}>
              {event.target}
            </code>
            <span>
              <i
                className={
                  "badge " + (event.result === "success" ? "green" : "amber")
                }
              >
                {(
                  {
                    success: "成功",
                    failed: "失败",
                    denied: "拒绝",
                    blocked: "阻止",
                  } as Record<string, string>
                )[event.result] ?? event.result}
              </i>
            </span>
          </div>
        ))}
      </div>
      {!events.length && busy && (
        <div className="audit-loading" role="status">
          <Spinner />
          正在读取审计记录…
        </div>
      )}
      {!events.length && !busy && (
        <Empty icon={<ShieldCheck size={28} />} title="没有匹配的审计记录">
          尝试调整搜索条件。
        </Empty>
      )}
      {more && (
        <button
          className="load-more"
          disabled={busy}
          onClick={() => void load(true)}
        >
          {busy ? <Spinner /> : "加载更早记录"}
        </button>
      )}
    </div>
  );
}

function SourcePreview({
  sourceId,
  children,
}: {
  sourceId?: string;
  children: ReactNode;
}) {
  type Result = {
    files: { name: string; path: string; size: number; modifiedAt: number }[];
    examined: number;
    limited: boolean;
    checkedAt: number;
  };
  const [result, setResult] = useState<Result | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const version = useRef(0);
  useEffect(
    () => () => {
      version.current++;
    },
    [],
  );
  return (
    <div
      className="source-preview-fields"
      onChange={() => {
        version.current++;
        setResult(null);
        setError("");
        setBusy(false);
      }}
    >
      {children}
      <div className="preview-action">
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={async (e) => {
            const form = e.currentTarget.form!;
            const data = new FormData(form);
            if (
              !data.get("hostId") ||
              !data.get("directory") ||
              !data.get("pattern")
            ) {
              setError("请先选择主机并填写目录与文件名模式。");
              return;
            }
            const current = ++version.current;
            setBusy(true);
            setError("");
            setResult(null);
            try {
              const value = await api<Result>(
                `/sources/preview${sourceId ? `?sourceId=${sourceId}` : ""}`,
                {
                  name: String(data.get("name") || "目录预览"),
                  hostId: data.get("hostId"),
                  directory: data.get("directory"),
                  pattern: data.get("pattern"),
                  encoding: data.get("encoding"),
                },
              );
              if (current === version.current) setResult(value);
            } catch (err) {
              if (current === version.current) setError((err as Error).message);
            } finally {
              if (current === version.current) setBusy(false);
            }
          }}
        >
          {busy ? <Spinner /> : <Eye size={14} />}检查目录并预览匹配
        </button>
        <small>不保存配置 · 最多预览 20 个文件</small>
      </div>
      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
      {result && (
        <div className="source-preview-result" role="status">
          <strong>
            目录可读取 · {result.limited ? "已找到" : "匹配"}{" "}
            {result.files.length} 个文件
          </strong>
          <small>
            检查于 {date(result.checkedAt)}
            {result.limited ? " · 预览已达上限，完整清单请保存后扫描" : ""}
          </small>
          {!result.files.length && (
            <p>
              {result.limited
                ? "当前预览范围内无匹配；可缩小目录范围或保存后完整扫描。"
                : "目录可以访问，但文件名模式没有匹配结果，请检查模式。"}
            </p>
          )}
          <ul>
            {result.files.map((file) => (
              <li key={file.path}>
                <code title={file.path}>{file.name}</code>
                <span>{size(file.size)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
