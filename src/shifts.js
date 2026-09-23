// 班次与资质校验：班次跨日、或资质在值守中途到期时，
// 找出会因此无人负责的路线段与具体时段，避免纸面排班留下空档。

import { subtractWindow, toMs, unionWindows } from "./time.js";

// 跨日班次归一化：结束时刻不晚于开始时刻时视为次日结束。
// date 形如 "2026-09-23"，startLocal/endLocal 形如 "22:00"，offset 形如 "+08:00"。
export function normalizeShiftWindow(date, startLocal, endLocal, offset) {
  const start = `${date}T${startLocal}:00${offset}`;
  const endDate = endLocal > startLocal ? date : addDays(date, 1);
  return { start, end: `${endDate}T${endLocal}:00${offset}` };
}

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// 班次中“资质有效”的部分：与所需资质的有效期求交。
// 资质在值守中途到期时，只返回到期前的部分；无所需资质时返回 null。
// 边界保留输入的原始字符串。
export function qualifiedPortion(shiftWindow, qualifications, requiredKind) {
  const matching = (qualifications ?? []).filter((q) => q.kind === requiredKind);
  if (matching.length === 0) return null;
  const latest = matching.reduce((a, b) => (toMs(a.expires_at) >= toMs(b.expires_at) ? a : b));
  if (toMs(latest.expires_at) <= toMs(shiftWindow.start)) return null;
  const end = toMs(latest.expires_at) < toMs(shiftWindow.end) ? latest.expires_at : shiftWindow.end;
  return { start: shiftWindow.start, end };
}

// 排班校验。
// shifts:       [{ shift_id, staff_id, segment_id, window }]
// staffById:    { staff_id: { qualifications: [{ kind, expires_at }] } }
// requirements: [{ segment_id, window, qualification }]
// 返回 { ok, gaps, warnings }：gaps 为无人合格负责的时段，warnings 标注中途到期的班次。
export function validateRoster(shifts, staffById, requirements) {
  const gaps = [];
  const warnings = [];

  for (const shift of shifts) {
    const quals = staffById[shift.staff_id]?.qualifications ?? [];
    for (const q of quals) {
      const expMs = toMs(q.expires_at);
      if (toMs(shift.window.start) < expMs && expMs < toMs(shift.window.end)) {
        warnings.push({
          shift_id: shift.shift_id,
          staff_id: shift.staff_id,
          problem: "QUALIFICATION_EXPIRES_MID_SHIFT",
          qualification: q.kind,
          expires_at: q.expires_at,
        });
      }
    }
  }

  for (const req of requirements) {
    const portions = shifts
      .filter((s) => s.segment_id === req.segment_id)
      .map((s) => qualifiedPortion(s.window, staffById[s.staff_id]?.qualifications, req.qualification))
      .filter(Boolean);
    const covered = unionWindows(portions);
    for (const missing of subtractWindow(req.window, covered)) {
      gaps.push({ segment_id: req.segment_id, window: missing, reason: "NO_QUALIFIED_COVER" });
    }
  }

  return { ok: gaps.length === 0, gaps, warnings };
}
