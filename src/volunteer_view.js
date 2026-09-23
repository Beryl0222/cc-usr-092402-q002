// 外部志愿者视图：只投影执行所需信息。
// 视图只包含志愿者本人被指派的岗位、值守窗口、任务清单与联络频道；
// 风险等级、观众密度、医院接收能力、人员资质、伤情等敏感信息一律不下发。

export const VOLUNTEER_ASSIGNMENT_FIELDS = Object.freeze([
  "assignment_id",
  "post",
  "window",
  "tasks",
  "radio_channel",
  "meet_point",
]);

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));

export function volunteerView(planVersion, volunteerId) {
  const mine = (planVersion.assignments ?? []).filter(
    (a) => a.assignee === volunteerId || (a.assignees ?? []).includes(volunteerId),
  );
  return {
    plan_id: planVersion.plan_id,
    version: planVersion.version,
    volunteer_id: volunteerId,
    assignments: mine.map((a) => pick(a, VOLUNTEER_ASSIGNMENT_FIELDS)),
  };
}
