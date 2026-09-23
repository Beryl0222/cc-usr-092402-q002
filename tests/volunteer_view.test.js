import assert from "node:assert/strict";
import test from "node:test";
import { volunteerView } from "../src/volunteer_view.js";

const planVersion = {
  plan_id: "P",
  version: 3,
  assignments: [
    {
      assignment_id: "A9",
      assignee: "VOL1",
      post: "S2 饮水点",
      window: { start: "2026-09-23T08:00:00+08:00", end: "2026-09-23T12:00:00+08:00" },
      tasks: ["引导人流", "发现不适者呼叫急救点"],
      radio_channel: "CH-4",
      meet_point: "N2 北侧旗杆",
      // 以下为内部字段，不应出现在志愿者视图中
      risk_level: "medium",
      hospital_capacity: { H1: 2 },
      casualty_notes: ["C1 疑似中暑"],
      staff_qualifications: ["ALS"],
    },
    {
      assignment_id: "A10",
      assignee: "VOL2",
      post: "S3 终点引导",
      window: { start: "2026-09-23T08:00:00+08:00", end: "2026-09-23T12:00:00+08:00" },
      tasks: ["终点分流"],
      radio_channel: "CH-5",
      meet_point: "N3 拱门",
    },
  ],
};

test("外部志愿者只能看到执行所需信息", () => {
  const view = volunteerView(planVersion, "VOL1");
  assert.equal(view.assignments.length, 1);
  assert.deepEqual(view.assignments[0], {
    assignment_id: "A9",
    post: "S2 饮水点",
    window: { start: "2026-09-23T08:00:00+08:00", end: "2026-09-23T12:00:00+08:00" },
    tasks: ["引导人流", "发现不适者呼叫急救点"],
    radio_channel: "CH-4",
    meet_point: "N2 北侧旗杆",
  });
  // 敏感字段一律不下发
  const leaked = JSON.stringify(view);
  for (const field of ["risk_level", "hospital_capacity", "casualty", "qualification"]) {
    assert.ok(!leaked.includes(field), `视图不应包含 ${field}`);
  }
});

test("志愿者看不到他人的指派", () => {
  const view = volunteerView(planVersion, "VOL1");
  assert.ok(!view.assignments.some((a) => a.assignment_id === "A10"));
  const nobody = volunteerView(planVersion, "VOL9");
  assert.equal(nobody.assignments.length, 0);
});
