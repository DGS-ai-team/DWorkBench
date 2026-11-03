import { useEffect, useRef, useState } from "react";
import { api, ApiError, type LogFile } from "./api";
import { type LogSettings } from "./logProcessing";
import { type WatchRule } from "./logActivity";

export type WorkspaceItem = {
  key: string;
  groupId: string;
  sourceId: string;
  hostId: string;
  path: string;
  encoding: string;
  settings: LogSettings;
  wrap: boolean;
  watchRule: WatchRule;
};
export type WorkspaceDocument = {
  version: 1;
  groupId: string | null;
  items: WorkspaceItem[];
  reading: string[];
  active: string;
  pinned: string;
  vertical: boolean;
  split: number;
  watchOpen: boolean;
};
export type ResolvedItem = {
  key: string;
  file: LogFile | null;
  issue: string | null;
};
type SavedWorkspace = {
  ownerId: string;
  revision: string | null;
  updatedAt: number | null;
  document: WorkspaceDocument | null;
  resolved: ResolvedItem[];
};
type Draft = {
  ownerId: string;
  revision: string | null;
  document: WorkspaceDocument;
  updatedAt?: number;
};
type DraftEntry = { key: string; raw: string; draft: Draft };
export const emptyWorkspace: WorkspaceDocument = {
  version: 1,
  groupId: null,
  items: [],
  reading: [],
  active: "",
  pinned: "",
  vertical: false,
  split: 50,
  watchOpen: true,
};
const fingerprint = (document: WorkspaceDocument) =>
  JSON.stringify(document, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  );

function readDraft(key: string, owner: string): Draft | null {
  try {
    const draft = JSON.parse(
      localStorage.getItem(key) ?? "null",
    ) as Draft | null;
    const d = draft?.document;
    const guid = (value: unknown) =>
      typeof value === "string" &&
      /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
    const text = (value: unknown, max: number) =>
      typeof value === "string" && value.length <= max && !value.includes("\0");
    if (
      !draft ||
      draft.ownerId !== owner ||
      (draft.revision !== null && !text(draft.revision, 64)) ||
      !d ||
      d.version !== 1 ||
      (d.groupId !== null && !guid(d.groupId)) ||
      typeof d.vertical !== "boolean" ||
      typeof d.watchOpen !== "boolean" ||
      !Array.isArray(d.items) ||
      d.items.length > 4 ||
      !Array.isArray(d.reading) ||
      d.reading.length > 2 ||
      typeof d.active !== "string" ||
      typeof d.pinned !== "string" ||
      !Number.isFinite(d.split) ||
      d.split < 25 ||
      d.split > 75
    )
      return null;
    for (const item of d.items) {
      if (
        !item ||
        ![item.key, item.groupId, item.sourceId, item.hostId].every(guid) ||
        !text(item.path, 2048) ||
        !item.path.startsWith("/") ||
        /[\x00-\x1f\x7f]/.test(item.path) ||
        item.path.split("/").some((x) => x === "." || x === "..") ||
        !text(item.encoding, 80) ||
        typeof item.wrap !== "boolean" ||
        !item.settings ||
        !item.watchRule ||
        !text(item.watchRule.pattern, 512) ||
        !["text", "glob", "regex"].includes(item.watchRule.mode) ||
        typeof item.watchRule.caseSensitive !== "boolean"
      )
        return null;
      const s = item.settings;
      if (
        ![s.include, s.exclude, s.jsonField, s.levelPattern].every((v) =>
          text(v, 512),
        ) ||
        !["text", "glob", "regex"].includes(s.mode) ||
        !["auto", "text", "json", "custom"].includes(s.format) ||
        !["all", "warnings", "errors", "unknown"].includes(s.levels) ||
        typeof s.caseSensitive !== "boolean" ||
        !Number.isInteger(s.context) ||
        s.context < 0 ||
        s.context > 10
      )
        return null;
    }
    const keys = new Set(d.items.map((i) => i.key));
    if (
      keys.size !== d.items.length ||
      new Set(d.reading).size !== d.reading.length ||
      d.reading.some((k) => !keys.has(k)) ||
      (d.active !== "" && !d.reading.includes(d.active)) ||
      (d.pinned !== "" && !d.reading.includes(d.pinned))
    )
      return null;
    return draft;
  } catch {
    return null;
  }
}

function newestDraft(
  owner: string,
  saved: WorkspaceDocument,
): DraftEntry | null {
  try {
    const keys = Object.keys(localStorage).filter(
      (k) =>
        k.startsWith(`logdesk:workspace-draft:v2:${owner}:`) ||
        k === `logdesk:workspace-draft:v1:${owner}`,
    );
    const entries = keys.flatMap((key) => {
      const draft = readDraft(key, owner),
        raw = localStorage.getItem(key);
      if (!draft || !raw) return [];
      const entry = { key, raw, draft };
      if (fingerprint(draft.document) === fingerprint(saved)) {
        removeDraft(entry);
        return [];
      }
      return [entry];
    });
    entries.sort((a, b) => (b.draft.updatedAt ?? 0) - (a.draft.updatedAt ?? 0));
    return entries[0] ?? null;
  } catch {
    return null;
  }
}
function removeDraft(entry: DraftEntry | null) {
  if (!entry) return;
  try {
    // V2 entries are immutable and uniquely named. Other tabs never replace
    // this key; the equality guard also protects legacy V1 drafts.
    if (localStorage.getItem(entry.key) === entry.raw)
      localStorage.removeItem(entry.key);
  } catch {
    /* Storage may be unavailable. */
  }
}

// Persist only the explicit configuration DTO. Rows, activity excerpts, credentials,
// live connection state and pending network frames never enter this hook.
export function useWorkspacePersistence(
  ownerId: string | null,
  document: WorkspaceDocument,
  apply: (document: WorkspaceDocument, resolved: ResolvedItem[]) => void,
) {
  const [loadedOwner, setLoadedOwner] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [loading, setLoading] = useState(false);
  const epoch = useRef(0),
    owner = useRef<string | null>(null);
  const current = useRef(document),
    applyRef = useRef(apply);
  current.current = document;
  applyRef.current = apply;
  const revision = useRef<string | null>(null),
    lastSaved = useRef("");
  const blocked = useRef(false),
    hydrated = useRef(false);
  const flight = useRef<Promise<boolean> | null>(null);
  const ownDraft = useRef<DraftEntry | null>(null);
  const recoveredDraft = useRef<DraftEntry | null>(null);
  function journal(id: string) {
    const serialized = fingerprint(current.current);
    if (serialized === lastSaved.current) return;
    const previous = ownDraft.current;
    try {
      if (
        previous?.draft.ownerId === id &&
        previous.draft.revision === revision.current &&
        fingerprint(previous.draft.document) === serialized &&
        localStorage.getItem(previous.key) === previous.raw
      )
        return;
      const draft: Draft = {
        ownerId: id,
        revision: revision.current,
        document: current.current,
        updatedAt: Date.now(),
      };
      const entry = {
        key: `logdesk:workspace-draft:v2:${id}:${crypto.randomUUID()}`,
        raw: JSON.stringify(draft),
        draft,
      };
      localStorage.setItem(entry.key, entry.raw);
      ownDraft.current = entry;
      removeDraft(previous);
      removeDraft(recoveredDraft.current);
      recoveredDraft.current = null;
    } catch {
      /* Server persistence still works when local storage is unavailable. */
    }
  }
  async function load(discardDraft = false) {
    const id = owner.current,
      token = epoch.current;
    if (!id) return;
    setLoading(true);
    try {
      const saved = await api<SavedWorkspace>(
        "/workspace",
        undefined,
        undefined,
        { signal: AbortSignal.timeout(10000) },
      );
      if (epoch.current !== token) return;
      if (saved.ownerId !== id) {
        window.dispatchEvent(new Event("session-expired"));
        return;
      }
      const serverDocument = saved.document ?? emptyWorkspace;
      const entry = discardDraft ? null : newestDraft(id, serverDocument);
      const draft = entry?.draft;
      let selected = draft?.document ?? serverDocument;
      let differs = fingerprint(selected) !== fingerprint(serverDocument);
      let collision = !!draft && differs && draft.revision !== saved.revision;
      let resolved = saved.resolved;
      if (draft && differs) {
        try {
          resolved = (
            await api<{ resolved: ResolvedItem[] }>(
              "/workspace/resolve",
              { ownerId: id, items: selected.items },
              undefined,
              { signal: AbortSignal.timeout(10000) },
            )
          ).resolved;
        } catch (e) {
          if (!(e instanceof ApiError) || e.status !== 400) throw e;
          // Corrupted local drafts must not lock a user out of a valid server copy.
          selected = serverDocument;
          differs = false;
          collision = false;
        }
      }
      if (epoch.current !== token) return;
      if (discardDraft) {
        removeDraft(ownDraft.current);
        removeDraft(recoveredDraft.current);
        ownDraft.current = null;
      }
      recoveredDraft.current = entry;
      // Keep the draft's stale base while a conflict is unresolved. Otherwise a
      // refresh would make it look current and silently bypass the user's choice.
      revision.current = collision ? draft!.revision : saved.revision;
      lastSaved.current = fingerprint(serverDocument);
      blocked.current = collision;
      hydrated.current = true;
      current.current = selected;
      applyRef.current(selected, resolved);
      setLoadedOwner(id);
      setConflict(collision);
      setError(
        collision
          ? "本机草稿与其他页面保存的版本不同，请选择要保留的工作台。"
          : "",
      );
      if (discardDraft || !differs) {
        removeDraft(recoveredDraft.current);
        recoveredDraft.current = null;
      }
    } catch (e) {
      if (epoch.current === token)
        setError((e as Error).message || "读取工作台失败，请重试。");
    } finally {
      if (epoch.current === token) setLoading(false);
    }
  }
  async function flush(keepalive = false): Promise<boolean> {
    const id = owner.current,
      token = epoch.current;
    if (!id || !hydrated.current || blocked.current) return false;
    if (flight.current) {
      if (!(await flight.current) || epoch.current !== token) return false;
      return flush(keepalive);
    }
    const sent = current.current,
      serialized = fingerprint(sent);
    if (serialized === lastSaved.current) return true;
    journal(id);
    const save = (async () => {
      try {
        const result = await api<{ ownerId: string; revision: string }>(
          "/workspace",
          { ownerId: id, revision: revision.current, document: sent },
          "PUT",
          { keepalive, signal: AbortSignal.timeout(10000) },
        );
        if (epoch.current !== token || result.ownerId !== id) return false;
        revision.current = result.revision;
        lastSaved.current = serialized;
        setError("");
        removeDraft(recoveredDraft.current);
        recoveredDraft.current = null;
        if (fingerprint(current.current) !== serialized) journal(id);
        else {
          removeDraft(ownDraft.current);
          ownDraft.current = null;
        }
        return true;
      } catch (e) {
        if (epoch.current === token) {
          const collision = e instanceof ApiError && e.status === 409;
          blocked.current = collision;
          setConflict(collision);
          setError(
            collision
              ? e.message
              : "工作台尚未保存到服务器，请重试后再关闭页面。",
          );
        }
        return false;
      } finally {
        if (epoch.current === token) flight.current = null;
      }
    })();
    flight.current = save;
    const ok = await save;
    if (
      ok &&
      epoch.current === token &&
      fingerprint(current.current) !== lastSaved.current
    )
      return flush(keepalive);
    return ok;
  }
  const latestFlush = useRef(flush);
  latestFlush.current = flush;
  useEffect(() => {
    epoch.current++;
    owner.current = ownerId;
    hydrated.current = false;
    flight.current = null;
    blocked.current = false;
    ownDraft.current = null;
    recoveredDraft.current = null;
    setLoadedOwner(null);
    setError("");
    setConflict(false);
    if (ownerId) void load();
    return () => {
      epoch.current++;
      hydrated.current = false;
    };
  }, [ownerId]);
  const serialized = fingerprint(document);
  useEffect(() => {
    if (!ownerId || loadedOwner !== ownerId || !hydrated.current) return;
    if (serialized === lastSaved.current) {
      removeDraft(ownDraft.current);
      ownDraft.current = null;
      return;
    }
    journal(ownerId);
    const timer = setTimeout(() => void latestFlush.current(), 500);
    return () => clearTimeout(timer);
  }, [serialized, ownerId, loadedOwner]);
  useEffect(() => {
    const leave = () => {
      if (
        owner.current &&
        hydrated.current &&
        fingerprint(current.current) !== lastSaved.current
      ) {
        journal(owner.current);
        void latestFlush.current(true);
      }
    };
    const hide = () => {
      if (documentVisibility()) leave();
    };
    const online = () => void latestFlush.current();
    window.addEventListener("pagehide", leave);
    window.addEventListener("online", online);
    window.document.addEventListener("visibilitychange", hide);
    return () => {
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("online", online);
      window.document.removeEventListener("visibilitychange", hide);
    };
  }, []);
  async function keepCurrent() {
    const id = owner.current,
      token = epoch.current;
    if (!id) return;
    try {
      const saved = await api<SavedWorkspace>("/workspace");
      if (epoch.current !== token) return;
      if (saved.ownerId !== id) {
        window.dispatchEvent(new Event("session-expired"));
        return;
      }
      revision.current = saved.revision;
      blocked.current = false;
      setConflict(false);
      setError("");
      lastSaved.current = fingerprint(saved.document ?? emptyWorkspace);
      await latestFlush.current();
    } catch (e) {
      if (epoch.current === token) setError((e as Error).message);
    }
  }
  return {
    loaded: !!ownerId && loadedOwner === ownerId,
    loading,
    error,
    conflict,
    flush: () => latestFlush.current(),
    retry: () => (hydrated.current ? latestFlush.current() : load()),
    loadSaved: () => load(true),
    keepCurrent,
  };
}
function documentVisibility() {
  return window.document.visibilityState === "hidden";
}
