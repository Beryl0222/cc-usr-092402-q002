// 时间窗口工具：统一使用 ISO 8601 字符串（含时区偏移），内部换算为毫秒比较。

export const toMs = (iso) => Date.parse(iso);

export const toIso = (ms) => new Date(ms).toISOString();

// 半开区间 [start, end) 是否相交。
export function overlaps(a, b) {
  return toMs(a.start) < toMs(b.end) && toMs(b.start) < toMs(a.end);
}

// 时刻 ms 是否落在半开区间 [start, end) 内。
export function containsMs(window, ms) {
  return toMs(window.start) <= ms && ms < toMs(window.end);
}

// 任一窗口是否覆盖给定 ISO 时刻。
export function coversInstant(windows, iso) {
  const t = toMs(iso);
  return windows.some((w) => containsMs(w, t));
}

// 合并重叠或首尾相接的窗口，返回按开始时间排序的最简区间集。
// 边界保留输入的原始字符串（如 "+08:00" 偏移），便于领域核对。
export function unionWindows(windows) {
  const sorted = windows
    .map((w) => ({ startMs: toMs(w.start), endMs: toMs(w.end), start: w.start, end: w.end }))
    .filter((w) => w.startMs < w.endMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged = [];
  for (const w of sorted) {
    const last = merged[merged.length - 1];
    if (last && w.startMs <= last.endMs) {
      if (w.endMs > last.endMs) {
        last.endMs = w.endMs;
        last.end = w.end;
      }
    } else {
      merged.push({ ...w });
    }
  }
  return merged.map((w) => ({ start: w.start, end: w.end }));
}

// 从 window 中扣除 cuts，返回剩余空档。边界保留输入的原始字符串。
export function subtractWindow(window, cuts) {
  const label = new Map([
    [toMs(window.start), window.start],
    [toMs(window.end), window.end],
  ]);
  for (const c of cuts) {
    label.set(toMs(c.start), c.start);
    label.set(toMs(c.end), c.end);
  }
  const iso = (ms) => label.get(ms) ?? toIso(ms);
  const startMs = toMs(window.start);
  const endMs = toMs(window.end);
  const relevant = cuts
    .filter((c) => overlaps(window, c))
    .map((c) => ({ start: Math.max(toMs(c.start), startMs), end: Math.min(toMs(c.end), endMs) }))
    .sort((a, b) => a.start - b.start);
  const rest = [];
  let cursor = startMs;
  for (const c of relevant) {
    if (c.start > cursor) rest.push({ start: iso(cursor), end: iso(c.start) });
    cursor = Math.max(cursor, c.end);
  }
  if (cursor < endMs) rest.push({ start: iso(cursor), end: iso(endMs) });
  return rest;
}
