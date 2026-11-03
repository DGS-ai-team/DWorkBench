import { LogBuffer, type LogSettings } from "./logProcessing";
import { LogActivity, type WatchRule } from "./logActivity";
const activity = new LogActivity();
let receivedAt = Date.now(),
  isLive = false;
const buffer = new LogBuffer((row) => activity.add(row, receivedAt, isLive));
let frozen: LogBuffer | null = null;
let visible = true,
  epoch = 0,
  revision = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
function flush() {
  timer = undefined;
  const live = buffer.drain(),
    view = frozen ? frozen.drain() : live;
  if (visible)
    self.postMessage({
      type: "view",
      epoch,
      revision,
      ...view,
      stats: live.stats,
      displayedRetained: view.stats.retained,
      frozen: !!frozen,
    });
}
function schedule() {
  if (!timer) timer = setTimeout(flush, visible ? 100 : 1000);
}
setInterval(
  () => self.postMessage({ type: "activity", activity: activity.snapshot() }),
  1000,
);
self.onmessage = (
  event: MessageEvent<{
    type: string;
    chunk?: string;
    segments?: { chunk: string; live: boolean; at: number }[];
    settings?: LogSettings;
    rule?: WatchRule;
    epoch: number;
    revision?: number;
    frozen?: boolean;
    visible?: boolean;
  }>,
) => {
  const input = event.data;
  if (input.type === "append") {
    if (input.epoch === epoch)
      for (const segment of input.segments ?? [
        { chunk: input.chunk ?? "", live: true, at: Date.now() },
      ]) {
        receivedAt = segment.at;
        isLive = segment.live;
        buffer.ingest(segment.chunk);
      }
    self.postMessage({ type: "ack" });
    schedule();
  } else if (input.type === "settings") {
    revision = input.revision ?? revision;
    buffer.setSettings(input.settings!);
    frozen?.setSettings(input.settings!);
    schedule();
  } else if (input.type === "clear") {
    epoch = input.epoch;
    buffer.clear();
    frozen = null;
    activity.reset();
    schedule();
  } else if (input.type === "freeze") {
    frozen = input.frozen ? buffer.clone() : null;
    if (!frozen) buffer.resetView();
    schedule();
  } else if (input.type === "visibility") {
    visible = !!input.visible;
    if (visible) {
      buffer.resetView();
      frozen?.resetView();
      if (timer) clearTimeout(timer);
      flush();
    }
  } else if (input.type === "watch-rule") {
    activity.setRule(input.rule!);
    self.postMessage({ type: "activity", activity: activity.snapshot() });
  } else if (input.type === "acknowledge") {
    activity.acknowledge();
    self.postMessage({ type: "activity", activity: activity.snapshot() });
  }
};
