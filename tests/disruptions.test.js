import assert from "node:assert/strict";
import test from "node:test";
import { applyDisruptions, partialRecompute, suggestSubstitutions } from "../src/disruptions.js";
import { computeCoverage } from "../src/coverage.js";
import { AT, demoAssignments, demoWorld } from "./fixtures.js";

test("道路封闭后局部重算：只有受影响分段被重新评估", () => {
  const world = demoWorld();
  const result = partialRecompute(world, [{ kind: "road_closure", from: "BASE", to: "N1" }], AT);
  // BASE→N1 封闭后 V1/V3/V4 需绕行 11 分钟，超出高风险 5 分钟目标
  assert.deepEqual(result.affected_segment_ids, ["S1"]);
  const s1 = result.segments[0];
  assert.equal(s1.covered, false);
  assert.ok(s1.reasons.includes("RESPONSE_TARGET_UNMET"));
  // 其余分段不在重算结果中
  assert.ok(!result.segments.some((s) => s.segment_id === "S2"));
});

test("完全切断时分段报告 ROUTE_CUT", () => {
  const world = demoWorld();
  const result = partialRecompute(
    world,
    [
      { kind: "road_closure", from: "BASE", to: "N1" },
      { kind: "road_closure", from: "A1", to: "N1" },
      { kind: "road_closure", from: "N2", to: "N1" },
      { kind: "road_closure", from: "H1", to: "N1" },
    ],
    AT,
  );
  const s1 = result.segments.find((s) => s.segment_id === "S1");
  assert.ok(s1.reasons.includes("ROUTE_CUT"));
  assert.ok(s1.reasons.includes("HOSPITAL_UNREACHABLE_OR_FULL"));
});

test("突发高温提升风险等级并改变响应目标", () => {
  const world = demoWorld();
  const result = partialRecompute(
    world,
    [{ kind: "heat_wave", segment_ids: ["S2"], raise_to: "high" }],
    AT,
  );
  assert.deepEqual(result.affected_segment_ids, ["S2"]);
  const s2 = result.segments[0];
  assert.equal(s2.risk_level, "high");
  assert.equal(s2.required.capability, "ALS");
  assert.equal(s2.required.target_minutes, 5);
  assert.equal(s2.covered, false); // ALS 车辆 6 分钟才能到，超出 5 分钟目标
});

test("设备失效削弱车辆能力并给出替代建议", () => {
  const world = demoWorld();
  const disturbed = applyDisruptions(
    world,
    [
      { kind: "equipment_failure", vehicle_id: "V1", capability_lost: "ALS" },
      { kind: "equipment_failure", vehicle_id: "V3", capability_lost: "ALS" },
    ],
    AT,
  );
  const coverage = computeCoverage(disturbed, AT);
  const s1 = coverage.segments.find((s) => s.segment_id === "S1");
  assert.equal(s1.covered, false);
  assert.ok(s1.reasons.includes("UNITS_SHORT"));
  // 已发布方案占用 V1/V2/V3/AP1，空闲的 V4 成为替代建议
  const suggestions = suggestSubstitutions(disturbed, coverage, demoAssignments());
  assert.deepEqual(suggestions, [
    { type: "ASSIGN_IDLE_RESOURCE", segment_id: "S1", resource_id: "V4", eta_minutes: 3 },
  ]);
});

test("无可用替代资源时请求外部增援", () => {
  const world = demoWorld();
  const disturbed = applyDisruptions(
    world,
    [{ kind: "heat_wave", segment_ids: ["S2"], raise_to: "high" }],
    AT,
  );
  const coverage = computeCoverage(disturbed, AT);
  const suggestions = suggestSubstitutions(disturbed, coverage, demoAssignments());
  // 空闲 V4 距 S2 需 6 分钟，超出 5 分钟目标，只能请求外部增援
  assert.deepEqual(suggestions, [
    { type: "REQUEST_EXTERNAL_SUBSTITUTION", segment_id: "S2", capability: "ALS", units: 1 },
  ]);
});

test("扰动只作用于世界副本，原世界不变", () => {
  const world = demoWorld();
  const before = structuredClone(world);
  applyDisruptions(world, [{ kind: "road_closure", from: "BASE", to: "N1" }], AT);
  assert.deepEqual(world, before);
});
