// 突发扰动与局部重算：方案审批/发布后，针对突发高温、道路封闭或设备失效
// 只重算受影响的分段，并给出不触碰已发布方案的替代建议。

import { capabilityMeets, computeCoverage, diffCoverage, shortestMinutes } from "./coverage.js";
import { containsMs, coversInstant, toMs } from "./time.js";

const RISK_RANK = Object.freeze({ low: 0, medium: 1, high: 2 });

function raiseRisk(current, raiseTo) {
  const target = raiseTo ?? (current === "low" ? "medium" : "high");
  return RISK_RANK[target] > RISK_RANK[current] ? target : current;
}

// 将扰动作用于世界模型的副本，原世界不被修改。
// 扰动种类：
//   road_closure:      { kind, from, to, window, bidirectional? }  移除行驶边（默认双向）
//   heat_wave:         { kind, segment_ids, window, raise_to? }     提升分段风险等级
//   equipment_failure: { kind, vehicle_id, capability_lost, window } 车辆失去某项能力
export function applyDisruptions(world, disruptions, at) {
  const atMs = toMs(at);
  const next = structuredClone(world);
  for (const d of disruptions ?? []) {
    if (d.window && !containsMs(d.window, atMs)) continue;
    if (d.kind === "road_closure") {
      const bothWays = d.bidirectional !== false;
      next.travel = next.travel.filter(
        (e) => !(e.from === d.from && e.to === d.to) && !(bothWays && e.from === d.to && e.to === d.from),
      );
    } else if (d.kind === "heat_wave") {
      next.segments = next.segments.map((s) =>
        d.segment_ids.includes(s.id) ? { ...s, risk_level: raiseRisk(s.risk_level, d.raise_to) } : s,
      );
    } else if (d.kind === "equipment_failure") {
      next.vehicles = next.vehicles.map((v) =>
        v.id === d.vehicle_id
          ? { ...v, capabilities: v.capabilities.filter((c) => c !== d.capability_lost) }
          : v,
      );
    }
  }
  return next;
}

// 局部重算：返回受影响分段集合及这些分段在扰动后的最新覆盖。
// 影响面由扰动前后的覆盖差异界定；未受影响的分段不在结果中重复出现。
export function partialRecompute(worldBefore, disruptions, at, policy) {
  const worldAfter = applyDisruptions(worldBefore, disruptions, at);
  const before = computeCoverage(worldBefore, at, policy);
  const after = computeCoverage(worldAfter, at, policy);
  const affected = diffCoverage(before, after);
  return {
    at,
    affected_segment_ids: affected,
    segments: after.segments.filter((s) => affected.includes(s.segment_id)),
    world: worldAfter,
  };
}

// 针对未覆盖分段的替代建议：优先指派未被已发布方案占用的空闲合格资源，
// 找不到时请求外部增援。建议只描述“可以怎么做”，不直接改动任何方案。
export function suggestSubstitutions(world, coverage, assignments, policy) {
  const busy = new Set((assignments ?? []).map((a) => a.resource_id));
  const segmentNode = new Map((world.segments ?? []).map((s) => [s.id, s.node]));
  const suggestions = [];
  for (const seg of coverage.segments.filter((s) => !s.covered)) {
    const node = segmentNode.get(seg.segment_id);
    const need = seg.required;
    const idle = (world.vehicles ?? [])
      .filter((v) => !busy.has(v.id))
      .filter((v) => coversInstant(v.available_windows, coverage.at))
      .filter((v) => v.capabilities.some((c) => capabilityMeets(c, need.capability)))
      .map((v) => ({ resource_id: v.id, eta_minutes: shortestMinutes(world, v.node, node) }))
      .filter((c) => c.eta_minutes <= need.target_minutes)
      .sort((a, b) => a.eta_minutes - b.eta_minutes);
    if (idle.length > 0) {
      suggestions.push({
        type: "ASSIGN_IDLE_RESOURCE",
        segment_id: seg.segment_id,
        resource_id: idle[0].resource_id,
        eta_minutes: idle[0].eta_minutes,
      });
    } else {
      suggestions.push({
        type: "REQUEST_EXTERNAL_SUBSTITUTION",
        segment_id: seg.segment_id,
        capability: need.capability,
        units: seg.shortfall,
      });
    }
  }
  return suggestions;
}
