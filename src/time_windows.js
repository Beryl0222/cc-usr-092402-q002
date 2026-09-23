// 时间区间工具：统一使用半开区间 [start, end)，毫秒比较。
// 半开语义让相邻班次（08:00-12:00 与 12:00-16:00）既不重叠也无缝隙。

export function t(value) {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

export function interval(start, end) {
  const s = t(start);
  const e = t(end);
  if (!Number.isFinite(s) || !Number.isFinite(e)) throw new Error("无法解析的时间");
  if (e <= s) throw new Error(`区间结束必须晚于开始: ${start} ~ ${end}`);
  return Object.freeze({ start: s, end: e });
}

export function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

export function contains(outer, inner) {
  return outer.start <= inner.start && inner.end <= outer.end;
}

export function intersection(a, b) {
  const s = Math.max(a.start, b.start);
  const e = Math.min(a.end, b.end);
  return e > s ? { start: s, end: e } : null;
}

// a \\ b：从区间 a 中扣除 b，返回 0~2 个区间。
export function subtract(a, b) {
  const cut = intersection(a, b);
  if (!cut) return [{ ...a }];
  const out = [];
  if (a.start < cut.start) out.push({ start: a.start, end: cut.start });
  if (cut.end < a.end) out.push({ start: cut.end, end: a.end });
  return out;
}

// 把 period 按 cuts（任意边界时刻）切成薄片。
export function sliceBy(period, cuts) {
  const bounds = [...new Set(cuts.filter((x) => x > period.start && x < period.end))].sort((a, b) => a - b);
  const slices = [];
  let cursor = period.start;
  for (const bound of bounds) {
    slices.push({ start: cursor, end: bound });
    cursor = bound;
  }
  slices.push({ start: cursor, end: period.end });
  return slices;
}

// 多个窗口的并集是否完整覆盖 period（允许相邻拼接）。
export function unionCoveredDuration(windows, period) {
  const hits = windows
    .map((w) => intersection(w, period))
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
  let covered = 0;
  let cur = null;
  for (const win of hits) {
    if (!cur) {
      cur = { ...win };
    } else if (win.start <= cur.end) {
      cur.end = Math.max(cur.end, win.end);
    } else {
      covered += cur.end - cur.start;
      cur = { ...win };
    }
  }
  if (cur) covered += cur.end - cur.start;
  return covered;
}

export function fullyCovered(windows, period) {
  return unionCoveredDuration(windows, period) >= period.end - period.start;
}

// 找出 period 中未被 windows 覆盖的缝隙（无人负责的路线段时段即由此得出）。
export function uncoveredGaps(windows, period) {
  const merged = windows
    .map((w) => intersection(w, period))
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
  const gaps = [];
  let cursor = period.start;
  for (const win of merged) {
    if (win.start > cursor) gaps.push({ start: cursor, end: win.start });
    cursor = Math.max(cursor, win.end);
  }
  if (cursor < period.end) gaps.push({ start: cursor, end: period.end });
  return gaps;
}

export function iso(ms) {
  return new Date(ms).toISOString();
}
