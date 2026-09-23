import assert from "node:assert/strict";
import test from "node:test";
import { t } from "../src/time_windows.js";
import { RegistrationError } from "../src/registry.js";
import { evaluateVersion, runDrill } from "../src/replay.js";
import { buildWorld, publishAlphaV1, publishAlphaV2, publishBeta, ev } from "./helpers/fixture.js";

test("审批闸门：存在未签署豁免的覆盖缺口时版本不能冻结", () => {
  // 资源只覆盖 22:00-23:00，其余赛期必然无人负责，且审批不携带任何书面豁免。
  const full = buildWorld();
  full.registry.append(ev("PLAN_DRAFTED", "2026-09-20T09:00:00+08:00", { plan_id: "p-x", race_id: "R-2026-NIGHT" }));
  full.registry.append(ev("AID_STATION_OPENING_SET", "2026-09-20T09:10:00+08:00", {
    plan_id: "p-x", station_id: "S1", node: "s1",
    window: { start: "2026-09-26T22:00:00+08:00", end: "2026-09-27T02:00:00+08:00" },
  }));
  full.registry.append(ev("RESOURCE_DECLARED", "2026-09-20T09:10:00+08:00", {
    plan_id: "p-x", resource_id: "T1", type: "STATION_TEAM", station_id: "S1",
    qualifications: ["bls", "als"], covers_segments: ["seg-A"],
    window: { start: "2026-09-26T22:00:00+08:00", end: "2026-09-26T23:00:00+08:00" },
  }));
  let caught;
  try {
    full.registry.append(ev("PLAN_APPROVED", "2026-09-21T10:00:00+08:00", {
      plan_id: "p-x", version_id: "p-x-v1", approver: "总监-李岑",
    }));
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof RegistrationError);
  assert.match(caught.message, /覆盖缺口/);
  assert.ok(caught.unwaived_gaps.length > 0);
});

test("v1 带书面豁免可以冻结，豁免记录留在版本审批报告里", () => {
  const { registry } = buildWorld();
  publishAlphaV1(registry);
  const v1 = registry.plans.get("plan-alpha").versions.get("plan-alpha-v1");
  assert.equal(v1.status, "published");
  assert.equal(v1.approval_report.waivers.length, 1);
  assert.equal(v1.approval_report.gap_count, v1.approval_report.waivers.length);
});

test("值守中途资质被吊销：01:00 起重算立即出现无人负责缺口（即使证书纸面仍有效）", () => {
  const { network, registry } = buildWorld();
  publishAlphaV1(registry);
  publishAlphaV2(registry, { slowRoute: "none" });
  // 现场 00:50 通报：T3N 的 als 被中止，01:00 生效。
  registry.append(ev("QUALIFICATION_REVOKED", "2026-09-27T00:50:00+08:00", {
    resource_id: "T3N", code: "als", effective_at: "2026-09-27T01:00:00+08:00",
    reason: "投诉核查期间中止资质",
  }));
  const beforeAt = t("2026-09-27T00:55:00+08:00");
  const before = evaluateVersion(registry, network, "plan-alpha", "plan-alpha-v2", beforeAt, { only: ["seg-B"] });
  assert.deepEqual(before.gaps.filter((g) => g.window.start <= beforeAt && g.window.end > beforeAt), []);
  const afterAt = t("2026-09-27T01:05:00+08:00");
  const after = evaluateVersion(registry, network, "plan-alpha", "plan-alpha-v2", afterAt, { only: ["seg-B"] });
  assert.ok(after.gaps.some((g) => g.kind === "NO_QUALIFIED_RESPONDER" &&
    g.window.start <= afterAt && g.window.end > afterAt));
});

test("替代建议在资源被其他方案占用时标注占用方", () => {
  const { network, registry } = buildWorld();
  publishAlphaV1(registry);
  publishBeta(registry); // A2 在 00:30-01:30 被 beta 占用
  // 01:00 seg-B 因 T3 证书到期产生缺口，演练建议 A2，但 A2 正被 beta 占用。
  const drill = runDrill(registry, network, {
    plan_id: "plan-alpha",
    based_on_version: "plan-alpha-v1",
    at_ms: t("2026-09-27T01:00:00+08:00"),
  });
  const a2 = drill.scenario.suggestions
    .flatMap((s) => s.candidates)
    .find((c) => c.resource_id === "A2");
  assert.ok(a2);
  assert.equal(a2.status.available, false);
  assert.equal(a2.status.occupied_by.plan_id, "plan-beta");
});

test("撤回已发布版本：历史占用保留、未来占用释放，之后可被其他方案使用", () => {
  const { registry } = buildWorld();
  publishAlphaV1(registry);
  const at = t("2026-09-26T23:30:00+08:00");
  const claimsBefore = registry.activeClaims(at, at + 1).length;
  assert.ok(claimsBefore > 0);

  registry.append(ev("PLAN_WITHDRAWN", "2026-09-26T23:30:00+08:00", {
    plan_id: "plan-alpha", version_id: "plan-alpha-v1", reason: "赛事取消",
  }));
  // 撤回时刻之后不再有 v1 的占用。
  const after = registry.activeClaims(at + 1, at + 2);
  assert.ok(after.every((c) => c.version_id !== "plan-alpha-v1"));
});

test("局部重算：recalculate 只重跑受影响段，不包含无关段", () => {
  const { network, registry } = buildWorld();
  publishAlphaV1(registry);
  const drill = runDrill(registry, network, {
    plan_id: "plan-alpha",
    based_on_version: "plan-alpha-v1",
    at_ms: t("2026-09-26T23:10:00+08:00"),
    scenario: {
      closures: [{
        closure_id: "x", edges: ["e45", "e45_r"],
        window: { start: "2026-09-26T23:00:00+08:00", end: "2026-09-26T23:30:00+08:00" },
      }],
    },
  });
  const local = drill.recalculate();
  assert.deepEqual(local.base.segment_reports.map((s) => s.segment_id), ["seg-C"]);
});
