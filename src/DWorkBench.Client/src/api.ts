export type User = {
  id: string;
  username: string;
  displayName: string;
  role: "Admin" | "Maintainer" | "Viewer" | "Auditor";
  enabled: boolean;
};
export type Host = {
  id: string;
  name: string;
  address: string;
  port: number;
  username: string;
  fingerprint: string | null;
  pendingFingerprint: string | null;
  hasPassword: boolean;
};
export type Scan = {
  state: "queued" | "scanning" | "completed" | "failed";
  count: number;
  error: string | null;
  startedAt: number;
};
export type Source = {
  id: string;
  hostId: string;
  name: string;
  directory: string;
  pattern: string;
  encoding: string;
  lastScanAt: number | null;
  lastScanError: string | null;
  scan: Scan | null;
};
export type Group = {
  id: string;
  name: string;
  description: string;
  sourceIds: string[];
};
export type Config = { hosts: Host[]; sources: Source[]; groups: Group[] };
export type LogFile = {
  id: number;
  sourceId: string;
  name: string;
  path: string;
  size: number;
  modifiedAt: number;
  hostName: string;
  hostId: string;
  sourceName: string;
  encoding?: string;
};
export type Grant = {
  scope: "host" | "group";
  resourceId: string;
  download: boolean;
  manage: boolean;
};
export type Audit = {
  id: number;
  at: number;
  actor: string;
  action: string;
  target: string;
  result: string;
  clientAddress: string;
  correlationId: string;
};
export type FilePage = {
  total: number;
  files: LogFile[];
  nextCursor: string | null;
  sources: Pick<Source, "id" | "lastScanAt" | "lastScanError" | "scan">[];
};
let csrf = "";
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  body?: unknown,
  method?: string,
  options: { keepalive?: boolean; signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch("/api" + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    credentials: "same-origin",
    ...options,
    headers:
      body === undefined && !method
        ? {}
        : { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error:
        response.status === 429
          ? "操作过于频繁，请稍后重试。"
          : response.status === 401
            ? "登录已失效，请重新登录。"
            : "操作失败，请稍后重试。",
    }));
    if (response.status === 401 && path !== "/login")
      window.dispatchEvent(new Event("session-expired"));
    throw new ApiError(error.error ?? "操作失败。", response.status);
  }
  return response.status === 204 || response.status === 202
    ? (undefined as T)
    : response.json();
}
export async function session() {
  const value = await api<{
    setupRequired: boolean;
    user: User | null;
    csrfToken: string;
  }>("/session");
  csrf = value.csrfToken;
  return value;
}
export function size(value: number) {
  const units = ["B", "KB", "MB", "GB"];
  let n = 0;
  while (value >= 1024 && n < 3) {
    value /= 1024;
    n++;
  }
  return `${value.toFixed(n ? 1 : 0)} ${units[n]}`;
}
export function date(value: number | null) {
  return value
    ? new Date(value).toLocaleString("zh-CN", { hour12: false })
    : "尚未扫描";
}
export const roles: Record<string, string> = {
  Admin: "管理员",
  Maintainer: "维护者",
  Viewer: "查看者",
  Auditor: "审计员",
};
