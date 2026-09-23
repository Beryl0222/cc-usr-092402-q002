// race_medical_dispatch 领域资料：事件种类、最小字段校验，以及各功能模块的统一入口。
//
// 流程约定：草稿(PLAN_VERSION_DRAFTED) → 审批(PLAN_APPROVED) → 发布(PLAN_VERSION_PUBLISHED)，
// 演练建议(DRILL_RECOMMENDATION_FILED)只依附草稿版本；发布后遇突发扰动(DISRUPTION_FILED)
// 做局部重算，替代资源经审批(SUBSTITUTION_APPROVED)后随新版本发布，旧版本随之废止
// (PLAN_VERSION_SUPERSEDED)。断网期间的位置/伤情/转运消息携带来源序列，恢复后按来源合并。

export const EVENT_KINDS = Object.freeze([
  // 既有约定
  "EVENT_RISK_FILED",
  "RESOURCE_DECLARED",
  "PLAN_APPROVED",
  "INCIDENT_ESCALATED",
  "HANDOFF_COMPLETED",
  // 版本化演练与发布
  "PLAN_VERSION_DRAFTED",
  "DRILL_RECOMMENDATION_FILED",
  "COVERAGE_SNAPSHOT_RECORDED",
  "PLAN_VERSION_PUBLISHED",
  "PLAN_VERSION_SUPERSEDED",
  "SUBSTITUTION_APPROVED",
  "DISRUPTION_FILED",
  // 断网续传（携带 source_id 与 seq）
  "POSITION_REPORTED",
  "CASUALTY_REPORTED",
  "TRANSPORT_STATUS_RECORDED",
]);

export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

// 各类事件在 payload 上的最小字段要求；未列出的事件种类只校验顶层必填字段。
export const PAYLOAD_REQUIREMENTS = Object.freeze({
  PLAN_VERSION_DRAFTED: Object.freeze(["plan_id", "version"]),
  DRILL_RECOMMENDATION_FILED: Object.freeze(["plan_id", "based_on_version", "suggestions"]),
  COVERAGE_SNAPSHOT_RECORDED: Object.freeze(["plan_id", "version", "segments"]),
  PLAN_VERSION_PUBLISHED: Object.freeze(["plan_id", "version"]),
  PLAN_VERSION_SUPERSEDED: Object.freeze(["plan_id", "version", "superseded_by"]),
  SUBSTITUTION_APPROVED: Object.freeze(["plan_id", "version", "substitution"]),
  DISRUPTION_FILED: Object.freeze(["disruption"]),
  POSITION_REPORTED: Object.freeze(["source_id", "seq", "unit_id", "position"]),
  CASUALTY_REPORTED: Object.freeze(["source_id", "seq", "casualty_id", "report"]),
  TRANSPORT_STATUS_RECORDED: Object.freeze(["source_id", "seq", "transport_id", "status"]),
});

// 返回问题字段名列表；空数组表示符合约定。
export function validateEvent(record) {
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if (!EVENT_KINDS.includes(record.kind)) {
    problems.push("kind");
    return problems;
  }
  if (record.payload !== null && typeof record.payload === "object") {
    for (const field of PAYLOAD_REQUIREMENTS[record.kind] ?? []) {
      if (!(field in record.payload)) problems.push(`payload.${field}`);
    }
  }
  return problems;
}

export * from "./time.js";
export * from "./coverage.js";
export * from "./disruptions.js";
export * from "./plans.js";
export * from "./offline_merge.js";
export * from "./volunteer_view.js";
export * from "./shifts.js";
export * from "./replay.js";
