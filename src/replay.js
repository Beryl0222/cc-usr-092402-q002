// 回放投影与发布/演练服务：
// - 组装某个方案版本在某时刻的计算视图（含当时已生效的封路/高温/设备失效）；
// - 演练只在内存里叠加假设情景，产出缺口、差异与替代建议，绝不触碰已发布方案；
// - 现场指挥重播任一版本，得到当时各段缺口、获批替代资源、实际转运偏差；
// - 外部志愿者视图按「执行所需」最小化裁剪。

import { computeCoverage, diffReports } from "./coverage.js";
import { t } from "./time_windows.js";

function payloadEvents(registry, store, atMs) {
  return (registry[store] ?? [])
    .filter((e) => t(e.occurred_at) <= atMs)
    .map((e) => e.payload);
}

// 把截至 atMs 已生效的道路封闭叠加到路网克隆上；基线路网本身不被改写。
function networkAt(registry, baseNetwork, atMs) {
  const network = baseNetwork.clone();
  for (const closure of payloadEvents(registry, "closures", atMs)) {
    network.addClosure(closure);
  }
  return network;
}

export function buildVersionView(registry, baseNetwork, planId, versionId, atMs = Date.now()) {
  const plan = registry.plans.get(planId);
  if (!plan) throw new Error(`方案不存在: ${planId}`);
  const version = plan.versions.get(versionId);
  if (!version) throw new Error(`版本不存在: ${versionId}`);

  const race = registry.races.get(plan.race_id);
  const network = networkAt(registry, baseNetwork, atMs);

  return {
    plan_id: planId,
    version_id: versionId,
    race_period: race.period,
    segments: registry.segmentsAt(plan.race_id, atMs),
    stations: registry.versionStations(version),
    roster: registry.foldRevocations(registry.versionRoster(version), atMs),
    pool: registry.foldRevocations(
      (registry.pool.get(plan.race_id) ?? []).map((e) => e.payload), atMs,
    ),
    hospitals: [...registry.hospitals.values()].flat().map((e) => e.payload),
    chosen_routes: registry.versionChosenRoutes(version),
    network,
  };
}

function scenarioOpts(registry, view, atMs, extra = {}) {
  return {
    at_ms: atMs,
    heat_alerts: [
      ...payloadEvents(registry, "alerts", atMs).map((p) => ({ window: p.window, heat_index: p.heat_index })),
      ...(extra.heat_alerts ?? []),
    ],
    failure_events: [
      ...payloadEvents(registry, "failures", atMs).map((p) => ({ window: p.window, resource_id: p.resource_id, reason: p.reason ?? "设备失效" })),
      ...(extra.failure_events ?? []),
    ],
    closure_events: extra.closure_events ?? [],
    busy: (resourceId, window) => {
      const owner = registry.ownerOf(resourceId, Math.floor((window.start + window.end) / 2));
      // 本方案自己的占用不算冲突对象。
      if (!owner || owner.plan_id === view.plan_id) return null;
      return owner;
    },
  };
}

// 计算已发布/已审批版本在某时刻的覆盖（含真实已生效情景）。
export function evaluateVersion(registry, network, planId, versionId, atMs = Date.now(), opts = {}) {
  const view = buildVersionView(registry, network, planId, versionId, atMs);
  return computeCoverage(view, { ...scenarioOpts(registry, view, atMs, opts), only: opts.only });
}

// 运行一次演练：在假设情景（临时封路/高温/设备失效）上重算，并与基线对比。
// 该函数是只读的：不改注册表、不产生占用、不覆盖任何已发布方案。
// 演练输出只能作为后续显式发起 PLAN_REVISED 的输入。
export function runDrill(registry, baseNetwork, params) {
  const { plan_id, based_on_version, scenario = {}, only = null } = params;
  const atMs = params.at_ms ?? Date.now();

  const baselineView = buildVersionView(registry, baseNetwork, plan_id, based_on_version, atMs);
  const base = computeCoverage(baselineView, { ...scenarioOpts(registry, baselineView, atMs), only });

  // 情景封路只作用在演练用的路网克隆。
  const drillNetwork = baselineView.network;
  for (const closure of scenario.closures ?? []) drillNetwork.addClosure(closure);

  const scenarioReport = computeCoverage(baselineView, {
    ...scenarioOpts(registry, baselineView, atMs, {
      heat_alerts: scenario.heat_alerts ?? [],
      failure_events: scenario.failure_events ?? [],
    }),
    closure_events: scenario.closures ?? [],
    only,
  });

  return Object.freeze({
    drill_id: params.drill_id ?? null,
    plan_id,
    based_on_version,
    base,
    scenario: scenarioReport,
    diff: diffReports(base, scenarioReport),
    // 局部重算只需重跑受影响段。
    recalculate() {
      return runDrill(registry, baseNetwork, { ...params, only: this.diff.affected_segment_ids });
    },
  });
}

// 版本相对其修订父版的获批替代资源：父版有、新版没有 = 被替换；新版新增 = 获批替补。
export function approvedAlternatives(registry, planId, versionId) {
  const plan = registry.plans.get(planId);
  const version = plan.versions.get(versionId);
  if (!version?.revises_version) return [];
  const parent = plan.versions.get(version.revises_version);
  const before = new Map(registry.versionRoster(parent).map((r) => [r.resource_id, r]));
  const after = new Map(registry.versionRoster(version).map((r) => [r.resource_id, r]));
  const changes = [];
  for (const [id, r] of after) {
    if (!before.has(id)) changes.push({ action: "ADDED", resource_id: id, type: r.type, reason: r.revision_reason ?? "局部重算获批替补" });
  }
  for (const [id, r] of before) {
    if (!after.has(id)) changes.push({ action: "REMOVED", resource_id: id, type: r.type });
  }
  // 同资源窗口/驻点调整也算获批变更。
  for (const [id, r] of after) {
    const old = before.get(id);
    if (old && JSON.stringify({ w: old.window, s: old.station_id, h: old.home_location }) !==
        JSON.stringify({ w: r.window, s: r.station_id, h: r.home_location })) {
      changes.push({ action: "REALLOCATED", resource_id: id, type: r.type });
    }
  }
  return changes;
}

// 实际转运偏差：把交接事实与版本中该段的计划转运对比。
export function transportDeviations(registry, coverage, facts, atMs = Date.now()) {
  const out = [];
  for (const incident of registry.incidents?.values() ?? []) {
    if (incident.event_at > atMs) continue;
    const fact = facts?.incidents.get(incident.incident_id);
    const segReport = coverage.segment_reports.find((s) => s.segment_id === incident.segment_id);
    const slice = segReport?.slices.find((sl) => incident.at >= sl.window.start && incident.at < sl.window.end);
    const entry = {
      incident_id: incident.incident_id,
      segment_id: incident.segment_id,
      occurred_at: new Date(incident.at).toISOString(),
      planned: slice
        ? {
            ambulance: slice.transport?.resource_id ?? null,
            hospital: slice.hospital_reservation?.hospital_id ?? null,
            response_seconds: slice.transport?.response_seconds ?? null,
            hospital_transport_seconds: slice.hospital_reservation?.transport_seconds ?? null,
          }
        : null,
      actual: null,
      deviations: [],
    };

    if (fact?.transport?.stage === "COMPLETED") {
      const handoff = registry.handoffs?.get(incident.incident_id);
      const elapsed = handoff ? Math.round((handoff.at - incident.at) / 1000) : null;
      const plannedTotal = slice && slice.transport && slice.hospital_reservation
        ? slice.transport.response_seconds + slice.hospital_reservation.transport_seconds
        : null;
      entry.actual = {
        stage: "COMPLETED",
        hospital: handoff?.hospital_id ?? fact.transport.hospital_id ?? null,
        completed_at: handoff ? new Date(handoff.at).toISOString() : null,
        elapsed_seconds: elapsed,
      };
      if (entry.planned?.hospital && entry.actual.hospital && entry.planned.hospital !== entry.actual.hospital) {
        entry.deviations.push({ kind: "HOSPITAL_CHANGED", planned: entry.planned.hospital, actual: entry.actual.hospital });
      }
      if (plannedTotal != null && elapsed != null) {
        entry.deviations.push({ kind: "ELAPSED_DELTA_SECONDS", planned_total_seconds: plannedTotal, actual_seconds: elapsed, delta: elapsed - plannedTotal });
      }
    } else if (fact) {
      entry.actual = { stage: fact.transport?.stage ?? "REPORTED" };
    }
    out.push(entry);
  }
  return out;
}

// 现场指挥重播任一方案版本：当时缺口、获批替代、实际偏差一次给出。
export function replayVersion(registry, network, planId, versionId, atMs = Date.now(), facts = null) {
  const version = registry.plans.get(planId)?.versions.get(versionId);
  const coverage = evaluateVersion(registry, network, planId, versionId, atMs);
  return {
    replayed_at: new Date(atMs).toISOString(),
    plan_id: planId,
    version: {
      version_id: versionId,
      status: version.status,
      revises_version: version.revises_version,
      approver: version.approver ?? null,
      approved_at: version.approved_at ? new Date(version.approved_at).toISOString() : null,
    },
    coverage,
    approved_alternatives: approvedAlternatives(registry, planId, versionId),
    transport_deviations: transportDeviations(registry, coverage, facts, atMs),
    // 无人负责的路线段：跨日班次缝隙、资质中途到期等导致的响应者缺口。
    unassigned_gaps: coverage.gaps.filter((g) => g.kind === "NO_QUALIFIED_RESPONDER"),
  };
}

// 外部志愿者最小视图：只保留其执行所需信息。
// 不含：其他人员名单、医院容量、内部缺口推演、资源占用方、联系方式以外的调度细节。
export function volunteerView(registry, network, planId, versionId, identity, atMs = Date.now()) {
  const coverage = evaluateVersion(registry, network, planId, versionId, atMs);
  const view = buildVersionView(registry, network, planId, versionId, atMs);

  const assignedSegments = new Set(identity.assignments?.segments ?? []);
  const ownResourceIds = new Set(identity.assignments?.resource_ids ?? []);
  const ownResources = view.roster.filter((r) => ownResourceIds.has(r.resource_id));

  const duties = [];
  for (const seg of coverage.segment_reports) {
    if (!assignedSegments.has(seg.segment_id)) continue;
    const coversHere = seg.slices.some((sl) => sl.first_response && ownResourceIds.has(sl.first_response.resource_id));
    if (!coversHere && !identity.assignments?.see_all_segments) continue;
    duties.push({
      segment_id: seg.segment_id,
      name: seg.name,
      shift_windows: ownResources.length
        ? ownResources.map((r) => ({
            resource_id: r.resource_id,
            start: new Date(t(r.window.start)).toISOString(),
            end: new Date(t(r.window.end)).toISOString(),
            station_id: r.station_id ?? null,
            report_to_node: r.station_id
              ? view.stations.find((s) => s.station_id === r.station_id)?.node
              : r.home_location,
          }))
        : [],
      // 仅告知本人是否在岗覆盖；不暴露他人安排。
      you_cover_this_segment: coversHere,
      required_qualifications: seg.required_qualifications,
    });
  }

  return {
    view_for: "VOLUNTEER",
    volunteer_id: identity.volunteer_id,
    plan_id: planId,
    version_id: versionId,
    generated_at: new Date(atMs).toISOString(),
    duties,
    // 只暴露与其值守相关的即时提醒（资质即将到期、其负责段无人接班）。
    notices: buildVolunteerNotices(registry, coverage, identity, atMs),
  };
}

function buildVolunteerNotices(registry, coverage, identity, atMs) {
  const notices = [];
  const ownResourceIds = new Set(identity.assignments?.resource_ids ?? []);
  for (const resourceId of ownResourceIds) {
    // 资质到期提醒只针对本人。
    for (const e of registry.events) {
      if (e.kind !== "RESOURCE_DECLARED" || e.payload.resource_id !== resourceId) continue;
      for (const q of e.payload.qualifications ?? []) {
        if (typeof q !== "string" && q.valid_until) {
          const until = t(q.valid_until);
          if (until > atMs && until - atMs <= 24 * 3600 * 1000) {
            notices.push({ type: "QUALIFICATION_EXPIRING", qualification: q.code, valid_until: new Date(until).toISOString() });
          }
        }
      }
    }
  }
  // 其负责段出现无人负责缺口时必须被告知（但不展示替补候选等内部推演）。
  const assigned = new Set(identity.assignments?.segments ?? []);
  for (const gap of coverage.gaps) {
    if (assigned.has(gap.segment_id) && gap.kind === "NO_QUALIFIED_RESPONDER" && gap.window.end > atMs) {
      notices.push({
        type: "SEGMENT_UNCOVERED_AHEAD",
        segment_id: gap.segment_id,
        from: new Date(gap.window.start).toISOString(),
        to: new Date(gap.window.end).toISOString(),
      });
    }
  }
  return notices;
}
