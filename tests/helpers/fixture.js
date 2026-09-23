// 虚构赛事夹具：2026 环城夜跑（跨午夜），路网、分段、急救点、车辆、医院均为虚构。
import { RoadNetwork } from "../../src/network.js";
import { PlanRegistry } from "../../src/registry.js";

export const RACE = {
  race_id: "R-2026-NIGHT",
  // 跨午夜：2026-09-26 22:00 +08:00 ~ 2026-09-27 02:00
  start: "2026-09-26T22:00:00+08:00",
  end: "2026-09-27T02:00:00+08:00",
};

let counter = 0;
export function ev(kind, occurredAt, payload, subjectId = "R-2026-NIGHT") {
  counter += 1;
  return {
    event_id: `evt-${String(counter).padStart(4, "0")}`,
    kind,
    occurred_at: occurredAt,
    subject_id: subjectId,
    payload,
  };
}

export function resetEventIds() {
  counter = 0;
}

// 双向道路（救护车可双向通行）。
function road(net, id, a, b, seconds) {
  net.addEdge(id, a, b, seconds);
  net.addEdge(`${id}_r`, b, a, seconds);
}

export function buildNetwork() {
  const net = new RoadNetwork();
  // 赛道主线 n0 -> n5
  road(net, "e01", "n0", "n1", 60);
  road(net, "e12", "n1", "n2", 60);
  road(net, "e23", "n2", "n3", 90);
  road(net, "e34", "n3", "n4", 90);
  road(net, "e45", "n4", "n5", 120);
  // 急救点驻点
  road(net, "es1", "s1", "n1", 60);
  road(net, "es2a", "s2", "n3", 60);
  road(net, "es2b", "s2", "n4", 150);
  // 救护车停车场
  road(net, "ed1a", "d1", "n0", 90);
  road(net, "ed1b", "d1", "n1", 100);
  road(net, "ed1c", "d1", "n3", 300);
  road(net, "ed1d", "d1", "n4", 400);
  road(net, "ed2a", "d2", "n3", 90);
  road(net, "ed2b", "d2", "n4", 90);
  road(net, "ed2c", "d2", "n5", 150);
  // 医院通道
  road(net, "eh1a", "d1", "h1", 300);
  road(net, "eh1b", "d2", "h1", 420);
  road(net, "eh2a", "d1", "h2", 480);
  road(net, "eh2b", "d2", "h2", 120);
  return net;
}

export const SEGMENTS = [
  {
    segment_id: "seg-A",
    name: "起点广场段",
    edges: ["e01", "e01_r", "e12", "e12_r"],
    density_per_km: 2400, // 超过 2000，medium -> high
    risk: "medium",
    period: { start: RACE.start, end: RACE.end },
  },
  {
    segment_id: "seg-B",
    name: "江滨中段",
    edges: ["e23", "e23_r", "e34", "e34_r"],
    density_per_km: 800,
    risk: "medium",
    required_qualifications: ["als"],
    period: { start: RACE.start, end: RACE.end },
  },
  {
    segment_id: "seg-C",
    name: "终点前直道",
    edges: ["e45", "e45_r"],
    density_per_km: 400,
    risk: "low",
    period: { start: RACE.start, end: RACE.end },
  },
];

export const T = {
  planDraft: "2026-09-20T09:00:00+08:00",
  filed: "2026-09-20T09:10:00+08:00",
  drilled: "2026-09-20T15:00:00+08:00",
  v1Approved: "2026-09-21T10:00:00+08:00",
  v1Published: "2026-09-21T11:00:00+08:00",
  betaApproved: "2026-09-22T09:00:00+08:00",
  betaPublished: "2026-09-22T09:30:00+08:00",
  revised: "2026-09-22T14:00:00+08:00",
  v2Approved: "2026-09-22T16:00:00+08:00",
  v2Published: "2026-09-22T17:00:00+08:00",
  closureFiled: "2026-09-26T22:40:00+08:00",
};

export function fileRaceBasics(reg) {
  reg.append(ev("EVENT_RISK_FILED", T.planDraft, { race_id: RACE.race_id, segments: SEGMENTS }));
  reg.append(ev("HOSPITAL_CAPACITY_FILED", T.filed, {
    hospital_id: "H1", node: "h1",
    window: { start: "2026-09-26T21:00:00+08:00", end: "2026-09-27T03:00:00+08:00" },
    slots: 1,
  }));
  reg.append(ev("HOSPITAL_CAPACITY_FILED", T.filed, {
    hospital_id: "H2", node: "h2",
    window: { start: "2026-09-26T21:00:00+08:00", end: "2026-09-27T03:00:00+08:00" },
    slots: 1,
  }));
  // 共享资源池：替补救护车 A2（全晚可用，实际占用以各方案发布为准）。
  reg.append(ev("RESOURCE_DECLARED", T.filed, {
    resource_id: "A2", race_id: RACE.race_id, type: "AMBULANCE",
    vehicle_kind: "ambulance", home_location: "d2",
    qualifications: ["bls", "als"],
    window: { start: "2026-09-26T20:00:00+08:00", end: "2026-09-27T03:00:00+08:00" },
  }));
}

// 方案 alpha v1：T1 驻 S1、T3 驻 S2（als 证书 00:15 到期）、救护车 A1。
export function publishAlphaV1(reg) {
  reg.append(ev("PLAN_DRAFTED", T.planDraft, { plan_id: "plan-alpha", race_id: RACE.race_id }));
  reg.append(ev("AID_STATION_OPENING_SET", T.filed, {
    plan_id: "plan-alpha", station_id: "S1", node: "s1",
    window: { start: RACE.start, end: RACE.end },
  }));
  reg.append(ev("AID_STATION_OPENING_SET", T.filed, {
    plan_id: "plan-alpha", station_id: "S2", node: "s2",
    window: { start: RACE.start, end: RACE.end },
  }));
  reg.append(ev("RESOURCE_DECLARED", T.filed, {
    plan_id: "plan-alpha", resource_id: "T1", type: "STATION_TEAM", station_id: "S1",
    qualifications: ["bls", "als"], covers_segments: ["seg-A"],
    window: { start: RACE.start, end: RACE.end },
  }));
  reg.append(ev("RESOURCE_DECLARED", T.filed, {
    plan_id: "plan-alpha", resource_id: "T3", type: "STATION_TEAM", station_id: "S2",
    // als 证书在值守中途（跨日 00:15）到期，bls 仍有效。
    qualifications: ["bls", { code: "als", valid_until: "2026-09-27T00:15:00+08:00" }],
    covers_segments: ["seg-B"],
    window: { start: RACE.start, end: RACE.end },
  }));
  reg.append(ev("RESOURCE_DECLARED", T.filed, {
    plan_id: "plan-alpha", resource_id: "T5", type: "STATION_TEAM", station_id: "S2",
    qualifications: ["bls"], covers_segments: ["seg-C"],
    window: { start: RACE.start, end: RACE.end },
  }));
  reg.append(ev("RESOURCE_DECLARED", T.filed, {
    plan_id: "plan-alpha", resource_id: "A1", type: "AMBULANCE",
    vehicle_kind: "ambulance", home_location: "d1", qualifications: ["bls", "als"],
    window: { start: "2026-09-26T21:30:00+08:00", end: "2026-09-27T02:30:00+08:00" },
  }));
  reg.append(ev("PLAN_DRILL_RUN", T.drilled, {
    plan_id: "plan-alpha", drill_id: "drill-baseline", based_on_version: "plan-alpha-v1",
  }));
  reg.append(ev("PLAN_APPROVED", T.v1Approved, {
    plan_id: "plan-alpha", version_id: "plan-alpha-v1", approver: "总监-李岑",
    // 赛前已知：T3 的 als 证书 00:15 到期，在 T3N 接班方案（v2）生效前存在缺口，
    // 由总监逐条签署书面豁免并限期 v2 补上，避免审批时被闸门静默放行。
    gap_waivers: [{
      match: { segment_id: "seg-B", kind: "NO_QUALIFIED_RESPONDER" },
      reason: "T3 换证排期在 09-27 00:15，已安排 T3N 于同刻接班（见 v2），过渡期接受",
      accepted_by: "总监-李岑",
    }],
  }));
  reg.append(ev("PLAN_PUBLISHED", T.v1Published, {
    plan_id: "plan-alpha", version_id: "plan-alpha-v1", effective_at: RACE.start,
  }));
}

// 方案 beta：其他赛事分区在 00:30-01:30 占用共享替补车 A2。
export function publishBeta(reg) {
  const w = { start: "2026-09-27T00:30:00+08:00", end: "2026-09-27T01:30:00+08:00" };
  reg.append(ev("PLAN_DRAFTED", "2026-09-22T08:00:00+08:00", {
    plan_id: "plan-beta", race_id: RACE.race_id, coverage_scope: [], // 只借调 A2，不承担路线覆盖
  }));
  reg.append(ev("RESOURCE_DECLARED", "2026-09-22T08:10:00+08:00", {
    plan_id: "plan-beta", resource_id: "A2", type: "AMBULANCE", home_location: "d2",
    qualifications: ["bls", "als"], window: w,
  }));
  reg.append(ev("PLAN_APPROVED", T.betaApproved, {
    plan_id: "plan-beta", version_id: "plan-beta-v1", approver: "总监-李岑",
  }));
  reg.append(ev("PLAN_PUBLISHED", T.betaPublished, {
    plan_id: "plan-beta", version_id: "plan-beta-v1",
    effective_at: w.start,
  }));
  return w;
}

// 方案 alpha v2：局部重算——为封路窗加 A2（22:30-00:30），为 T3 证书到期加 T3N。
// slowRoute: "none" | "justified" | "unjustified"
export function publishAlphaV2(reg, { slowRoute = "justified" } = {}) {
  reg.append(ev("PLAN_REVISED", T.revised, {
    plan_id: "plan-alpha", version_id: "plan-alpha-v2", revises_version: "plan-alpha-v1",
  }));
  reg.append(ev("RESOURCE_DECLARED", "2026-09-22T14:10:00+08:00", {
    plan_id: "plan-alpha", resource_id: "A2", type: "AMBULANCE", home_location: "d2",
    qualifications: ["bls", "als"], revision_reason: "封路情景演练：替补车覆盖 n2 绕行",
    window: { start: "2026-09-26T22:30:00+08:00", end: "2026-09-27T00:30:00+08:00" },
  }));
  reg.append(ev("RESOURCE_DECLARED", "2026-09-22T14:20:00+08:00", {
    plan_id: "plan-alpha", resource_id: "T3N", type: "STATION_TEAM", station_id: "S2",
    qualifications: ["bls", "als"], covers_segments: ["seg-B"],
    revision_reason: "T3 的 als 证书 00:15 到期，跨日接班",
    window: { start: "2026-09-27T00:15:00+08:00", end: RACE.end },
  }));
  if (slowRoute !== "none") {
    const payload = {
      plan_id: "plan-alpha", resource_id: "A2", to_node: "n5", purpose: "PATROL_C_DETOUR",
      // 人为指定绕行：d2-n3-n4-n5 = 300s，比最快 d2-n5 = 150s 慢 150s。
      path: ["ed2a", "e34", "e45"],
    };
    if (slowRoute === "justified") {
      payload.reason = "n5 侧辅路夜间施工，指挥要求绕行至 n4 接应担架组";
    }
    reg.append(ev("ROUTE_CHOSEN", "2026-09-22T14:30:00+08:00", payload));
  }
  reg.append(ev("PLAN_APPROVED", T.v2Approved, {
    plan_id: "plan-alpha", version_id: "plan-alpha-v2", approver: "总监-李岑",
  }));
  reg.append(ev("PLAN_PUBLISHED", T.v2Published, {
    plan_id: "plan-alpha", version_id: "plan-alpha-v2",
    effective_at: "2026-09-26T22:30:00+08:00",
  }));
}

export function buildWorld() {
  resetEventIds();
  const network = buildNetwork();
  const registry = new PlanRegistry({ network });
  fileRaceBasics(registry);
  return { network, registry };
}
