import assert from "node:assert/strict";
import test from "node:test";
import { replayPlan } from "../src/replay.js";

const events = [
  { event_id: "e1", kind: "PLAN_VERSION_PUBLISHED", occurred_at: "2026-09-23T07:30:00+08:00", subject_id: "P", payload: { plan_id: "P", version: 1 } },
  {
    event_id: "e2", kind: "COVERAGE_SNAPSHOT_RECORDED", occurred_at: "2026-09-23T07:30:01+08:00", subject_id: "P",
    payload: {
      plan_id: "P", version: 1,
      segments: [
        { segment_id: "S1", covered: true, required: { target_minutes: 5 }, shortfall: 0, reasons: [] },
        { segment_id: "S2", covered: false, required: { target_minutes: 10 }, shortfall: 1, reasons: ["UNITS_SHORT"] },
      ],
    },
  },
  { event_id: "e3", kind: "SUBSTITUTION_APPROVED", occurred_at: "2026-09-23T08:00:00+08:00", subject_id: "P", payload: { plan_id: "P", version: 1, substitution: { resource_id: "V4", segment_id: "S2" } } },
  { event_id: "e4", kind: "TRANSPORT_STATUS_RECORDED", occurred_at: "2026-09-23T10:00:00+08:00", subject_id: "T1", payload: { plan_id: "P", source_id: "dispatch", seq: 1, transport_id: "T1", status: "REPORTED", segment_id: "S1", planned_total_minutes: 35 } },
  { event_id: "e5", kind: "TRANSPORT_STATUS_RECORDED", occurred_at: "2026-09-23T10:06:00+08:00", subject_id: "T1", payload: { plan_id: "P", source_id: "dispatch", seq: 2, transport_id: "T1", status: "ARRIVED", segment_id: "S1" } },
  { event_id: "e6", kind: "HANDOFF_COMPLETED", occurred_at: "2026-09-23T10:40:00+08:00", subject_id: "T1", payload: { plan_id: "P", transport_id: "T1", segment_id: "S1" } },
  // 重复发布同一版本（例如网络重试），回放时应幂等
  { event_id: "e7", kind: "PLAN_VERSION_PUBLISHED", occurred_at: "2026-09-23T07:30:05+08:00", subject_id: "P", payload: { plan_id: "P", version: 1 } },
  // 后续新版本及其快照，不应影响旧版本的回放
  { event_id: "e8", kind: "PLAN_VERSION_PUBLISHED", occurred_at: "2026-09-23T11:00:00+08:00", subject_id: "P", payload: { plan_id: "P", version: 2 } },
  {
    event_id: "e9", kind: "COVERAGE_SNAPSHOT_RECORDED", occurred_at: "2026-09-23T11:00:01+08:00", subject_id: "P",
    payload: {
      plan_id: "P", version: 2,
      segments: [
        { segment_id: "S1", covered: true, required: { target_minutes: 5 }, shortfall: 0, reasons: [] },
        { segment_id: "S2", covered: true, required: { target_minutes: 10 }, shortfall: 0, reasons: [] },
      ],
    },
  },
];

test("回放任一版本：当时的覆盖缺口、获批替代与实际转运偏差", () => {
  const replay = replayPlan(events, "P", 1);
  assert.equal(replay.version, 1);
  assert.equal(replay.published_at, "2026-09-23T07:30:00+08:00"); // 重复发布未改写首次发布时间
  assert.deepEqual(replay.coverage_gaps, [{ segment_id: "S2", shortfall: 1, reasons: ["UNITS_SHORT"] }]);
  assert.deepEqual(replay.substitutions, [{ resource_id: "V4", segment_id: "S2" }]);
  assert.deepEqual(replay.deviations, [
    {
      transport_id: "T1",
      segment_id: "S1",
      response_minutes: 6,
      target_minutes: 5,
      response_deviation: 1,
      total_minutes: 40,
      planned_total_minutes: 35,
      total_deviation: 5,
    },
  ]);
});

test("默认回放最新发布版本，旧版本快照不受新版本影响", () => {
  const latest = replayPlan(events, "P");
  assert.equal(latest.version, 2);
  assert.deepEqual(latest.coverage_gaps, []);
  const v1 = replayPlan(events, "P", 1);
  assert.deepEqual(v1.coverage_gaps, [{ segment_id: "S2", shortfall: 1, reasons: ["UNITS_SHORT"] }]);
});

test("其他方案的事件不混入回放", () => {
  const other = [
    ...events,
    { event_id: "x1", kind: "PLAN_VERSION_PUBLISHED", occurred_at: "2026-09-23T09:00:00+08:00", subject_id: "Q", payload: { plan_id: "Q", version: 1 } },
  ];
  assert.equal(replayPlan(other, "Q").version, 1);
  assert.equal(replayPlan(other, "P", 1).coverage_gaps.length, 1);
});
