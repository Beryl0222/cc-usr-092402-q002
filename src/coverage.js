// 覆盖计算核心：路线分段、观众密度、风险等级、急救点开放窗、车辆与人员资质、
// 医院接收能力与行驶时间共同参与，输出每个分段在指定时刻为何满足（或不满足）响应目标。
//
// 世界模型（world）约定：
//   travel:     [{ from, to, minutes }]              有向行驶边；封路即移除对应边
//   segments:   [{ id, node, open_window, risk_level, crowd: [{ start, end, density }] }]
//   aid_points: [{ id, node, capabilities, open_windows: [...] }]
//   vehicles:   [{ id, node, capabilities, available_windows: [...], crew: [staff_id] }]
//   staff:      [{ id, qualifications: [{ kind, expires_at }] }]
//   hospitals:  [{ id, node, capabilities, capacity_windows: [{ start, end, slots }] }]

import { containsMs, coversInstant, toMs } from "./time.js";

export const RISK_LEVELS = Object.freeze(["low", "medium", "high"]);
export const CAPABILITY_RANK = Object.freeze({ BLS: 1, ALS: 2 });

// 默认响应政策：风险等级决定目标响应分钟与所需能力，密度阶梯决定所需单元数。
export const DEFAULT_POLICY = Object.freeze({
  response_target_minutes: Object.freeze({ low: 20, medium: 10, high: 5 }),
  required_capability: Object.freeze({ low: "BLS", medium: "BLS", high: "ALS" }),
  density_unit_steps: Object.freeze([
    Object.freeze({ min_density: 2, units: 3 }),
    Object.freeze({ min_density: 1, units: 2 }),
    Object.freeze({ min_density: 0, units: 1 }),
  ]),
  hospital_target_minutes: 30,
});

export const capabilityMeets = (have, need) =>
  (CAPABILITY_RANK[have] ?? 0) >= (CAPABILITY_RANK[need] ?? 0);

// Dijkstra 最短路：返回 { minutes, path }；不可达时 minutes 为 Infinity、path 为 null。
export function route(world, from, to) {
  if (from === to) return { minutes: 0, path: [from] };
  const edges = new Map();
  for (const e of world.travel) {
    if (!edges.has(e.from)) edges.set(e.from, []);
    edges.get(e.from).push(e);
  }
  const dist = new Map([[from, 0]]);
  const prev = new Map();
  const visited = new Set();
  for (;;) {
    let node = null;
    let best = Infinity;
    for (const [n, d] of dist) {
      if (!visited.has(n) && d < best) {
        best = d;
        node = n;
      }
    }
    if (node === null) return { minutes: Infinity, path: null };
    if (node === to) {
      const path = [to];
      let cur = to;
      while (cur !== from) {
        cur = prev.get(cur);
        path.unshift(cur);
      }
      return { minutes: best, path };
    }
    visited.add(node);
    for (const e of edges.get(node) ?? []) {
      const nd = best + e.minutes;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, node);
      }
    }
  }
}

export const shortestMinutes = (world, from, to) => route(world, from, to).minutes;

// 沿给定节点序列的行驶分钟；边缺失时为 Infinity（用于人工路径与最快路径对比）。
export function pathMinutes(world, nodes) {
  let total = 0;
  for (let i = 0; i + 1 < nodes.length; i += 1) {
    const leg = (world.travel ?? []).find((e) => e.from === nodes[i] && e.to === nodes[i + 1]);
    if (!leg) return Infinity;
    total += leg.minutes;
  }
  return total;
}

const densityAt = (segment, atMs) =>
  (segment.crowd ?? []).find((bucket) => containsMs(bucket, atMs))?.density ?? 0;

function requiredUnits(policy, density) {
  const steps = [...policy.density_unit_steps].sort((a, b) => b.min_density - a.min_density);
  return (steps.find((s) => density >= s.min_density) ?? steps[steps.length - 1]).units;
}

// 车组人员资质：至少一名乘员在 at 时刻持有满足要求且未过期的资质。
function crewQualified(world, vehicle, need, at) {
  const atMs = toMs(at);
  return (vehicle.crew ?? []).some((staffId) => {
    const person = (world.staff ?? []).find((s) => s.id === staffId);
    return (person?.qualifications ?? []).some(
      (q) => capabilityMeets(q.kind, need) && toMs(q.expires_at) > atMs,
    );
  });
}

const byEtaThenId = (a, b) => a.eta_minutes - b.eta_minutes || String(a.id).localeCompare(String(b.id));

// 单个分段在 at 时刻的覆盖评估。providers/hospital 即为“为何仍满足目标”的书面依据。
export function assessSegment(world, segment, at, policy) {
  const atMs = toMs(at);
  const need = {
    units: requiredUnits(policy, densityAt(segment, atMs)),
    capability: policy.required_capability[segment.risk_level],
    target_minutes: policy.response_target_minutes[segment.risk_level],
  };

  const aidCandidates = (world.aid_points ?? [])
    .filter((p) => coversInstant(p.open_windows, at))
    .filter((p) => p.capabilities.some((c) => capabilityMeets(c, need.capability)))
    .map((p) => ({ kind: "aid_point", id: p.id, eta_minutes: shortestMinutes(world, p.node, segment.node) }));

  const vehicleCandidates = (world.vehicles ?? [])
    .filter((v) => coversInstant(v.available_windows, at))
    .filter((v) => v.capabilities.some((c) => capabilityMeets(c, need.capability)))
    .filter((v) => crewQualified(world, v, need.capability, at))
    .map((v) => ({ kind: "vehicle", id: v.id, eta_minutes: shortestMinutes(world, v.node, segment.node) }));

  const candidates = [...aidCandidates, ...vehicleCandidates];
  const providers = candidates.filter((c) => c.eta_minutes <= need.target_minutes).sort(byEtaThenId);

  const hospitals = (world.hospitals ?? [])
    .filter((h) => h.capabilities.some((c) => capabilityMeets(c, need.capability)))
    .map((h) => ({
      id: h.id,
      eta_minutes: shortestMinutes(world, segment.node, h.node),
      slots: (h.capacity_windows ?? []).find((w) => containsMs(w, atMs))?.slots ?? 0,
    }))
    .filter((h) => h.eta_minutes <= policy.hospital_target_minutes && h.slots > 0)
    .sort(byEtaThenId);

  const reasons = [];
  if (candidates.some((c) => c.eta_minutes === Infinity)) reasons.push("ROUTE_CUT");
  if (candidates.some((c) => Number.isFinite(c.eta_minutes) && c.eta_minutes > need.target_minutes)) {
    reasons.push("RESPONSE_TARGET_UNMET");
  }
  if (providers.length === 0 && reasons.length === 0) reasons.push("NO_PROVIDER_IN_TARGET");
  if (providers.length > 0 && providers.length < need.units) reasons.push("UNITS_SHORT");
  if (hospitals.length === 0) reasons.push("HOSPITAL_UNREACHABLE_OR_FULL");

  const covered = providers.length >= need.units && hospitals.length > 0;
  return {
    segment_id: segment.id,
    node: segment.node,
    risk_level: segment.risk_level,
    density: densityAt(segment, atMs),
    required: need,
    providers,
    hospital: hospitals[0] ?? null,
    covered,
    shortfall: Math.max(0, need.units - providers.length),
    reasons,
    summary: summarize(segment, need, providers, hospitals, covered, reasons),
  };
}

function summarize(segment, need, providers, hospitals, covered, reasons) {
  const who = providers.map((p) => `${p.id}(${p.eta_minutes}分钟)`).join("、") || "无";
  const hosp = hospitals[0] ? `${hospitals[0].id}(${hospitals[0].eta_minutes}分钟,余${hospitals[0].slots}床)` : "无可用接收医院";
  if (covered) {
    return `分段${segment.id}：${who}在${need.target_minutes}分钟目标内覆盖${need.units}个单元（${need.capability}）；接收医院${hosp}。`;
  }
  return `分段${segment.id}：未满足目标（${reasons.join(",")}）；可用资源${who}；接收医院${hosp}。`;
}

// 全量覆盖评估：只评估在 at 时刻处于开放窗内的分段。
export function computeCoverage(world, at, policy = DEFAULT_POLICY) {
  const atMs = toMs(at);
  const segments = (world.segments ?? [])
    .filter((s) => containsMs(s.open_window, atMs))
    .map((s) => assessSegment(world, s, at, policy));
  return { at, segments };
}

// 覆盖差异：两次评估中结论发生变化的分段 id 列表，即局部重算的影响面。
export function diffCoverage(before, after) {
  const afterById = new Map(after.segments.map((s) => [s.segment_id, s]));
  const changed = [];
  for (const b of before.segments) {
    const a = afterById.get(b.segment_id);
    if (!a) {
      changed.push(b.segment_id);
      continue;
    }
    afterById.delete(b.segment_id);
    const norm = (s) =>
      JSON.stringify({
        covered: s.covered,
        required: s.required,
        providers: s.providers,
        hospital: s.hospital,
        reasons: s.reasons,
      });
    if (norm(a) !== norm(b)) changed.push(b.segment_id);
  }
  return [...changed, ...afterById.keys()];
}
