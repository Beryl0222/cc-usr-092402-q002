import assert from "node:assert/strict";
import test from "node:test";
import { t } from "../src/time_windows.js";
import { FieldMessageLog, IncidentFacts } from "../src/field_messages.js";
import { replayVersion, volunteerView } from "../src/replay.js";
import { buildWorld, publishAlphaV1, publishAlphaV2, ev } from "./helpers/fixture.js";

function fieldMsg(source, seq, sentAt, body, receivedAt = null) {
  return ev("FIELD_MESSAGE_RECEIVED", receivedAt ?? sentAt, { source, seq, sent_at: sentAt, body });
}

test("断网恢复：乱序消息按来源序列合并，缺口补齐前后续消息保持缓冲", () => {
  const log = new FieldMessageLog();
  const m1 = fieldMsg("radio-7", 1, "2026-09-26T22:31:00+08:00", { kind: "LOCATION", incident_id: "INC-1", node: "n2" });
  const m3 = fieldMsg("radio-7", 3, "2026-09-26T22:33:00+08:00", { kind: "LOCATION", incident_id: "INC-1", node: "n3" },
    "2026-09-26T22:40:00+08:00");
  const m2 = fieldMsg("radio-7", 2, "2026-09-26T22:32:00+08:00", { kind: "LOCATION", incident_id: "INC-1", node: "n2b" },
    "2026-09-26T22:41:00+08:00");

  assert.equal(log.receive([m1, m3]), 2);
  assert.deepEqual(log.missingSeqs("radio-7"), [2]);
  assert.deepEqual(log.releaseContinuous("radio-7").map((m) => m.seq), [1]);
  assert.equal(log.bufferedCount("radio-7"), 1, "seq3 必须缓冲，不能越过缺口先生效");
  log.receive(m2);
  // 再次释放只返回水位线之后补齐的部分，但全局次序仍是 1→2→3。
  assert.deepEqual(log.releaseContinuous("radio-7").map((m) => m.seq), [2, 3]);
  assert.deepEqual(log.merged().map((m) => m.seq), [1, 2, 3]);
});

test("重复投递去重；不同来源各自独立排序后按发送时刻归并", () => {
  const log = new FieldMessageLog();
  const m = fieldMsg("radio-7", 1, "2026-09-26T22:31:00+08:00", { kind: "TRIAGE", incident_id: "INC-1", severity: "yellow" });
  assert.equal(log.receive(m), 1);
  assert.equal(log.receive({ ...m, event_id: "evt-dup" }), 0, "同 source#seq 重传不重复入库");

  log.receive(fieldMsg("watch-3", 1, "2026-09-26T22:30:30+08:00", { kind: "LOCATION", incident_id: "INC-1", node: "n1" }));
  const merged = log.replay().map((m) => `${m.source}#${m.seq}`);
  assert.deepEqual(merged, ["watch-3#1", "radio-7#1"]);
});

test("已完成转运是吸收态：较晚到达的旧 EN_ROUTE 消息不能回退事实", () => {
  const log = new FieldMessageLog();
  const facts = new IncidentFacts();

  const handoff = ev("HANDOFF_COMPLETED", "2026-09-26T23:10:00+08:00", {
    incident_id: "INC-9", hospital_id: "H2", at: "2026-09-26T23:09:00+08:00",
  });
  facts.applyHandoff(handoff);

  // 断网缓存的旧消息，恢复后才到达：sent 22:50，received 23:20。
  const stale = fieldMsg("radio-7", 4, "2026-09-26T22:50:00+08:00",
    { kind: "TRANSPORT_STATUS", incident_id: "INC-9", stage: "EN_ROUTE" },
    "2026-09-26T23:20:00+08:00");
  log.receive(stale);
  // 恢复合并后逐条应用（模拟 releaseContinuous 产出的规范化消息）。
  const normalized = {
    source: "radio-7", seq: 4,
    sent_at: t("2026-09-26T22:50:00+08:00"),
    received_at: t("2026-09-26T23:20:00+08:00"),
    body: { kind: "TRANSPORT_STATUS", incident_id: "INC-9", stage: "EN_ROUTE" },
  };
  const applied = facts.applyMessage(normalized);
  assert.equal(applied, false);
  assert.equal(facts.incidents.get("INC-9").transport.stage, "COMPLETED");
  assert.equal(facts.rejected[0].reason, "COMPLETION_ABSORBING");
});

test("转运阶段不可倒退、同来源序号倒退拒收，但新事实可继续向后推进", () => {
  const facts = new IncidentFacts();
  const mk = (source, seq, sent, stage) => ({
    source, seq, sent_at: t(sent), received_at: t(sent),
    body: { kind: "TRANSPORT_STATUS", incident_id: "INC-2", stage },
  });
  assert.equal(facts.applyMessage(mk("radio-1", 1, "2026-09-26T23:00:00+08:00", "EN_ROUTE")), true);
  assert.equal(facts.applyMessage(mk("radio-1", 2, "2026-09-26T23:05:00+08:00", "AT_HOSPITAL")), true);
  // 迟到的 seq1（重传/乱序）。
  assert.equal(facts.applyMessage(mk("radio-1", 1, "2026-09-26T23:00:00+08:00", "EN_ROUTE")), false);
  assert.equal(facts.rejected.at(-1).reason, "STALE_SEQ");
  // 其他来源试图把阶段改回 EN_ROUTE。
  assert.equal(facts.applyMessage(mk("radio-9", 1, "2026-09-26T23:06:00+08:00", "EN_ROUTE")), false);
  assert.equal(facts.rejected.at(-1).reason, "STAGE_REGRESSION");
  assert.equal(facts.incidents.get("INC-2").transport.stage, "AT_HOSPITAL");
});

test("现场重播：实际转运与版本计划的偏差（改院、耗时差）随版本给出", () => {
  const { network, registry } = buildWorld();
  publishAlphaV1(registry);

  const occurred = "2026-09-26T23:00:00+08:00";
  registry.append(ev("INCIDENT_ESCALATED", "2026-09-26T23:00:30+08:00", {
    incident_id: "INC-5", segment_id: "seg-A", at: occurred,
  }));
  // 计划为 H1，实际改送 H2（例如 H1 饱和），30 分钟完成交接。
  registry.append(ev("HANDOFF_COMPLETED", "2026-09-26T23:30:00+08:00", {
    incident_id: "INC-5", hospital_id: "H2", at: "2026-09-26T23:30:00+08:00",
  }));

  const facts = IncidentFacts.fromLog(new FieldMessageLog(), [...registry.handoffs.values()].map((h) => ({
    kind: "HANDOFF_COMPLETED", occurred_at: new Date(h.event_at).toISOString(),
    payload: { incident_id: h.incident_id, hospital_id: h.hospital_id, at: new Date(h.at).toISOString() },
  })));

  const replay = replayVersion(registry, network, "plan-alpha", "plan-alpha-v1",
    t("2026-09-26T23:45:00+08:00"), facts);
  const dev = replay.transport_deviations.find((d) => d.incident_id === "INC-5");
  assert.equal(dev.planned.hospital, "H1");
  assert.equal(dev.actual.hospital, "H2");
  assert.ok(dev.deviations.some((d) => d.kind === "HOSPITAL_CHANGED"));
  assert.ok(dev.deviations.some((d) => d.kind === "ELAPSED_DELTA_SECONDS"));
});

test("外部志愿者视图：只见本人值守段与节点，看不到医院容量/他人安排/内部推演", () => {
  const { network, registry } = buildWorld();
  publishAlphaV1(registry);
  publishAlphaV2(registry, { slowRoute: "none" });

  const view = volunteerView(
    registry, network, "plan-alpha", "plan-alpha-v2",
    {
      volunteer_id: "V-021",
      assignments: { segments: ["seg-B"], resource_ids: ["T3N"] },
    },
    t("2026-09-27T01:00:00+08:00"),
  );

  assert.deepEqual(view.duties.map((d) => d.segment_id), ["seg-B"]);
  assert.equal(view.you_cover_this_segment ?? view.duties[0].you_cover_this_segment, true);
  const json = JSON.stringify(view);
  assert.doesNotMatch(json, /H1|H2|slots/);
  assert.doesNotMatch(json, /T1"|A1"/);
  assert.match(json, /T3N/);
  assert.match(json, /report_to_node/);
});

test("志愿者负责段在跨日接班缝隙中无人负责时收到提醒，但看不到替补候选", () => {
  const { network, registry } = buildWorld();
  publishAlphaV1(registry); // T3 als 00:15 到期且无接班
  const view = volunteerView(
    registry, network, "plan-alpha", "plan-alpha-v1",
    { volunteer_id: "V-021", assignments: { segments: ["seg-A", "seg-B"], resource_ids: ["T3"] } },
    t("2026-09-26T23:30:00+08:00"),
  );
  assert.ok(view.notices.some((n) => n.type === "SEGMENT_UNCOVERED_AHEAD" && n.segment_id === "seg-B"));
  assert.doesNotMatch(JSON.stringify(view), /suggestions|candidates|A2/);
});
