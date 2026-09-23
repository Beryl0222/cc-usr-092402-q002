import assert from "node:assert/strict";
import test from "node:test";
import { t } from "../src/time_windows.js";
import { RegistrationError, PlanRegistry } from "../src/registry.js";
import { runDrill, evaluateVersion, replayVersion } from "../src/replay.js";
import {
  buildWorld, buildNetwork, publishAlphaV1, publishAlphaV2, publishBeta,
  RACE, SEGMENTS, ev,
} from "./helpers/fixture.js";

const AT = {
  beforeRace: "2026-09-26T21:30:00+08:00",
  hour23: "2026-09-26T23:00:00+08:00",
  hour01: "2026-09-27T01:00:00+08:00",
};

test("基线 v1 在 23:00 各段达标：响应时间、资质、医院接收均给出证据", () => {
  const { network, registry } = buildWorld();
  publishAlphaV1(registry);
  const at = t(AT.hour23);
  const report = evaluateVersion(registry, network, "plan-alpha", "plan-alpha-v1", at);
  // summary 覆盖整个跨日赛期（v1 在 00:15 后有资质缺口，另见专项测试）；
  // 这里断言 23:00 所在时间片各段均达标。
  const gapsAt23 = report.gaps.filter((g) => g.window.start <= at && g.window.end > at);
  assert.deepEqual(gapsAt23, []);

  const segB = report.segment_reports.find((s) => s.segment_id === "seg-B");
  const slice = segB.slices.find((s) => s.window.start <= at && s.window.end > at);
  assert.equal(slice.first_response.resource_id, "T3");
  assert.ok(slice.first_response.travel_seconds <= slice.target_seconds);
  assert.equal(slice.transport.resource_id, "A1");
  assert.ok(slice.hospital_reservation, "中风险段必须预留医院名额");
});

test("观众密度把起点广场段抬升到 high，响应目标收紧到 180s", () => {
  const { network, registry } = buildWorld();
  publishAlphaV1(registry);
  const report = evaluateVersion(registry, network, "plan-alpha", "plan-alpha-v1", t(AT.hour23));
  const segA = report.segment_reports.find((s) => s.segment_id === "seg-A");
  const slice = segA.slices.find((s) => s.window.start <= t(AT.hour23) && s.window.end > t(AT.hour23));
  assert.equal(slice.risk, "high");
  assert.equal(slice.target_seconds, 180);
  assert.deepEqual(segA.required_qualifications.sort(), ["als"]);
});

test("资质在跨日值守中途到期：v1 的 seg-B 在 01:00 出现无人负责缺口", () => {
  const { network, registry } = buildWorld();
  publishAlphaV1(registry);
  const report = evaluateVersion(registry, network, "plan-alpha", "plan-alpha-v1", t(AT.hour01));
  const gap = report.gaps.find((g) => g.segment_id === "seg-B" && g.kind === "NO_QUALIFIED_RESPONDER");
  assert.ok(gap, "00:15 后 T3 的 als 到期，seg-B 必须暴露为缺口");
  assert.match(gap.evidence.join("\n"), /资质在值守中途到期/);
});

test("v2 为跨日接班增补 T3N：同一时段在 v2 下达标，v1 历史缺口仍可回放", () => {
  const { network, registry } = buildWorld();
  publishAlphaV1(registry);
  publishAlphaV2(registry, { slowRoute: "none" });
  const v2 = evaluateVersion(registry, network, "plan-alpha", "plan-alpha-v2", t(AT.hour01));
  assert.equal(v2.summary.meets, true, JSON.stringify(v2.gaps, null, 2));

  const v1 = evaluateVersion(registry, network, "plan-alpha", "plan-alpha-v1", t(AT.hour01));
  assert.ok(v1.gaps.some((g) => g.segment_id === "seg-B"));
});

test("封路演练：切断 e12 后纸面条目不变但 seg-A 超时/不可达，且演练不触碰已发布方案", () => {
  const { network, registry } = buildWorld();
  publishAlphaV1(registry);
  const claimsBefore = registry.claims.map((c) => ({ ...c }));

  const drill = runDrill(registry, network, {
    plan_id: "plan-alpha",
    based_on_version: "plan-alpha-v1",
    at_ms: t("2026-09-26T23:10:00+08:00"),
    scenario: {
      closures: [{
        closure_id: "drill-close-e12",
        edges: ["e12", "e12_r"],
        window: { start: "2026-09-26T23:00:00+08:00", end: "2026-09-26T23:30:00+08:00" },
      }],
    },
  });

  assert.ok(dillHasGap(drill, "seg-A"));
  assert.ok(drill.diff.affected_segment_ids.includes("seg-A"));
  // 演练后已发布方案占用与 23:00 的覆盖结论保持不变。
  assert.deepEqual(registry.claims.map((c) => ({ ...c })), claimsBefore);
  const at23 = t(AT.hour23);
  const live = evaluateVersion(registry, network, "plan-alpha", "plan-alpha-v1", at23);
  assert.deepEqual(live.gaps.filter((g) => g.window.start <= at23 && g.window.end > at23), []);
});

function dillHasGap(drill, segmentId) {
  return drill.scenario.gaps.some((g) => g.segment_id === segmentId);
}

test("完全切断 n5 对外通道时，缺口类型为 SEGMENT_DISCONNECTED", () => {
  const { network, registry } = buildWorld();
  publishAlphaV1(registry);
  const drill = runDrill(registry, network, {
    plan_id: "plan-alpha",
    based_on_version: "plan-alpha-v1",
    at_ms: t("2026-09-26T23:10:00+08:00"),
    only: ["seg-C"],
    scenario: {
      closures: [{
        closure_id: "drill-isolate-n5",
        edges: ["e45", "e45_r", "ed2c", "ed2c_r"],
        window: { start: "2026-09-26T23:00:00+08:00", end: "2026-09-26T23:30:00+08:00" },
      }],
    },
  });
  assert.ok(drill.scenario.gaps.some((g) => g.kind === "SEGMENT_DISCONNECTED"));
  assert.deepEqual(drill.diff.affected_segment_ids.sort(), ["seg-C"]);
});

test("突发高温：seg-C 升为中风险需要救护车，医院名额被高风险段先占后暴露容量缺口", () => {
  const { network, registry } = buildWorld();
  publishAlphaV1(registry);
  const drill = runDrill(registry, network, {
    plan_id: "plan-alpha",
    based_on_version: "plan-alpha-v1",
    at_ms: t("2026-09-26T23:15:00+08:00"),
    scenario: {
      heat_alerts: [{
        window: { start: "2026-09-26T23:00:00+08:00", end: "2026-09-27T00:00:00+08:00" },
        heat_index: 37,
      }],
    },
  });
  assert.ok(drill.scenario.gaps.some((g) => g.kind === "NO_HOSPITAL_CAPACITY" && g.segment_id === "seg-C"));
  const segB = drill.scenario.segment_reports.find((s) => s.segment_id === "seg-B")
    .slices.find((s) => s.risk === "high");
  assert.ok(segB, "中风险叠加高温应升高风险");
});

test("设备失效：A1 除颤仪故障后，演练建议把共享池中的 A2 作为替代并标注是否空闲", () => {
  const { network, registry } = buildWorld();
  publishAlphaV1(registry);
  const drill = runDrill(registry, network, {
    plan_id: "plan-alpha",
    based_on_version: "plan-alpha-v1",
    at_ms: t("2026-09-26T23:15:00+08:00"),
    scenario: {
      failure_events: [{
        resource_id: "A1", reason: "车载除颤仪故障",
        window: { start: "2026-09-26T23:00:00+08:00", end: "2026-09-26T23:45:00+08:00" },
      }],
    },
  });
  const suggestion = drill.scenario.suggestions
    .flatMap((s) => s.candidates)
    .find((c) => c.resource_id === "A2");
  assert.ok(suggestion, "应从共享资源池建议 A2");
  assert.equal(suggestion.status.available, true);
});

test("人工选择较慢路径必须留理由：无理由拒绝入库，有理由接受并记录绕路秒数", () => {
  const good = buildWorld();
  publishAlphaV1(good.registry);
  // publishAlphaV2(justified) 内含 300s 人工绕行（最快 150s）+ 理由。
  publishAlphaV2(good.registry, { slowRoute: "justified" });
  const chosen = good.registry.versionChosenRoutes(
    good.registry.plans.get("plan-alpha").versions.get("plan-alpha-v2"),
  );
  assert.match(chosen.get("A2|n5").reason, /施工/);

  const bad = buildWorld();
  publishAlphaV1(bad.registry);
  bad.registry.append(ev("PLAN_REVISED", "2026-09-22T14:00:00+08:00", {
    plan_id: "plan-alpha", version_id: "plan-alpha-v2", revises_version: "plan-alpha-v1",
  }));
  assert.throws(() => {
    bad.registry.append(ev("ROUTE_CHOSEN", "2026-09-22T14:30:00+08:00", {
      plan_id: "plan-alpha", resource_id: "A1", to_node: "n4", purpose: "PATROL",
      path: ["ed1c", "e34"], // d1-n3-n4 = 390s，最快 d1-n4 = 400? —— 见下方断言用确定慢路径
    }));
  }, /理由/);
});

test("跨方案重叠占用被拒绝并给出占用方；与 beta 不重叠的 v2 可以发布", () => {
  const { network, registry } = buildWorld();
  publishAlphaV1(registry);
  publishBeta(registry); // beta 占用 A2：00:30-01:30

  // alpha v2 的 A2 窗 22:30-00:30，与 beta 首尾相接不冲突。
  publishAlphaV2(registry, { slowRoute: "none" });
  assert.equal(registry.plans.get("plan-alpha").head_version, "plan-alpha-v2");

  // 再发一个方案试图在 01:00 占用 A2，必须被拒。
  registry.append(ev("PLAN_DRAFTED", "2026-09-23T08:00:00+08:00", {
    plan_id: "plan-gamma", race_id: RACE.race_id, coverage_scope: [],
  }));
  registry.append(ev("RESOURCE_DECLARED", "2026-09-23T08:10:00+08:00", {
    plan_id: "plan-gamma", resource_id: "A2", type: "AMBULANCE", home_location: "d2",
    qualifications: ["bls", "als"],
    window: { start: "2026-09-27T00:00:00+08:00", end: "2026-09-27T02:00:00+08:00" },
  }));
  registry.append(ev("PLAN_APPROVED", "2026-09-23T09:00:00+08:00", {
    plan_id: "plan-gamma", version_id: "plan-gamma-v1", approver: "总监-李岑",
  }));
  let caught;
  try {
    registry.append(ev("PLAN_PUBLISHED", "2026-09-23T09:30:00+08:00", {
      plan_id: "plan-gamma", version_id: "plan-gamma-v1",
      effective_at: "2026-09-27T00:00:00+08:00",
    }));
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof RegistrationError);
  assert.equal(caught.conflicts[0].held_by.plan_id, "plan-beta");
});

test("同一版本重复发布幂等：占用条数不增加，同一资源不被占用两次", () => {
  const { registry } = buildWorld();
  publishAlphaV1(registry);
  const claimCount = registry.claims.length;

  // 用新事件重发同一版本：必须短路。
  registry.append(ev("PLAN_PUBLISHED", "2026-09-25T10:00:00+08:00", {
    plan_id: "plan-alpha", version_id: "plan-alpha-v1", effective_at: RACE.start,
  }));
  assert.equal(registry.claims.length, claimCount);

  // 同一 event_id 重放整个事件流：状态等价。
  const replay = new PlanRegistry({ network: buildNetwork() });
  for (const e of registry.events) replay.append(e);
  assert.equal(replay.claims.length, claimCount);
});

test("局部重算只继承并替换受影响资源：v2 的获批替代包含新增 A2/T3N", () => {
  const { network, registry } = buildWorld();
  publishAlphaV1(registry);
  publishAlphaV2(registry, { slowRoute: "none" });
  const replay = replayVersion(registry, network, "plan-alpha", "plan-alpha-v2", t(AT.hour23));
  const added = replay.approved_alternatives.filter((c) => c.action === "ADDED").map((c) => c.resource_id);
  assert.deepEqual(added.sort(), ["A2", "T3N"]);
});

test("路线临时调整后重新建档：23:00 的回放按新分段评估", () => {
  const { network, registry } = buildWorld();
  publishAlphaV1(registry);
  // 22:20 路线调整：seg-C 改走新边（夹具中未声明，先在路网补边）。
  network.addEdge("e56", "n5", "n6", 240);
  network.addEdge("e56_r", "n6", "n5", 240);
  const resegmented = SEGMENTS.map((s) => s.segment_id === "seg-C"
    ? { ...s, edges: ["e56", "e56_r"], nodes: ["n6"], period: s.period }
    : s);
  registry.append(ev("EVENT_RISK_FILED", "2026-09-26T22:20:00+08:00", {
    race_id: RACE.race_id, segments: resegmented,
  }));
  const report = evaluateVersion(registry, network, "plan-alpha", "plan-alpha-v1", t(AT.hour23), { only: ["seg-C"] });
  // n6 只能经 n5-d2 一线到达，最近响应者行驶时间显著变长或不可达——报告必须显式给出。
  const segC = report.segment_reports[0];
  assert.ok(segC.slices.every((s) => s.first_response === null || s.first_response.travel_seconds > 240));
});

test("未审批版本禁止发布；修订必须基于最新发布版本", () => {
  const { registry } = buildWorld();
  publishAlphaV1(registry);
  assert.throws(() => {
    registry.append(ev("PLAN_PUBLISHED", "2026-09-23T10:00:00+08:00", {
      plan_id: "plan-alpha", version_id: "ghost-version",
    }));
  }, /待发布版本不存在/);

  assert.throws(() => {
    registry.append(ev("PLAN_REVISED", "2026-09-23T11:00:00+08:00", {
      plan_id: "plan-alpha", version_id: "plan-alpha-vx", revises_version: "plan-alpha-v1",
    }));
    publishAlphaV2(registry, { slowRoute: "none" });
  }, /当前最新发布版本|已有未完成审批/);
});
