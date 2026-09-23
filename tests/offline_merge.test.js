import assert from "node:assert/strict";
import test from "node:test";
import { createMergeState, effectiveCasualty, mergeMessages, snapshotMergeState } from "../src/offline_merge.js";

const pos = (seq, lng, extra = {}) => ({
  kind: "POSITION_REPORTED",
  source_id: "gps-V1",
  seq,
  unit_id: "V1",
  position: { lng, lat: 31.2 },
  occurred_at: `2026-09-23T10:${String(seq).padStart(2, "0")}:00+08:00`,
  ...extra,
});

const status = (seq, s, extra = {}) => ({
  kind: "TRANSPORT_STATUS_RECORDED",
  source_id: "dispatch",
  seq,
  transport_id: "T1",
  status: s,
  occurred_at: `2026-09-23T10:${String(seq).padStart(2, "0")}:00+08:00`,
  ...extra,
});

test("断网恢复后按来源序列合并，与到达顺序无关", () => {
  const ordered = [status(1, "REPORTED"), status(2, "DISPATCHED"), status(3, "ARRIVED"), status(4, "TRANSPORTING"), status(5, "HANDED_OVER")];
  const shuffled = [ordered[4], ordered[2], ordered[0], ordered[3], ordered[1]];

  const a = createMergeState();
  mergeMessages(a, ordered);
  const b = createMergeState();
  mergeMessages(b, shuffled);
  assert.deepEqual(snapshotMergeState(a), snapshotMergeState(b));
  assert.equal(b.transports.get("T1").status, "HANDED_OVER");
});

test("已完成转运事实不可被较晚到达的旧消息回退", () => {
  const state = createMergeState();
  mergeMessages(state, [status(1, "REPORTED"), status(2, "DISPATCHED"), status(3, "ARRIVED"), status(4, "TRANSPORTING"), status(5, "HANDED_OVER")]);
  // 另一来源迟到的旧状态试图把转运拉回 ARRIVED
  const late = status(1, "ARRIVED", { source_id: "medic-7", occurred_at: "2026-09-23T10:03:00+08:00" });
  const { rejected } = mergeMessages(state, [late]);
  assert.equal(rejected[0].reason, "MONOTONIC_VIOLATION");
  assert.equal(state.transports.get("T1").status, "HANDED_OVER");
});

test("位置只保留各来源最新序号，旧序号到达即丢弃", () => {
  // 同一批恢复上传的消息先按来源序列排序，乱序到达不影响结果
  const batch = createMergeState();
  mergeMessages(batch, [pos(2, 121.5), pos(1, 121.4)]);
  assert.equal(batch.positions.get("V1").position.lng, 121.5);

  // 已有更新序号后，更旧的序号被丢弃；重复消息被去重
  const state = createMergeState();
  mergeMessages(state, [pos(2, 121.5)]);
  const { applied, rejected } = mergeMessages(state, [pos(1, 121.4), pos(2, 121.5)]);
  assert.equal(state.positions.get("V1").position.lng, 121.5);
  assert.deepEqual(rejected.map((r) => r.reason), ["STALE_POSITION", "DUPLICATE"]);
  assert.equal(applied.length, 0);
});

test("伤情报告按来源保留各自最新，有效报告取序号最大者", () => {
  const state = createMergeState();
  mergeMessages(state, [
    { kind: "CASUALTY_REPORTED", source_id: "medic-1", seq: 1, casualty_id: "C1", report: { triage: "yellow" }, occurred_at: "2026-09-23T10:01:00+08:00" },
    { kind: "CASUALTY_REPORTED", source_id: "medic-2", seq: 1, casualty_id: "C1", report: { triage: "red" }, occurred_at: "2026-09-23T10:02:00+08:00" },
    { kind: "CASUALTY_REPORTED", source_id: "medic-1", seq: 2, casualty_id: "C1", report: { triage: "red", note: "恶化" }, occurred_at: "2026-09-23T10:03:00+08:00" },
  ]);
  assert.deepEqual(effectiveCasualty(state, "C1"), { triage: "red", note: "恶化" });
  // 同一来源的旧序号报告被丢弃
  const { rejected } = mergeMessages(state, [
    { kind: "CASUALTY_REPORTED", source_id: "medic-1", seq: 1, casualty_id: "C1", report: { triage: "yellow" }, occurred_at: "2026-09-23T10:01:00+08:00" },
  ]);
  assert.equal(rejected[0].reason, "DUPLICATE");
});
