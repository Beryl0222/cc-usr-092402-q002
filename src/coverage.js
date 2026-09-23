// 覆盖计算引擎：纯函数，输入某个方案版本在某时刻的视图，输出逐段逐时段的
// 覆盖判定、缺口证据链与替代资源建议。
//
// 参与计算的要素：路线分段（边）、观众密度、风险等级、急救点开放窗、
// 车辆/人员资质（含值守中途到期）、医院接收能力、封路下的实际行驶时间，
// 以及高温/设备失效等情景叠加。

import { t, sliceBy, contains } from "./time_windows.js";
import { evaluateSegment } from "./risk.js";

const RISK_TRANSPORT_REQUIRED = Object.freeze({ low: false, medium: true, high: true });

function asWindow(w) {
  return { start: t(w.start), end: t(w.end) };
}

function qualificationCodes(resource, atMs) {
  const codes = [];
  const expired = [];
  for (const q of resource.qualifications ?? []) {
    if (typeof q === "string") {
      codes.push(q);
    } else {
      codes.push(q.code);
      if (q.valid_until && atMs >= t(q.valid_until)) expired.push(q.code);
    }
  }
  return { codes: new Set(codes), expired: new Set(expired) };
}

function activeWindows(items, atMs) {
  return items.filter((item) => {
    const w = asWindow(item.window);
    return atMs >= w.start && atMs < w.end;
  });
}

// 视图由注册表/回放组装：
// {
//   plan_id, version_id, race_period:{start,end}, segments:[...],
//   stations:[{station_id,node,window}], roster:[resource...], pool:[resource...],
//   hospitals:[{hospital_id,node,window,slots}],
//   chosen_routes:Map("resourceId|toNode" -> {edges, reason}),
// }
// opts: { at_ms, only:[segmentIds],
//         heat_alerts:[{window,heat_index}], failure_events:[{resource_id,window,reason}],
//         busy:(resourceId, window)->owner|null }
export function computeCoverage(view, opts = {}) {
  const period = asWindow(view.race_period);
  const atMs = opts.at_ms ?? period.start;
  const heatAlerts = (opts.heat_alerts ?? []).map((a) => ({ ...a, window: asWindow(a.window) }));
  const failureEvents = (opts.failure_events ?? []).map((f) => ({
    resource_id: f.resource_id, reason: f.reason ?? "设备失效", window: asWindow(f.window),
  }));
  const scenarioAt = (mid) => {
    const heat = heatAlerts.find((a) => mid >= a.window.start && mid < a.window.end) ?? null;
    const failureMap = new Map();
    for (const f of failureEvents) {
      if (mid >= f.window.start && mid < f.window.end) failureMap.set(f.resource_id, f.reason);
    }
    return { heat, failureMap };
  };

  // 时间片边界：所有窗口起止时刻都切一刀，保证片内状态恒定。
  // 各分段按自己的 period（可跨日）取交集切片。
  const cuts = new Set();
  for (const s of view.stations ?? []) {
    const w = asWindow(s.window);
    cuts.add(w.start); cuts.add(w.end);
  }
  for (const r of [...(view.roster ?? []), ...(view.pool ?? [])]) {
    const w = asWindow(r.window);
    cuts.add(w.start); cuts.add(w.end);
    // 资质在值守中途到期的时刻也必须切一刀，避免整片被错误地判定为合格。
    for (const q of r.qualifications ?? []) {
      if (typeof q !== "string" && q.valid_until) cuts.add(t(q.valid_until));
    }
  }
  for (const h of view.hospitals ?? []) {
    const w = asWindow(h.window);
    cuts.add(w.start); cuts.add(w.end);
  }
  for (const a of heatAlerts) { cuts.add(a.window.start); cuts.add(a.window.end); }
  for (const f of failureEvents) { cuts.add(f.window.start); cuts.add(f.window.end); }
  for (const c of opts.closure_events ?? []) {
    const w = asWindow(c.window);
    cuts.add(w.start); cuts.add(w.end);
  }

  const segments = (view.segments ?? []).filter(
    (s) => !opts.only || opts.only.includes(s.segment_id),
  );

  const report = {
    plan_id: view.plan_id,
    version_id: view.version_id ?? null,
    evaluated_at: new Date(atMs).toISOString(),
    scenario: {
      heat_alerts: heatAlerts.map((a) => ({ heat_index: a.heat_index, window: a.window })),
      failed_resources: [...new Set(failureEvents.map((f) => f.resource_id))],
      closure_events: opts.closure_events ?? [],
    },
    segment_reports: [],
    gaps: [],
    suggestions: [],
  };

  for (const segment of segments) {
    const segPeriod = segment.period ? asWindow(segment.period) : period;
    const required = new Set(segment.required_qualifications ?? []);
    const nodes = segmentNodes(view.network, segment);
    const segReport = {
      segment_id: segment.segment_id,
      name: segment.name ?? segment.segment_id,
      period: segPeriod,
      required_qualifications: [],
      slices: [],
    };

    const segSlices = sliceBy(segPeriod, [...cuts]);
    for (const sliceWindow of segSlices) {
      const mid = Math.floor((sliceWindow.start + sliceWindow.end) / 2);
      const { heat, failureMap } = scenarioAt(mid);
      // 需求按片内实际情景重算：高温窗内目标收紧、负荷上升。
      const demand = evaluateSegment(segment, { heat_alert: heat });
      const need = new Set([...required, ...(required.size ? [] : (demand.risk === "high" ? ["als"] : ["bls"]))]);
      const sliceEntry = analyzeSlice({
        view, segment, nodes, demand, required: need, sliceWindow, mid,
        heatAlert: heat, failureMap,
        chosenRoutes: view.chosen_routes ?? new Map(),
      });
      segReport.slices.push(sliceEntry);
      for (const q of need) if (!segReport.required_qualifications.includes(q)) segReport.required_qualifications.push(q);
      for (const gap of sliceEntry.gaps) {
        report.gaps.push({ segment_id: segment.segment_id, ...gap });
      }
    }
    report.segment_reports.push(segReport);
  }

  // 医院容量按时间片贪心预留：同一时刻高风险段优先。
  reserveHospitalCapacity(report, view);

  // 汇总缺口并生成替代资源建议。
  for (const gap of report.gaps) {
    const mid = Math.floor((gap.window.start + gap.window.end) / 2);
    const { heat, failureMap } = scenarioAt(mid);
    const suggestions = suggestAlternatives({ gap, view, opts, heat, failureMap });
    if (suggestions.length) report.suggestions.push({ gap_key: gap.key, candidates: suggestions });
  }

  report.summary = summarize(report);
  return report;
}

function segmentNodes(network, segment) {
  const ids = new Set();
  for (const edgeId of segment.edges ?? []) {
    const edge = network.edges.get(edgeId);
    if (edge) {
      ids.add(edge.from);
      ids.add(edge.to);
    }
  }
  if (segment.nodes) for (const n of segment.nodes) ids.add(n);
  return [...ids];
}

function analyzeSlice(ctx) {
  const { view, segment, nodes, demand, required, sliceWindow, mid, heatAlert, failureMap, chosenRoutes } = ctx;
  const key = `${segment.segment_id}@${sliceWindow.start}-${sliceWindow.end}`;
  const evidence = [];
  const gaps = [];

  evidence.push(...demand.reasons.map((r) => `[需求] ${r}`));

  // --- 候选响应者：只有方案明确划定负责本段的资源才算「有人负责」 ---
  // 这避免一辆恰好路过的流动救护车掩盖「该段无人负责」的事实。
  const openStations = activeWindows(view.stations ?? [], mid);
  const candidates = [];

  const responsible = (view.roster ?? []).filter((r) => (r.covers_segments ?? []).includes(segment.segment_id));
  for (const resource of responsible) {
    const w = asWindow(resource.window);
    if (!(mid >= w.start && mid < w.end)) continue;
    const station = openStations.find((s) => s.station_id === resource.station_id);
    if (resource.type === "STATION_TEAM" && !station) {
      evidence.push(`[排除] 队伍 ${resource.resource_id} 当班但急救点 ${resource.station_id} 未开放`);
      continue;
    }
    const node = resource.type === "STATION_TEAM" ? station.node : (resource.home_location ?? null);
    candidates.push(buildCandidate({ resource, node, nodes, ctx, evidence, chosenRoutes, kind: resource.type }));
  }

  const qualified = candidates.filter((c) => c.eligible);
  const bestFirstResponder = qualified
    .filter((c) => c.kind === "STATION_TEAM" || c.kind === "AMBULANCE")
    .sort((a, b) => worstTravel(a) - worstTravel(b))[0];

  const firstResponse = bestFirstResponder && worstTravel(bestFirstResponder) <= demand.target_seconds;

  if (!qualified.length) {
    // 区分「没有资质齐全的负责人」与「负责人有资质但被封路切断」。
    const onShiftResponsible = candidates.filter((c) => c.on_shift);
    const stranded = onShiftResponsible.filter(
      (c) => c.worst_travel === Infinity && !c.blockers.some((b) => !b.includes("不可达")),
    );
    if (stranded.length) {
      gaps.push({
        key, kind: "SEGMENT_DISCONNECTED", window: sliceWindow,
        message: `封路使负责本段的响应者（${stranded.map((c) => c.resource_id).join("、")}）无法到达`,
        best: { resource_id: stranded[0].resource_id }, evidence,
      });
    } else {
      gaps.push({
        key, kind: "NO_QUALIFIED_RESPONDER", window: sliceWindow,
        message: `时段内没有资质齐全（${[...required].join("、")}）且在岗负责本段的响应者`,
        evidence,
      });
    }
  } else if (!firstResponse) {
    const worst = worstTravel(bestFirstResponder);
    if (worst === Infinity) {
      gaps.push({
        key, kind: "SEGMENT_DISCONNECTED", window: sliceWindow,
        message: `封路使最近的响应者无法到达分段 ${segment.segment_id}`,
        best: { resource_id: bestFirstResponder.resource_id }, evidence,
      });
    } else {
      gaps.push({
        key, kind: "RESPONSE_TOO_SLOW", window: sliceWindow,
        message: `最快响应 ${worst}s 超过目标 ${demand.target_seconds}s`,
        best: { resource_id: bestFirstResponder.resource_id, travel_seconds: worst }, evidence,
      });
    }
  } else {
    evidence.push(`[达标] ${bestFirstResponder.resource_id} 覆盖段内最远点 ${worstTravel(bestFirstResponder)}s ≤ ${demand.target_seconds}s`);
  }

  // --- 中高风险：需要可转运救护车 + 医院接收能力 ---
  // 救护车是机动资源，可跨段调度，因此从全队（而非仅本段负责名单）评估。
  let transport = null;
  if (RISK_TRANSPORT_REQUIRED[demand.risk]) {
    const ambulances = [];
    for (const resource of view.roster ?? []) {
      if (resource.type !== "AMBULANCE") continue;
      const w = asWindow(resource.window);
      if (!(mid >= w.start && mid < w.end)) continue;
      ambulances.push(buildCandidate({
        resource, node: resource.home_location ?? null, nodes, ctx, evidence,
        chosenRoutes, kind: resource.type,
      }));
    }
    const ambulance = ambulances.filter((c) => c.eligible).sort((a, b) => worstTravel(a) - worstTravel(b))[0];
    if (!ambulance) {
      gaps.push({
        key, kind: "NO_AMBULANCE", window: sliceWindow,
        message: `风险 ${demand.risk} 段需要救护车转运，但无资质齐全且可达的救护车`, evidence,
      });
    } else {
      transport = { resource_id: ambulance.resource_id, response_seconds: worstTravel(ambulance), hospital: null };
      evidence.push(`[转运] 救护车 ${ambulance.resource_id} 到场 ${transport.response_seconds}s，评估医院接收能力`);
    }
  }

  return {
    window: sliceWindow,
    risk: demand.risk,
    target_seconds: demand.target_seconds,
    expected_per_hour: demand.expected_per_hour,
    first_response: firstResponse ? {
      resource_id: bestFirstResponder.resource_id,
      travel_seconds: worstTravel(bestFirstResponder),
      kind: bestFirstResponder.kind,
    } : null,
    transport,
    hospital_reservation: null, // 由第二阶段统一预留后回填
    evidence,
    gaps,
  };
}

function buildCandidate({ resource, node, nodes, ctx, evidence, chosenRoutes, kind }) {
  const { required, mid, sliceWindow, failureMap } = ctx;
  const { codes, expired } = qualificationCodes(resource, mid);
  const missing = [...required].filter((q) => !codes.has(q));
  const expiredHits = [...required].filter((q) => expired.has(q));
  const failed = failureMap.get(resource.resource_id);

  const travels = nodes.map((toNode) => {
    const override = chosenRoutes.get(`${resource.resource_id}|${toNode}`);
    if (override) {
      const checked = ctx.view.network.validateChosenPath(node, toNode, override.edges, mid, override.reason);
      if (!checked.ok) {
        evidence.push(`[人工路径无效] ${resource.resource_id}→${toNode}: ${checked.error}`);
        return { to: toNode, seconds: Infinity, manual: true, invalid: checked.error };
      }
      return {
        to: toNode, seconds: checked.seconds, manual: true,
        fastest_seconds: checked.fastest_seconds, reason: override.reason, edges: override.edges,
      };
    }
    const found = ctx.view.network.fastestPath(node, toNode, mid);
    return found ? { to: toNode, seconds: found.seconds, edges: found.edges } : { to: toNode, seconds: Infinity };
  });
  const worst = Math.max(...travels.map((x) => x.seconds));

  const eligibility = [];
  if (missing.length) eligibility.push(`缺少资质 ${missing.join("、")}`);
  if (expiredHits.length) eligibility.push(`资质在值守中途到期: ${expiredHits.join("、")}`);
  if (failed) eligibility.push(`设备失效: ${failed}`);
  if (worst === Infinity) eligibility.push("封路后不可达");
  if (eligibility.length) evidence.push(`[排除] ${resource.resource_id}: ${eligibility.join("；")}`);

  return {
    resource_id: resource.resource_id, kind, node,
    travels, worst_travel: worst,
    eligible: eligibility.length === 0,
    blockers: eligibility,
    on_shift: contains(asWindow(resource.window), { start: mid, end: mid + 1 }),
  };
}

function worstTravel(candidate) {
  return candidate.worst_travel;
}

// 第二阶段：为需要转运的时间片按风险顺序预留医院名额，并把结果写回 slice。
// 分段时段可能不同（跨日班次），先汇总所有实际出现的时间片，再逐片竞争名额。
function reserveHospitalCapacity(report, view) {
  const byKey = new Map();
  const sliceWindows = new Map();
  for (const seg of report.segment_reports) {
    for (const sl of seg.slices) {
      byKey.set(`${seg.segment_id}@${sl.window.start}-${sl.window.end}`, { seg, sl });
      sliceWindows.set(`${sl.window.start}-${sl.window.end}`, sl.window);
    }
  }

  for (const sliceWindow of [...sliceWindows.values()].sort((a, b) => a.start - b.start)) {
    const mid = Math.floor((sliceWindow.start + sliceWindow.end) / 2);
    const open = activeWindows(view.hospitals ?? [], mid);
    // 每个开放医院在该时间片的剩余名额。
    const remaining = new Map(open.map((h) => [h.hospital_id, h.slots]));

    const entries = [...byKey.values()]
      .filter(({ sl }) => sl.window.start === sliceWindow.start && sl.window.end === sliceWindow.end && sl.transport)
      .sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.sl.risk] - { high: 0, medium: 1, low: 2 }[b.sl.risk]));

    for (const { seg, sl } of entries) {
      const ambulance = (view.roster ?? []).find((r) => r.resource_id === sl.transport.resource_id);
      const origin = ambulance?.home_location;
      let pick = null;
      for (const hospital of open) {
        if ((remaining.get(hospital.hospital_id) ?? 0) <= 0) continue;
        const leg = origin ? view.network.fastestPath(origin, hospital.node, mid) : null;
        if (!leg) continue;
        if (!pick || leg.seconds < pick.leg.seconds) pick = { hospital, leg };
      }
      if (!pick) {
        sl.gaps.push({
          key: `${seg.segment_id}@${sliceWindow.start}-${sliceWindow.end}`,
          kind: "NO_HOSPITAL_CAPACITY", window: sliceWindow,
          message: "可达医院在该时段名额已满或全部不可达",
          evidence: [`开放医院: ${open.map((h) => `${h.hospital_id}=剩余${remaining.get(h.hospital_id)}`).join("；") || "无"}`],
        });
        report.gaps.push({
          segment_id: seg.segment_id,
          key: `${seg.segment_id}@${sliceWindow.start}-${sliceWindow.end}`,
          kind: "NO_HOSPITAL_CAPACITY", window: sliceWindow,
          message: "可达医院在该时段名额已满或全部不可达",
        });
      } else {
        remaining.set(pick.hospital.hospital_id, remaining.get(pick.hospital.hospital_id) - 1);
        sl.hospital_reservation = {
          hospital_id: pick.hospital.hospital_id,
          transport_seconds: pick.leg.seconds,
          slots_left_after: remaining.get(pick.hospital.hospital_id),
        };
      }
    }
  }
}

// 替代资源建议：扫描全部可用资源（含其他方案正在占用的），标注占用方。
function suggestAlternatives({ gap, view, opts, heat, failureMap }) {
  const mid = Math.floor((gap.window.start + gap.window.end) / 2);
  const segment = view.segments.find((s) => s.segment_id === gap.segment_id);
  const nodes = segmentNodes(view.network, segment);
  const demand = evaluateSegment(segment, { heat_alert: heat ?? null });
  const required = new Set(segment.required_qualifications ?? (demand.risk === "high" ? ["als"] : ["bls"]));

  const pool = new Map();
  for (const r of [...(view.pool ?? []), ...(view.roster ?? [])]) {
    if (!pool.has(r.resource_id)) pool.set(r.resource_id, r);
  }
  const out = [];
  for (const resource of pool.values()) {
    const w = asWindow(resource.window);
    if (!(mid >= w.start && mid < w.end)) continue;
    const { codes, expired } = qualificationCodes(resource, mid);
    if ([...required].some((q) => !codes.has(q))) continue;
    if ([...required].some((q) => expired.has(q))) continue;
    if (failureMap.has(resource.resource_id)) continue;
    const node = resource.type === "STATION_TEAM"
      ? (view.stations ?? []).find((s) => s.station_id === resource.station_id && mid >= t(s.window.start) && mid < t(s.window.end))?.node
      : resource.home_location;
    if (!node) continue;
    const seconds = Math.max(...nodes.map((n) => view.network.fastestPath(node, n, mid)?.seconds ?? Infinity));
    if (seconds === Infinity) continue;

    const owner = opts.busy ? opts.busy(resource.resource_id, gap.window) : null;
    out.push({
      resource_id: resource.resource_id,
      type: resource.type,
      worst_travel_seconds: seconds,
      meets_target: seconds <= demand.target_seconds,
      status: owner ? { available: false, occupied_by: owner } : { available: true },
    });
  }
  return out.sort((a, b) => b.status.available - a.status.available || a.worst_travel_seconds - b.worst_travel_seconds);
}

function summarize(report) {
  const byKind = {};
  for (const gap of report.gaps) byKind[gap.kind] = (byKind[gap.kind] ?? 0) + 1;
  const gapSeconds = report.gaps.reduce((sum, g) => sum + (g.window.end - g.window.start), 0);
  return {
    gap_count: report.gaps.length,
    gap_seconds: gapSeconds,
    by_kind: byKind,
    meets: report.gaps.length === 0,
  };
}

// 把基线报告与情景报告对比，得出局部重算的影响范围。
// 两份报告的切片边界可能不同（情景新增了封路/高温边界），因此按时间点采样比较，
// 而不是比较缺口键或切片下标。
export function diffReports(base, scenario) {
  const changedSegments = new Set();
  const newGaps = [];
  const resolvedGaps = [];

  const baseBySeg = new Map(base.segment_reports.map((s) => [s.segment_id, s]));
  const scenBySeg = new Map(scenario.segment_reports.map((s) => [s.segment_id, s]));

  const samplePoints = new Set();
  for (const rep of [base, scenario]) {
    for (const seg of rep.segment_reports) {
      for (const sl of seg.slices) {
        samplePoints.add(Math.floor((sl.window.start + sl.window.end) / 2));
      }
    }
  }

  const sliceAt = (seg, at) =>
    seg?.slices.find((sl) => at >= sl.window.start && at < sl.window.end) ?? null;
  const gapsAt = (report, segmentId, at) =>
    report.gaps.filter((g) => g.segment_id === segmentId && at >= g.window.start && at < g.window.end);

  for (const segmentId of new Set([...baseBySeg.keys(), ...scenBySeg.keys()])) {
    const aSeg = baseBySeg.get(segmentId);
    const bSeg = scenBySeg.get(segmentId);
    for (const at of [...samplePoints].sort((a, b) => a - b)) {
      const a = sliceAt(aSeg, at);
      const b = sliceAt(bSeg, at);
      if (!a || !b) continue;
      const aGaps = gapsAt(base, segmentId, at).map((g) => g.kind).sort();
      const bGaps = gapsAt(scenario, segmentId, at).map((g) => g.kind).sort();
      if (JSON.stringify(aGaps) !== JSON.stringify(bGaps) ||
          a.risk !== b.risk ||
          a.target_seconds !== b.target_seconds ||
          JSON.stringify(a.first_response) !== JSON.stringify(b.first_response) ||
          JSON.stringify(a.transport) !== JSON.stringify(b.transport) ||
          JSON.stringify(a.hospital_reservation) !== JSON.stringify(b.hospital_reservation)) {
        changedSegments.add(segmentId);
      }
    }
  }

  // 新增/消除的缺口：按（段、类型、时间重叠）归并，避免切片重划导致的伪差异。
  const gapKey = (g) => `${g.segment_id}|${g.kind}`;
  for (const g of scenario.gaps) {
    const hit = base.gaps.find((b) => gapKey(b) === gapKey(g) &&
      b.window.start < g.window.end && g.window.start < b.window.end);
    if (!hit) newGaps.push(g);
  }
  for (const g of base.gaps) {
    const hit = scenario.gaps.find((b) => gapKey(b) === gapKey(g) &&
      b.window.start < g.window.end && g.window.start < b.window.end);
    if (!hit) resolvedGaps.push(g);
  }

  return {
    affected_segment_ids: [...changedSegments],
    new_gaps: newGaps,
    resolved_gaps: resolvedGaps,
    base_meets: base.summary.meets,
    scenario_meets: scenario.summary.meets,
  };
}
