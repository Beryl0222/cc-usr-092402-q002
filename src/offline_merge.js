// 离线消息合并：无线网络中断期间产生的位置与伤情消息，在恢复后按来源序列合并。
// 合并语义与消息到达顺序无关：
//   - 以 (source_id, seq) 去重，同一来源的消息严格按 seq 应用；
//   - 位置只保留各来源最新一条，旧序号到达即丢弃；
//   - 转运状态单调推进，已完成（HANDED_OVER）等较新事实不可被较晚到达的旧消息回退；
//   - 伤情按来源分别保留最新报告，有效报告取各来源中序号最大者。

export const TRANSPORT_STATUSES = Object.freeze([
  "REPORTED",
  "DISPATCHED",
  "ARRIVED",
  "TRANSPORTING",
  "HANDED_OVER",
]);

const rankOf = (status) => TRANSPORT_STATUSES.indexOf(status);

export function createMergeState() {
  return {
    seen: new Set(), // `${source_id}:${seq}` 去重表
    positions: new Map(), // unit_id -> { source_id, seq, position, occurred_at }
    transports: new Map(), // transport_id -> { status, source_id, seq, updated_at, history: [...] }
    casualties: new Map(), // casualty_id -> Map(source_id -> { seq, report })
  };
}

// 合并一批（可能乱序、可能重复）恢复上传的消息。
// 返回 { applied, rejected }，rejected 中注明丢弃原因以便审计。
export function mergeMessages(state, messages) {
  const applied = [];
  const rejected = [];
  const sorted = [...messages].sort(
    (a, b) => String(a.source_id).localeCompare(String(b.source_id)) || a.seq - b.seq,
  );
  for (const m of sorted) {
    const key = `${m.source_id}:${m.seq}`;
    if (state.seen.has(key)) {
      rejected.push({ message: m, reason: "DUPLICATE" });
      continue;
    }
    state.seen.add(key);

    if (m.kind === "POSITION_REPORTED") {
      const current = state.positions.get(m.unit_id);
      if (current && current.source_id === m.source_id && current.seq >= m.seq) {
        rejected.push({ message: m, reason: "STALE_POSITION" });
        continue;
      }
      state.positions.set(m.unit_id, {
        source_id: m.source_id,
        seq: m.seq,
        position: m.position,
        occurred_at: m.occurred_at,
      });
      applied.push(m);
    } else if (m.kind === "TRANSPORT_STATUS_RECORDED") {
      const current = state.transports.get(m.transport_id);
      if (current && rankOf(m.status) < rankOf(current.status)) {
        rejected.push({ message: m, reason: "MONOTONIC_VIOLATION" });
        continue;
      }
      if (current && rankOf(m.status) === rankOf(current.status) && current.status !== m.status) {
        rejected.push({ message: m, reason: "STATUS_CONFLICT" });
        continue;
      }
      state.transports.set(m.transport_id, {
        status: m.status,
        source_id: m.source_id,
        seq: m.seq,
        updated_at: m.occurred_at,
        history: [
          ...(current?.history ?? []),
          { status: m.status, source_id: m.source_id, seq: m.seq, occurred_at: m.occurred_at },
        ],
      });
      applied.push(m);
    } else if (m.kind === "CASUALTY_REPORTED") {
      const perSource = state.casualties.get(m.casualty_id) ?? new Map();
      const prev = perSource.get(m.source_id);
      if (prev && prev.seq >= m.seq) {
        rejected.push({ message: m, reason: "STALE_REPORT" });
        continue;
      }
      perSource.set(m.source_id, { seq: m.seq, report: m.report });
      state.casualties.set(m.casualty_id, perSource);
      applied.push(m);
    } else {
      rejected.push({ message: m, reason: "UNKNOWN_KIND" });
    }
  }
  return { applied, rejected };
}

// 某伤员的当前有效报告：各来源各自最新，再取序号最大者（序号并列时以来源 id 字典序定胜负，保证确定性）。
export function effectiveCasualty(state, casualtyId) {
  const perSource = state.casualties.get(casualtyId);
  if (!perSource) return null;
  return [...perSource.entries()]
    .sort((a, b) => b[1].seq - a[1].seq || String(a[0]).localeCompare(String(b[0])))[0][1].report;
}

// 便于断言与持久化的快照（普通对象，无 Set/Map）。
export function snapshotMergeState(state) {
  return {
    positions: Object.fromEntries(state.positions),
    transports: Object.fromEntries(
      [...state.transports].map(([id, t]) => [id, { status: t.status, source_id: t.source_id, seq: t.seq, updated_at: t.updated_at }]),
    ),
    casualties: Object.fromEntries([...state.casualties.keys()].map((id) => [id, effectiveCasualty(state, id)])),
  };
}
