// 版本回放：现场指挥重新播放任一方案版本，还原当时的
// 各段覆盖缺口、获批替代资源与实际转运偏差。
// 回放只读事件流，不触碰占用台账；重复的发布事件按幂等忽略。

import { toMs } from "./time.js";

const MINUTES = 60_000;

export function replayPlan(events, planId, version = null) {
  const versions = new Map(); // version -> { published_at, coverage }
  const substitutions = new Map(); // version -> [substitution]
  const transports = new Map(); // transport_id -> { segment_id, reported_at, arrived_at, completed_at, planned_total_minutes }

  const ensureVersion = (v) => {
    if (!versions.has(v)) versions.set(v, { published_at: null, coverage: null });
    return versions.get(v);
  };
  const ensureTransport = (id) => {
    if (!transports.has(id)) {
      transports.set(id, { segment_id: null, reported_at: null, arrived_at: null, completed_at: null, planned_total_minutes: null });
    }
    return transports.get(id);
  };

  for (const e of events) {
    const p = e.payload ?? {};
    if (p.plan_id !== planId) continue;
    if (e.kind === "PLAN_VERSION_PUBLISHED") {
      const rec = ensureVersion(p.version);
      if (rec.published_at === null) rec.published_at = e.occurred_at; // 重复发布幂等
    } else if (e.kind === "COVERAGE_SNAPSHOT_RECORDED") {
      ensureVersion(p.version).coverage = p;
    } else if (e.kind === "SUBSTITUTION_APPROVED") {
      const list = substitutions.get(p.version) ?? [];
      list.push(p.substitution);
      substitutions.set(p.version, list);
    } else if (e.kind === "TRANSPORT_STATUS_RECORDED") {
      const t = ensureTransport(p.transport_id);
      t.segment_id = p.segment_id ?? t.segment_id;
      t.planned_total_minutes = p.planned_total_minutes ?? t.planned_total_minutes;
      if (p.status === "REPORTED" && t.reported_at === null) t.reported_at = e.occurred_at;
      if (p.status === "ARRIVED" && t.arrived_at === null) t.arrived_at = e.occurred_at;
      if (p.status === "HANDED_OVER" && t.completed_at === null) t.completed_at = e.occurred_at;
    } else if (e.kind === "HANDOFF_COMPLETED") {
      const t = ensureTransport(p.transport_id);
      t.segment_id = p.segment_id ?? t.segment_id;
      if (t.completed_at === null) t.completed_at = e.occurred_at; // 已完成事实不被旧消息回退
    }
  }

  const target = version ?? (versions.size ? Math.max(...versions.keys()) : null);
  const rec = target === null ? null : ensureVersion(target);
  const segments = rec?.coverage?.segments ?? [];
  const targetBySegment = new Map(segments.map((s) => [s.segment_id, s.required?.target_minutes]));

  const deviations = [];
  for (const [transportId, t] of transports) {
    if (t.reported_at === null) continue;
    const dev = { transport_id: transportId, segment_id: t.segment_id };
    if (t.arrived_at !== null) {
      dev.response_minutes = (toMs(t.arrived_at) - toMs(t.reported_at)) / MINUTES;
      const targetMinutes = targetBySegment.get(t.segment_id);
      if (targetMinutes !== undefined) {
        dev.target_minutes = targetMinutes;
        dev.response_deviation = dev.response_minutes - targetMinutes;
      }
    }
    if (t.completed_at !== null) {
      dev.total_minutes = (toMs(t.completed_at) - toMs(t.reported_at)) / MINUTES;
      if (t.planned_total_minutes !== null) {
        dev.planned_total_minutes = t.planned_total_minutes;
        dev.total_deviation = dev.total_minutes - t.planned_total_minutes;
      }
    }
    deviations.push(dev);
  }

  return {
    plan_id: planId,
    version: target,
    published_at: rec?.published_at ?? null,
    coverage_gaps: segments
      .filter((s) => !s.covered)
      .map((s) => ({ segment_id: s.segment_id, shortfall: s.shortfall, reasons: s.reasons })),
    substitutions: substitutions.get(target) ?? [],
    deviations,
  };
}
