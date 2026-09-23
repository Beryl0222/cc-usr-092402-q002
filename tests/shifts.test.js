import assert from "node:assert/strict";
import test from "node:test";
import { normalizeShiftWindow, qualifiedPortion, validateRoster } from "../src/shifts.js";

const staff = {
  P1: { qualifications: [{ kind: "ALS", expires_at: "2026-09-24T02:00:00+08:00" }] },
  P5: { qualifications: [{ kind: "ALS", expires_at: "2027-01-01T00:00:00+08:00" }] },
  P6: { qualifications: [{ kind: "ALS", expires_at: "2027-01-01T00:00:00+08:00" }] },
};

test("跨日班次归一化到次日结束", () => {
  assert.deepEqual(normalizeShiftWindow("2026-09-23", "22:00", "06:00", "+08:00"), {
    start: "2026-09-23T22:00:00+08:00",
    end: "2026-09-24T06:00:00+08:00",
  });
  assert.deepEqual(normalizeShiftWindow("2026-09-23", "08:00", "18:00", "+08:00"), {
    start: "2026-09-23T08:00:00+08:00",
    end: "2026-09-23T18:00:00+08:00",
  });
});

test("资质在值守中途到期时，到期后时段不再计入可负责部分", () => {
  const shift = normalizeShiftWindow("2026-09-23", "22:00", "06:00", "+08:00");
  const portion = qualifiedPortion(shift, staff.P1.qualifications, "ALS");
  assert.equal(portion.start, "2026-09-23T22:00:00+08:00");
  assert.equal(portion.end, "2026-09-24T02:00:00+08:00"); // 截断到资质到期时刻
});

test("跨日排班叠加资质中途到期：无人负责的路线段被找出", () => {
  const requirement = {
    segment_id: "S1",
    window: { start: "2026-09-23T20:00:00+08:00", end: "2026-09-24T08:00:00+08:00" },
    qualification: "ALS",
  };
  const shifts = [
    { shift_id: "SH1", staff_id: "P1", segment_id: "S1", window: normalizeShiftWindow("2026-09-23", "22:00", "06:00", "+08:00") },
  ];
  const result = validateRoster(shifts, staff, [requirement]);
  assert.equal(result.ok, false);
  // 20:00–22:00 无人值守；02:00 资质到期后到次日 08:00 无人合格负责
  assert.deepEqual(
    result.gaps.map((g) => [g.window.start, g.window.end]),
    [
      ["2026-09-23T20:00:00+08:00", "2026-09-23T22:00:00+08:00"],
      ["2026-09-24T02:00:00+08:00", "2026-09-24T08:00:00+08:00"],
    ],
  );
  assert.deepEqual(result.warnings, [
    {
      shift_id: "SH1",
      staff_id: "P1",
      problem: "QUALIFICATION_EXPIRES_MID_SHIFT",
      qualification: "ALS",
      expires_at: "2026-09-24T02:00:00+08:00",
    },
  ]);
});

test("交接链完整时不留空档，但中途到期仍给出预警", () => {
  const requirement = {
    segment_id: "S1",
    window: { start: "2026-09-23T20:00:00+08:00", end: "2026-09-24T08:00:00+08:00" },
    qualification: "ALS",
  };
  const shifts = [
    { shift_id: "SH_A", staff_id: "P5", segment_id: "S1", window: { start: "2026-09-23T20:00:00+08:00", end: "2026-09-23T22:00:00+08:00" } },
    { shift_id: "SH1", staff_id: "P1", segment_id: "S1", window: normalizeShiftWindow("2026-09-23", "22:00", "06:00", "+08:00") },
    { shift_id: "SH_B", staff_id: "P6", segment_id: "S1", window: { start: "2026-09-24T02:00:00+08:00", end: "2026-09-24T08:00:00+08:00" } },
  ];
  const result = validateRoster(shifts, staff, [requirement]);
  assert.equal(result.ok, true);
  assert.equal(result.gaps.length, 0);
  assert.equal(result.warnings.length, 1); // SH1 的资质在 02:00 到期，交接给 SH_B
});
