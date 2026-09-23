// 风险与需求模型：路线分段的观众密度、基础风险等级，
// 叠加高温等情景后得到该时段的响应目标与预期负荷。
//
// 响应目标以「秒」表示：从最近的可调度急救点/救护车到段内任一位置的
// 最长行驶时间必须不超过目标值，演练报告会逐片给出是否达标的证据。

export const RISK_LEVELS = Object.freeze(["low", "medium", "high"]);

export const BASE_RESPONSE_SECONDS = Object.freeze({
  low: 480,
  medium: 300,
  high: 180,
});

// 观众密度（人/公里）达到阈值会抬升一档风险；高温同理。
export const DENSITY_ESCALATION_PER_KM = 2000;
export const HEAT_ESCALATION_INDEX = 36; // 体感温度达到该值抬升一档
export const EXTREME_HEAT_INDEX = 41; // 再高时响应目标再收紧 10%

function escalate(level) {
  return RISK_LEVELS[Math.min(RISK_LEVELS.indexOf(level) + 1, RISK_LEVELS.length - 1)];
}

// segments: [{ segment_id, name, edges:[edgeId...], density_per_km, risk, target_seconds? }]
// scenario: { heat_alert?: {heat_index} | null, equipment_failures?: Set<resource_id>, now? }
export function evaluateSegment(segment, scenario = {}) {
  const reasons = [];
  let risk = segment.risk ?? "medium";
  if (!RISK_LEVELS.includes(risk)) throw new Error(`未知风险等级: ${risk}`);

  if ((segment.density_per_km ?? 0) >= DENSITY_ESCALATION_PER_KM) {
    const next = escalate(risk);
    if (next !== risk) reasons.push(`观众密度 ${segment.density_per_km}/km 达到 ${DENSITY_ESCALATION_PER_KM}，风险 ${risk}→${next}`);
    risk = next;
  }

  let target = segment.target_seconds ?? BASE_RESPONSE_SECONDS[risk];
  if (segment.target_seconds) reasons.push(`使用分段自定义响应目标 ${target}s`);
  else reasons.push(`风险等级 ${risk} 的标准响应目标 ${target}s`);

  const heat = scenario.heat_alert;
  if (heat && heat.heat_index >= HEAT_ESCALATION_INDEX) {
    const next = escalate(risk);
    if (next !== risk) {
      reasons.push(`高温体感 ${heat.heat_index}°，风险 ${risk}→${next}`);
      risk = next;
      target = segment.target_seconds ?? BASE_RESPONSE_SECONDS[risk];
    }
    if (heat.heat_index >= EXTREME_HEAT_INDEX) {
      target = Math.round(target * 0.9);
      reasons.push(`极端高温 ${heat.heat_index}°，响应目标收紧至 ${target}s`);
    }
  }

  // 预期每小时需处置人次：密度与风险共同决定，高温增加中暑负荷。
  const riskLoad = { low: 0.5, medium: 1.2, high: 2.5 }[risk];
  let expectedPerHour = (segment.density_per_km ?? 0) / 1000 * riskLoad;
  if (heat && heat.heat_index >= HEAT_ESCALATION_INDEX) {
    expectedPerHour *= 1.5;
    reasons.push("高温下预期负荷 ×1.5");
  }

  return Object.freeze({
    segment_id: segment.segment_id,
    risk,
    target_seconds: target,
    expected_per_hour: Number(expectedPerHour.toFixed(2)),
    reasons: Object.freeze(reasons),
  });
}
