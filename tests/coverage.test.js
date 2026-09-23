import assert from "node:assert/strict";
import test from "node:test";
import { computeCoverage, route, shortestMinutes } from "../src/coverage.js";
import { AT, demoWorld } from "./fixtures.js";

test("各要素共同参与计算：风险/密度/资质/开放窗/医院能力/行驶时间", () => {
  const coverage = computeCoverage(demoWorld(), AT);
  assert.equal(coverage.segments.length, 3);
  const byId = Object.fromEntries(coverage.segments.map((s) => [s.segment_id, s]));

  // 高风险高密度分段：需要 2 个 ALS 单元、5 分钟目标，由 V1/V3/V4 满足并说明原因
  assert.equal(byId.S1.required.units, 2);
  assert.equal(byId.S1.required.capability, "ALS");
  assert.equal(byId.S1.required.target_minutes, 5);
  assert.deepEqual(byId.S1.providers.map((p) => p.id), ["V1", "V3", "V4"]);
  assert.equal(byId.S1.covered, true);
  assert.match(byId.S1.summary, /5分钟目标内覆盖2个单元/);
  assert.equal(byId.S1.hospital.id, "H1");

  // 中风险分段由急救点开放窗内的 AP1 覆盖
  assert.equal(byId.S2.covered, true);
  assert.ok(byId.S2.providers.some((p) => p.id === "AP1" && p.kind === "aid_point"));

  // 低风险分段目标放宽到 20 分钟
  assert.equal(byId.S3.covered, true);
  assert.equal(byId.S3.required.target_minutes, 20);
});

test("人员资质过期使车辆不再计入覆盖", () => {
  const world = demoWorld();
  world.staff.find((s) => s.id === "P1").qualifications[0].expires_at = "2026-09-23T09:00:00+08:00";
  const coverage = computeCoverage(world, AT);
  const s1 = coverage.segments.find((s) => s.segment_id === "S1");
  assert.deepEqual(s1.providers.map((p) => p.id), ["V3", "V4"]);
});

test("医院接收能力耗尽导致分段不满足目标", () => {
  const world = demoWorld();
  world.hospitals[0].capacity_windows[0].slots = 0;
  const coverage = computeCoverage(world, AT);
  const s1 = coverage.segments.find((s) => s.segment_id === "S1");
  assert.equal(s1.covered, false);
  assert.ok(s1.reasons.includes("HOSPITAL_UNREACHABLE_OR_FULL"));
});

test("急救点开放窗之外不计入覆盖", () => {
  const world = demoWorld();
  world.aid_points[0].open_windows = [{ start: "2026-09-23T08:00:00+08:00", end: "2026-09-23T09:00:00+08:00" }];
  const coverage = computeCoverage(world, AT);
  const s2 = coverage.segments.find((s) => s.segment_id === "S2");
  assert.ok(!s2.providers.some((p) => p.id === "AP1"));
  assert.equal(s2.covered, true); // 仍有 V2 等车辆覆盖
});

test("最短路：封路后绕行，完全切断后不可达", () => {
  const world = demoWorld();
  assert.equal(shortestMinutes(world, "BASE", "N1"), 3);
  const close = (a, b) => {
    world.travel = world.travel.filter(
      (e) => !((e.from === a && e.to === b) || (e.from === b && e.to === a)),
    );
  };
  close("BASE", "N1");
  assert.equal(shortestMinutes(world, "BASE", "N1"), 11); // 绕行 BASE→N2→N1
  for (const node of ["A1", "N2", "H1"]) close(node, "N1");
  assert.equal(shortestMinutes(world, "BASE", "N1"), Infinity); // 被切断
  assert.deepEqual(route(world, "BASE", "N1").path, null);
});
