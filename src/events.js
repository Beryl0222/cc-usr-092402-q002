// 赛事医疗资源编排：事件目录、校验与版本图。
//
// 所有状态变化都以不可变事件表达；注册表负责把事件按发生时间排序归并，
// 计算（覆盖引擎、占用账本、现场消息流）只读取事件投影，不直接改库。

export const EVENT_KINDS = Object.freeze([
  // 赛事基础资料
  "EVENT_RISK_FILED", // 路线分段、观众密度、风险等级建档
  // 方案生命周期
  "PLAN_DRAFTED", // 方案草稿创建（不产生任何资源占用）
  "PLAN_DRILL_RUN", // 一次覆盖演练（可针对情景覆盖层：高温/封路/设备失效）
  "PLAN_APPROVED", // 方案获批（仍不占用资源，只冻结为可发布版本）
  "PLAN_PUBLISHED", // 方案发布：占用资源、成为执行基线；同 version_id 重发幂等
  "PLAN_REVISED", // 局部重算产出的新版本，指向被修订的已发布版本
  "PLAN_WITHDRAWN", // 撤回尚未到期的已发布占用（不改变历史事件）
  // 方案内容
  "AID_STATION_OPENING_SET", // 急救点开放窗
  "RESOURCE_DECLARED", // 车辆 / 人员资质与可用窗口
  "HOSPITAL_CAPACITY_FILED", // 医院接收能力（可随时间变化）
  "ROUTE_CLOSURE_FILED", // 道路封闭（演练情景或现场生效）
  "WEATHER_ALERT_FILED", // 突发高温等天气情景
  "EQUIPMENT_FAILURE_FILED", // 设备失效情景
  "QUALIFICATION_REVOKED", // 资质在值守中途被吊销/中止（生效时刻起）
  "ROUTE_CHOSEN", // 人工选择行驶路径；非最快路径必须给出理由
  // 执行与现场
  "INCIDENT_ESCALATED",
  "HANDOFF_COMPLETED",
  "FIELD_MESSAGE_RECEIVED", // 断网期间缓存、恢复后回传的位置/伤情消息
]);

export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

const PAYLOAD_SHAPE = Object.freeze({
  EVENT_RISK_FILED: { required: ["race_id", "segments"], },
  PLAN_DRAFTED: { required: ["plan_id", "race_id"], optional: ["coverage_scope"] },
  PLAN_DRILL_RUN: { required: ["plan_id", "drill_id", "based_on_version"], },
  PLAN_APPROVED: { required: ["plan_id", "version_id", "approver"], optional: ["gap_waivers"] },
  PLAN_PUBLISHED: { required: ["plan_id", "version_id"], },
  PLAN_REVISED: { required: ["plan_id", "version_id", "revises_version"], },
  PLAN_WITHDRAWN: { required: ["plan_id", "version_id", "reason"], },
  AID_STATION_OPENING_SET: { required: ["plan_id", "station_id", "node", "window"] },
  RESOURCE_DECLARED: {
    required: ["resource_id", "type", "qualifications", "window"],
    optional: ["plan_id", "race_id", "home_location", "vehicle_kind", "station_id"],
  },
  HOSPITAL_CAPACITY_FILED: { required: ["hospital_id", "node", "window", "slots"] },
  ROUTE_CLOSURE_FILED: { required: ["closure_id", "window", "edges"] },
  WEATHER_ALERT_FILED: { required: ["alert_id", "window", "heat_index"] },
  EQUIPMENT_FAILURE_FILED: { required: ["failure_id", "window", "resource_id"] },
  QUALIFICATION_REVOKED: { required: ["resource_id", "code", "effective_at"], optional: ["reason"] },
  ROUTE_CHOSEN: {
    required: ["plan_id", "resource_id", "to_node", "purpose", "path"],
    optional: ["from_node", "travel_seconds", "reason"],
  },
  INCIDENT_ESCALATED: { required: ["incident_id", "segment_id", "at"], },
  HANDOFF_COMPLETED: { required: ["incident_id", "hospital_id", "at"], },
  FIELD_MESSAGE_RECEIVED: { required: ["source", "seq", "sent_at", "body"], optional: ["received_at"] },
});

export function validateEvent(record) {
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if (!EVENT_KINDS.includes(record.kind)) {
    problems.push("kind");
    return problems;
  }
  const shape = PAYLOAD_SHAPE[record.kind];
  const payload = record.payload ?? {};
  if (shape) {
    for (const field of shape.required ?? []) {
      if (!(field in payload)) problems.push(`payload.${field}`);
    }
  }
  if ("window" in payload && payload.window) {
    const w = payload.window;
    if (!(typeof w === "object" && "start" in w && "end" in w)) {
      problems.push("payload.window");
    } else if (Date.parse(w.end) <= Date.parse(w.start)) {
      problems.push("payload.window:end-after-start");
    }
  }
  return problems;
}

// 方案版本图：每次审批冻结一个 version_id；revises 指向它修订的已发布版本。
export class VersionGraph {
  constructor() {
    this._parent = new Map(); // version_id -> revises_version | null
    this._plans = new Map(); // version_id -> plan_id
  }

  register(versionId, planId, revisesVersion = null) {
    if (this._parent.has(versionId)) {
      throw new Error(`版本重复登记: ${versionId}`);
    }
    if (revisesVersion && !this._parent.has(revisesVersion)) {
      throw new Error(`修订基线不存在: ${revisesVersion}`);
    }
    this._parent.set(versionId, revisesVersion);
    this._plans.set(versionId, planId);
  }

  planOf(versionId) {
    return this._plans.get(versionId);
  }

  // 同一 plan_id 下，从给定版本向上的祖先行（含自身）。
  ancestors(versionId) {
    const chain = [];
    let cur = versionId;
    const seen = new Set();
    while (cur != null) {
      if (seen.has(cur)) throw new Error("版本图出现环路");
      seen.add(cur);
      chain.push(cur);
      cur = this._parent.get(cur);
    }
    return chain;
  }
}
