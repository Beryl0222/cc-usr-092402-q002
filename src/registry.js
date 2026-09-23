// 事件溯源注册表：追加事件、冻结版本、审批发布、资源占用账本。
//
// 关键规则：
// - 草稿与演练不产生任何资源占用；只有 PLAN_PUBLISHED 才占用。
// - 同一 version_id 重复发布是幂等的，不会把资源占用两次。
// - 同一资源在重叠时段只能被一个方案占用：跨 plan 冲突会拒绝发布并给出双方。
// - 新版本局部重算并发布后，在生效时刻取代同方案祖版；历史占用不被改写。

import { validateEvent, VersionGraph } from "./events.js";
import { t } from "./time_windows.js";
import { computeCoverage } from "./coverage.js";

export class RegistrationError extends Error {}

export class PlanRegistry {
  // 传入路网后，ROUTE_CHOSEN 在入库时即校验：较慢路径必须携带理由。
  constructor({ network } = {}) {
    this.network = network ?? null;
    this.events = [];
    this._byId = new Map();
    this.versions = new VersionGraph();

    this.races = new Map(); // race_id -> { period(全包络), revisions:[{at, segments, period}] }
    this.plans = new Map(); // plan_id -> { race_id, content:[], versions:Map, draft:{} }
    this.pool = new Map(); // race_id -> [resource 声明事件]（无 plan_id 的共享资源）
    this.hospitals = new Map();
    this.closures = []; // 已生效的道路封闭（演练中的假设封闭不入库）
    this.alerts = []; // 已生效天气警报
    this.failures = []; // 已上报设备失效
    this.revocations = []; // 值守中途资质吊销/中止
    this.claims = []; // { resource_id, start, end, plan_id, version_id }
    this._seq = 0;
  }

  // --- 载入与追加 -----------------------------------------------------------

  load(events) {
    const sorted = [...events].sort((a, b) => t(a.occurred_at) - t(b.occurred_at));
    for (const event of sorted) this.append(event);
    return this;
  }

  append(record) {
    const problems = validateEvent(record);
    if (problems.length) throw new RegistrationError(`事件 ${record.event_id ?? "?"} 字段不合法: ${problems.join(", ")}`);
    if (this._byId.has(record.event_id)) {
      // 同一事件重放必须静默幂等，不能产生第二次副作用。
      return this._byId.get(record.event_id);
    }
    const event = { ...record, seq: ++this._seq };
    const handler = this[`_on_${record.kind}`];
    if (handler) handler.call(this, event);
    this.events.push(event);
    this._byId.set(event.event_id, event);
    return event;
  }

  // --- 基础资料 -------------------------------------------------------------

  _on_EVENT_RISK_FILED(e) {
    const p = e.payload;
    const at = t(e.occurred_at);
    const start = Math.min(...p.segments.map((s) => t(s.period.start)));
    const end = Math.max(...p.segments.map((s) => t(s.period.end)));
    const revision = { at, segments: p.segments, period: { start, end } };
    let race = this.races.get(p.race_id);
    if (!race) {
      race = { race_id: p.race_id, revisions: [], period: { start, end } };
      this.races.set(p.race_id, race);
    }
    race.revisions.push(revision);
    race.revisions.sort((a, b) => a.at - b.at);
    // 全包络时间范围（最早分段开始 ~ 最晚分段结束，覆盖跨日）。
    race.period = {
      start: Math.min(race.period.start, start),
      end: Math.max(race.period.end, end),
    };
  }

  // atMs 时刻生效的路线分段（路线临时调整后取最近一次建档）。
  segmentsAt(raceId, atMs) {
    const race = this.races.get(raceId);
    if (!race) throw new RegistrationError(`赛事不存在: ${raceId}`);
    let chosen = race.revisions[0];
    for (const rev of race.revisions) if (rev.at <= atMs) chosen = rev;
    return chosen.segments;
  }

  _on_RESOURCE_DECLARED(e) {
    const p = e.payload;
    if (!p.plan_id) {
      if (!this.pool.has(p.race_id)) this.pool.set(p.race_id, []);
      this.pool.get(p.race_id).push(e);
      return;
    }
    const plan = this._plan(p.plan_id);
    if (!plan) throw new RegistrationError(`方案不存在: ${p.plan_id}`);
    this._addPlanContent(plan, e);
  }

  _on_HOSPITAL_CAPACITY_FILED(e) {
    if (!this.hospitals.has(e.payload.hospital_id)) this.hospitals.set(e.payload.hospital_id, []);
    this.hospitals.get(e.payload.hospital_id).push(e);
  }

  _on_ROUTE_CLOSURE_FILED(e) {
    this.closures.push(e);
  }

  _on_WEATHER_ALERT_FILED(e) {
    this.alerts.push(e);
  }

  _on_EQUIPMENT_FAILURE_FILED(e) {
    this.failures.push(e);
  }

  _on_QUALIFICATION_REVOKED(e) {
    this.revocations.push(e);
  }

  _on_INCIDENT_ESCALATED(e) {
    this.incidents ??= new Map();
    const p = e.payload;
    this.incidents.set(p.incident_id, {
      incident_id: p.incident_id,
      segment_id: p.segment_id,
      at: t(p.at),
      event_at: t(e.occurred_at),
    });
  }

  _on_HANDOFF_COMPLETED(e) {
    this.handoffs ??= new Map();
    const p = e.payload;
    this.handoffs.set(p.incident_id, {
      incident_id: p.incident_id,
      hospital_id: p.hospital_id,
      at: t(p.at),
      event_at: t(e.occurred_at),
    });
  }

  // 现场消息只入档，事实合并由 FieldMessageLog / IncidentFacts 负责。
  _on_FIELD_MESSAGE_RECEIVED(e) {
    this.fieldMessages ??= [];
    this.fieldMessages.push(e);
  }

  // --- 方案生命周期 ---------------------------------------------------------

  _plan(planId) {
    return this.plans.get(planId);
  }

  _on_PLAN_DRAFTED(e) {
    const p = e.payload;
    if (this.plans.has(p.plan_id)) throw new RegistrationError(`方案已存在: ${p.plan_id}`);
    if (!this.races.has(p.race_id)) throw new RegistrationError(`赛事不存在: ${p.race_id}`);
    this.plans.set(p.plan_id, {
      plan_id: p.plan_id,
      race_id: p.race_id,
      // 承担路线覆盖义务的分段；空数组表示该方案只借调资源、不负责任何路线段。
      coverage_scope: Array.isArray(p.coverage_scope) ? p.coverage_scope : "ALL",
      content_events: [],
      versions: new Map(), // version_id -> version state
      open_version: null, // 审批通过前正在编辑的版本号
      head_version: null, // 最新已发布版本
    });
  }

  _on_PLAN_REVISED(e) {
    const plan = this._plan(e.payload.plan_id);
    if (!plan) throw new RegistrationError(`方案不存在: ${e.payload.plan_id}`);
    const base = plan.versions.get(e.payload.revises_version);
    if (!base || !base.published_at) {
      throw new RegistrationError("只能针对已发布版本做局部重算");
    }
    if (plan.open_version) throw new RegistrationError(`已有未完成审批的修订版本: ${plan.open_version}`);
    if (plan.head_version !== e.payload.revises_version) {
      throw new RegistrationError("局部重算必须基于当前最新发布版本，避免分叉占用");
    }
    plan.open_version = e.payload.version_id;
    plan.versions.set(e.payload.version_id, {
      version_id: e.payload.version_id,
      revises_version: e.payload.revises_version,
      status: "revising",
      created_at: t(e.occurred_at),
      content_events: [...base.content_events], // 未受影响段的既有安排原样继承
    });
  }

  // 方案内容事件（资源、急救点、人工路径）：修订期间新增的编辑归入在编修订版本。
  _addPlanContent(plan, e) {
    plan.content_events.push(e);
    if (plan.open_version) {
      const open = plan.versions.get(plan.open_version);
      open.content_events.push(e);
    }
  }

  _locateResourceNode(plan, resourceId, atMs) {
    const declared = [...plan.content_events]
      .filter((ev) => ev.kind === "RESOURCE_DECLARED" && ev.payload.resource_id === resourceId)
      .at(-1)?.payload;
    const pooled = (this.pool.get(plan.race_id) ?? [])
      .filter((ev) => ev.payload.resource_id === resourceId).at(-1)?.payload;
    const resource = declared ?? pooled;
    if (!resource) throw new RegistrationError(`人工路径引用了未声明的资源: ${resourceId}`);
    if (resource.type === "AMBULANCE") return resource.home_location;
    if (resource.type === "STATION_TEAM") {
      const station = plan.content_events
        .filter((ev) => ev.kind === "AID_STATION_OPENING_SET" && ev.payload.station_id === resource.station_id)
        .at(-1)?.payload;
      if (!station) throw new RegistrationError(`队伍 ${resourceId} 的急救点 ${resource.station_id} 未设置开放窗`);
      return station.node;
    }
    return resource.home_location ?? null;
  }

  _on_AID_STATION_OPENING_SET(e) {
    const plan = this._plan(e.payload.plan_id);
    if (!plan) throw new RegistrationError(`方案不存在: ${e.payload.plan_id}`);
    this._addPlanContent(plan, e);
  }

  _on_ROUTE_CHOSEN(e) {
    const plan = this._plan(e.payload.plan_id);
    if (!plan) throw new RegistrationError(`方案不存在: ${e.payload.plan_id}`);
    if (this.network) {
      const p = e.payload;
      const fromNode = p.from_node ?? this._locateResourceNode(plan, p.resource_id, t(e.occurred_at));
      const checked = this.network.validateChosenPath(fromNode, p.to_node, p.path, t(e.occurred_at), p.reason);
      if (!checked.ok) throw new RegistrationError(`人工路径无效: ${checked.error}`);
      e.payload = { ...p, from_node: fromNode, _validated: { seconds: checked.seconds, detour_seconds: checked.detour_seconds } };
    }
    this._addPlanContent(plan, e);
  }

  // 方案内的资源声明同样进入 content_events（见 _on_RESOURCE_DECLARED）。

  _on_PLAN_DRILL_RUN(e) {
    // 演练只留痕，绝不写方案内容、不产生占用。
    const plan = this._plan(e.payload.plan_id);
    if (!plan) throw new RegistrationError(`方案不存在: ${e.payload.plan_id}`);
    plan.drills ??= [];
    plan.drills.push(e);
  }

  _on_PLAN_APPROVED(e) {
    const p = e.payload;
    const plan = this._plan(p.plan_id);
    if (!plan) throw new RegistrationError(`方案不存在: ${p.plan_id}`);

    let version = plan.open_version ? plan.versions.get(plan.open_version) : null;
    let versionId = plan.open_version;
    if (!version) {
      // 草稿首次审批：version_id 即首次版本。
      versionId = p.version_id;
      version = {
        version_id: versionId,
        revises_version: null,
        content_events: [],
      };
      plan.versions.set(versionId, version);
    }
    if (version.version_id !== p.version_id) {
      throw new RegistrationError(`审批版本号与在编修订不一致: ${version.version_id} != ${p.version_id}`);
    }
    if (version.status === "approved" || version.status === "published") {
      throw new RegistrationError(`版本 ${versionId} 已审批，不可重复冻结`);
    }

    // 冻结快照：取审批时刻之前该方案的全部内容事件（含修订继承的基线内容）。
    const cutoff = t(e.occurred_at);
    const inherited = new Map(version.content_events.map((ev) => [ev.event_id, ev]));
    for (const ev of plan.content_events) {
      if (t(ev.occurred_at) <= cutoff) inherited.set(ev.event_id, ev);
    }
    version.content_events = [...inherited.values()].sort((a, b) => a.seq - b.seq);

    // 审批硬闸门：冻结前重算整段赛期覆盖。任何缺口都必须逐条签署书面豁免，
    // 否则该版本不予冻结——从流程上保证「不留下无人负责的路线段」。
    const gate = this._approvalGate(plan, version, cutoff);
    const waivers = p.gap_waivers ?? [];
    for (const w of waivers) {
      if (typeof w.reason !== "string" || w.reason.trim().length < 4 || !w.accepted_by) {
        throw new RegistrationError("缺口豁免必须包含 reason 与 accepted_by，责任到人");
      }
    }
    const matchedBy = new Map(); // waiver 索引 -> 命中的缺口数
    const unmatched = [];
    for (const gap of gate.report.gaps) {
      const hit = waivers
        .map((w, i) => ({ w, i }))
        .filter(({ w }) => w.gap_key === gap.key ||
          (w.match?.segment_id === gap.segment_id && w.match?.kind === gap.kind));
      if (!hit.length) {
        unmatched.push({ gap_key: gap.key, segment_id: gap.segment_id, kind: gap.kind, message: gap.message });
      } else {
        for (const { i } of hit) matchedBy.set(i, (matchedBy.get(i) ?? 0) + 1);
      }
    }
    // 「逐条签署」：一个豁免不得同时覆盖多个缺口（多片缺口必须逐片列 gap_key）。
    const broad = [...matchedBy.entries()].filter(([, n]) => n > 1).map(([i]) => waivers[i]);
    if (broad.length) {
      const err = new RegistrationError("一份豁免只能对应一个缺口，多时段缺口请逐条列出 gap_key");
      err.broad_waivers = broad;
      throw err;
    }
    if (unmatched.length) {
      const err = new RegistrationError("方案存在未签署豁免的覆盖缺口，审批被拒绝");
      err.unwaived_gaps = unmatched;
      throw err;
    }
    version.approval_report = {
      evaluated_at: cutoff,
      gap_count: gate.report.gaps.length,
      waivers: waivers.map((w) => ({ ...w })),
      summary: gate.report.summary,
    };

    version.status = "approved";
    version.approver = p.approver;
    version.approved_at = cutoff;
    plan.open_version = null;
    this.versions.register(versionId, p.plan_id, version.revises_version);
  }

  // 组装截至 atMs 的视图并做全赛期覆盖核验（审批时使用）。
  _approvalGate(plan, version, atMs) {
    const race = this.races.get(plan.race_id);
    const network = this.network ? this.network.clone() : null;
    if (network) {
      for (const e of this.closures ?? []) {
        if (t(e.occurred_at) <= atMs) network.addClosure(e.payload);
      }
    }
    const view = {
      plan_id: plan.plan_id,
      version_id: version.version_id,
      race_period: race.period,
      segments: this.segmentsAt(plan.race_id, atMs),
      stations: this.versionStations(version),
      roster: this.foldRevocations(this.versionRoster(version), atMs),
      pool: (this.pool.get(plan.race_id) ?? [])
        .filter((e) => t(e.occurred_at) <= atMs).map((e) => e.payload),
      hospitals: [...this.hospitals.values()].flat()
        .filter((e) => t(e.occurred_at) <= atMs).map((e) => e.payload),
      chosen_routes: this.versionChosenRoutes(version),
      network,
    };
    const opts = {
      at_ms: atMs,
      only: Array.isArray(plan.coverage_scope) ? plan.coverage_scope : undefined,
      heat_alerts: (this.alerts ?? []).filter((e) => t(e.occurred_at) <= atMs)
        .map((e) => ({ window: e.payload.window, heat_index: e.payload.heat_index })),
      failure_events: (this.failures ?? []).filter((e) => t(e.occurred_at) <= atMs)
        .map((e) => ({ resource_id: e.payload.resource_id, window: e.payload.window, reason: e.payload.reason ?? "设备失效" })),
    };
    if (Array.isArray(plan.coverage_scope) && plan.coverage_scope.length === 0) {
      // 只借调资源、不承担路线覆盖义务的方案：审批闸门无缺口可言。
      return { view, report: { gaps: [], summary: { gap_count: 0, meets: true } } };
    }
    return { view, report: computeCoverage(view, opts) };
  }

  // 把截至 atMs 的资质吊销折叠为「该资质在生效时刻到期」，供覆盖计算使用。
  foldRevocations(roster, atMs) {
    const revokedByResource = new Map();
    for (const e of this.revocations ?? []) {
      if (t(e.occurred_at) > atMs) continue;
      const p = e.payload;
      if (!revokedByResource.has(p.resource_id)) revokedByResource.set(p.resource_id, new Map());
      revokedByResource.get(p.resource_id).set(p.code, t(p.effective_at));
    }
    if (!revokedByResource.size) return roster;
    return roster.map((r) => {
      const revs = revokedByResource.get(r.resource_id);
      if (!revs) return r;
      return {
        ...r,
        qualifications: (r.qualifications ?? []).map((q) => {
          const code = typeof q === "string" ? q : q.code;
          if (!revs.has(code)) return q;
          const revokedAt = revs.get(code);
          const declaredUntil = typeof q === "string" ? null : (q.valid_until ? t(q.valid_until) : null);
          const until = declaredUntil == null ? revokedAt : Math.min(revokedAt, declaredUntil);
          return {
            code,
            valid_until: new Date(until).toISOString(),
            revoked: revokedAt <= declaredUntil || declaredUntil == null,
          };
        }),
      };
    });
  }

  _on_PLAN_PUBLISHED(e) {
    const p = e.payload;
    const plan = this._plan(p.plan_id);
    const version = plan?.versions.get(p.version_id);
    if (!version) throw new RegistrationError(`待发布版本不存在: ${p.version_id}`);
    if (version.status !== "approved" && version.status !== "published") {
      throw new RegistrationError(`版本 ${p.version_id} 尚未审批，不能发布`);
    }
    if (version.status === "published") {
      // 幂等重发：保持原占用，不重复登记，也不改写已入库事件。
      return;
    }
    const effectiveAt = t(p.effective_at ?? e.occurred_at);
    const race = this.races.get(plan.race_id);

    // 生成该版本自生效时刻起的资源占用，并与其他方案（同方案祖版除外）冲突检测。
    const roster = this.versionRoster(version);
    const conflicts = [];
    const incoming = [];
    for (const resource of roster) {
      const w = {
        start: Math.max(t(resource.window.start), effectiveAt),
        end: Math.min(t(resource.window.end), race.period.end),
      };
      if (w.end <= w.start) continue;
      incoming.push({ resource_id: resource.resource_id, ...w });
      for (const claim of this.activeClaims(w.start, w.end)) {
        if (claim.resource_id !== resource.resource_id) continue;
        if (claim.plan_id === plan.plan_id) continue; // 祖版在生效时被取代，不冲突
        conflicts.push({
          resource_id: resource.resource_id,
          window: { start: w.start, end: w.end },
          held_by: { plan_id: claim.plan_id, version_id: claim.version_id, window: { start: claim.start, end: claim.end } },
        });
      }
    }
    if (conflicts.length) {
      const err = new RegistrationError("资源在重叠时段已被其他方案占用");
      err.conflicts = conflicts;
      throw err;
    }

    // 祖版占用在生效时刻截断（历史部分保留，供回放当时状态）。
    if (version.revises_version) {
      for (const claim of this.claims) {
        if (claim.plan_id === plan.plan_id && claim.end > effectiveAt && claim.start < effectiveAt) {
          claim.end = effectiveAt;
        }
      }
    }
    for (const claim of incoming) {
      this.claims.push({ ...claim, plan_id: plan.plan_id, version_id: version.version_id });
    }
    version.status = "published";
    version.published_at = t(e.occurred_at);
    version.effective_at = effectiveAt;
    version.claims = incoming;
    plan.head_version = version.version_id;
  }

  _on_PLAN_WITHDRAWN(e) {
    const p = e.payload;
    const plan = this._plan(p.plan_id);
    const version = plan?.versions.get(p.version_id);
    if (!version || version.status !== "published") {
      throw new RegistrationError(`只能撤回已发布版本: ${p.version_id}`);
    }
    const at = t(e.occurred_at);
    version.status = "withdrawn";
    version.withdrawn_at = at;
    for (const claim of this.claims) {
      if (claim.version_id !== p.version_id) continue;
      if (claim.start < at) claim.end = Math.min(claim.end, at);
      else claim.start = claim.end = at; // 尚未开始的占用作废
    }
  }

  // --- 读取 -----------------------------------------------------------------

  // 某时刻与 [fromMs,toMs) 重叠的有效占用；撤回时尾巴已截断，此处只过滤空占用。
  activeClaims(fromMs, toMs) {
    return this.claims.filter((c) => c.end > c.start && c.start < toMs && c.end > fromMs);
  }

  // 查询资源在某时刻的占用方（供覆盖引擎的替代建议标注）。
  ownerOf(resourceId, atMs) {
    const hit = this.activeClaims(atMs, atMs + 1).find((c) => c.resource_id === resourceId);
    return hit ? { plan_id: hit.plan_id, version_id: hit.version_id } : null;
  }

  versionRoster(version) {
    const out = [];
    for (const ev of version.content_events) {
      if (ev.kind === "RESOURCE_DECLARED" && ev.payload.plan_id) out.push(ev.payload);
    }
    // 后声明覆盖先声明（同一 resource_id 的窗口/资质调整）。
    const map = new Map();
    for (const r of out) map.set(r.resource_id, r);
    return [...map.values()];
  }

  versionStations(version) {
    const map = new Map();
    for (const ev of version.content_events) {
      if (ev.kind === "AID_STATION_OPENING_SET") map.set(ev.payload.station_id, ev.payload);
    }
    return [...map.values()];
  }

  versionChosenRoutes(version) {
    // 键为 resource|to_node：覆盖引擎评估该资源到各分段节点的行驶时间时命中。
    const map = new Map();
    for (const ev of version.content_events) {
      if (ev.kind !== "ROUTE_CHOSEN") continue;
      const p = ev.payload;
      map.set(`${p.resource_id}|${p.to_node}`, {
        edges: p.path, reason: p.reason ?? null, purpose: p.purpose, declared_at: t(ev.occurred_at),
      });
    }
    return map;
  }

  publishedVersionAt(planId, atMs) {
    const plan = this.plans.get(planId);
    if (!plan) return null;
    // 沿修订链找生效时间覆盖 at 的最新版本。
    let cur = plan.head_version;
    while (cur) {
      const v = plan.versions.get(cur);
      if (v.status === "published" && v.effective_at <= atMs) return v;
      cur = v.revises_version;
    }
    return null;
  }
}
