import assert from "node:assert/strict";
import test from "node:test";
import {
  approveVersion,
  createOccupancyLedger,
  createPlanStore,
  draftVersion,
  getVersion,
  publishedVersion,
  publishVersion,
  resourceLoad,
  runDrill,
  validatePathChoices,
} from "../src/plans.js";
import { AT, OPEN, demoAssignments, demoWorld } from "./fixtures.js";

function publishedFixture() {
  const store = createPlanStore();
  const ledger = createOccupancyLedger();
  draftVersion(store, "P", demoAssignments(), { created_at: "2026-09-23T07:00:00+08:00" });
  approveVersion(store, "P", 1);
  const published = publishVersion(store, ledger, "P", 1, { at: "2026-09-23T07:30:00+08:00" });
  assert.equal(published.ok, true);
  return { store, ledger };
}

test("发布流程：草稿→审批→发布，未审批不能发布", () => {
  const store = createPlanStore();
  const ledger = createOccupancyLedger();
  draftVersion(store, "P", demoAssignments());
  assert.equal(publishVersion(store, ledger, "P", 1).problem, "NOT_APPROVED");
  approveVersion(store, "P", 1);
  assert.equal(publishVersion(store, ledger, "P", 1).ok, true);
  assert.equal(publishedVersion(store, "P").version, 1);
});

test("同一资源在重叠时段只能被一个方案占用", () => {
  const { store, ledger } = publishedFixture();
  // 另一个方案在重叠时段申领同一车辆 V1
  draftVersion(store, "Q", [
    { assignment_id: "Q1", resource_id: "V1", resource_kind: "vehicle", segment_id: "S2", window: { start: "2026-09-23T10:00:00+08:00", end: "2026-09-23T12:00:00+08:00" } },
  ]);
  approveVersion(store, "Q", 1);
  const conflict = publishVersion(store, ledger, "Q", 1);
  assert.equal(conflict.problem, "RESOURCE_CONFLICT");
  assert.equal(conflict.conflicts[0].resource_id, "V1");
  assert.equal(resourceLoad(ledger, "V1", OPEN), 1); // 冲突不生效，占用不变
  assert.equal(getVersion(store, "Q", 1).status, "approved"); // 状态未被污染

  // 不重叠的时段可以正常占用
  draftVersion(store, "Q2", [
    { assignment_id: "Q2", resource_id: "V1", resource_kind: "vehicle", segment_id: "S2", window: { start: "2026-09-23T18:00:00+08:00", end: "2026-09-23T20:00:00+08:00" } },
  ]);
  approveVersion(store, "Q2", 1);
  assert.equal(publishVersion(store, ledger, "Q2", 1).ok, true);
});

test("重复发布同一版本幂等：资源不会被占用两次", () => {
  const { store, ledger } = publishedFixture();
  const again = publishVersion(store, ledger, "P", 1);
  assert.equal(again.ok, true);
  assert.equal(again.already_published, true);
  assert.equal(resourceLoad(ledger, "V1", OPEN), 1);
  assert.equal(ledger.claims.filter((c) => c.resource_id === "V1").length, 1);
});

test("新版本发布后旧版本废止并释放占用， stale 版本不能再发布", () => {
  const { store, ledger } = publishedFixture();
  const revised = demoAssignments().filter((a) => a.resource_id !== "V1");
  revised.push({ assignment_id: "A5", resource_id: "V4", resource_kind: "vehicle", segment_id: "S1", window: OPEN });
  draftVersion(store, "P", revised, { based_on: 1 });
  approveVersion(store, "P", 2);
  const result = publishVersion(store, ledger, "P", 2, { at: "2026-09-23T09:00:00+08:00" });
  assert.equal(result.ok, true);
  assert.equal(result.superseded, 1);
  assert.equal(getVersion(store, "P", 1).status, "superseded");
  assert.equal(resourceLoad(ledger, "V1", OPEN), 0); // 旧版本占用已释放
  assert.equal(resourceLoad(ledger, "V4", OPEN), 1);
  assert.equal(publishVersion(store, ledger, "P", 1).problem, "VERSION_SUPERSEDED");
});

test("演练建议不能直接覆盖已发布方案", () => {
  const { store, ledger } = publishedFixture();
  const before = structuredClone(publishedVersion(store, "P"));
  const drill = runDrill(store, demoWorld(), "P", {
    at: AT,
    disruptions: [
      { kind: "equipment_failure", vehicle_id: "V1", capability_lost: "ALS" },
      { kind: "equipment_failure", vehicle_id: "V3", capability_lost: "ALS" },
    ],
  });
  assert.equal(drill.ok, true);
  // 建议指向空闲备勤车 V4，且只落在新的草稿版本上
  assert.deepEqual(drill.suggestions, [
    { type: "ASSIGN_IDLE_RESOURCE", segment_id: "S1", resource_id: "V4", eta_minutes: 3 },
  ]);
  const draft = getVersion(store, "P", drill.draft_version);
  assert.equal(draft.status, "draft");
  assert.equal(draft.based_on, 1);
  // 已发布方案保持原样：版本、状态、指派均未改变
  const published = publishedVersion(store, "P");
  assert.equal(published.version, 1);
  assert.deepEqual(published, before);
  // 演练草稿未经审批不能发布
  assert.equal(publishVersion(store, ledger, "P", draft.version).problem, "NOT_APPROVED");
});

test("人工选择较慢路径必须留下理由", () => {
  const world = demoWorld();
  const version = {
    plan_id: "P",
    version: 1,
    path_choices: [
      { id: "PC1", from: "N1", to: "H1", path: ["N1", "N2", "H1"] }, // 19 分钟，慢于直达 10 分钟
      { id: "PC2", from: "N1", to: "H1", path: ["N1", "H1"] },
      { id: "PC3", from: "N2", to: "H1", path: ["N2", "N1", "H1"], reason: "N2→H1 路段临时管制，绕行" },
    ],
  };
  const problems = validatePathChoices(version, world);
  assert.deepEqual(problems, [
    { path_choice_id: "PC1", problem: "SLOWER_PATH_NEEDS_REASON", chosen_minutes: 19, fastest_minutes: 10 },
  ]);
});
