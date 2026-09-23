// 共享夹具：虚构的赛事医疗世界模型与已发布方案，仅用于测试。

export const OPEN = { start: "2026-09-23T08:00:00+08:00", end: "2026-09-23T18:00:00+08:00" };
export const AT = "2026-09-23T10:00:00+08:00";

const both = (a, b, minutes) => [
  { from: a, to: b, minutes },
  { from: b, to: a, minutes },
];

// 路网：BASE 为车辆驻点，A1 为急救点，N1/N2/N3 为分段节点，H1 为接收医院。
export function demoWorld() {
  return {
    travel: [
      ...both("BASE", "N1", 3),
      ...both("BASE", "N2", 6),
      ...both("BASE", "N3", 12),
      ...both("A1", "N1", 4),
      ...both("A1", "N2", 2),
      ...both("A1", "N3", 9),
      ...both("N1", "N2", 5),
      ...both("N2", "N3", 5),
      ...both("N1", "H1", 10),
      ...both("N2", "H1", 14),
      ...both("N3", "H1", 25),
      ...both("A1", "H1", 12),
      ...both("BASE", "H1", 15),
    ],
    segments: [
      { id: "S1", node: "N1", open_window: OPEN, risk_level: "high", crowd: [{ ...OPEN, density: 1.5 }] },
      { id: "S2", node: "N2", open_window: OPEN, risk_level: "medium", crowd: [{ ...OPEN, density: 0.5 }] },
      { id: "S3", node: "N3", open_window: OPEN, risk_level: "low", crowd: [{ ...OPEN, density: 0.2 }] },
    ],
    aid_points: [{ id: "AP1", node: "A1", capabilities: ["BLS"], open_windows: [OPEN] }],
    vehicles: [
      { id: "V1", node: "BASE", capabilities: ["ALS"], available_windows: [OPEN], crew: ["P1"] },
      { id: "V2", node: "BASE", capabilities: ["BLS"], available_windows: [OPEN], crew: ["P2"] },
      { id: "V3", node: "BASE", capabilities: ["ALS"], available_windows: [OPEN], crew: ["P3"] },
      { id: "V4", node: "BASE", capabilities: ["ALS"], available_windows: [OPEN], crew: ["P4"] },
    ],
    staff: [
      { id: "P1", qualifications: [{ kind: "ALS", expires_at: "2026-09-24T00:00:00+08:00" }] },
      { id: "P2", qualifications: [{ kind: "BLS", expires_at: "2027-01-01T00:00:00+08:00" }] },
      { id: "P3", qualifications: [{ kind: "ALS", expires_at: "2027-01-01T00:00:00+08:00" }] },
      { id: "P4", qualifications: [{ kind: "ALS", expires_at: "2027-01-01T00:00:00+08:00" }] },
    ],
    hospitals: [{ id: "H1", node: "H1", capabilities: ["ALS"], capacity_windows: [{ ...OPEN, slots: 2 }] }],
  };
}

// 已发布方案的指派：V1/V3 覆盖 S1，AP1 值守 S2，V2 覆盖 S3；V4 留作空闲备勤。
export function demoAssignments() {
  return [
    { assignment_id: "A1", resource_id: "V1", resource_kind: "vehicle", segment_id: "S1", window: OPEN },
    { assignment_id: "A2", resource_id: "V3", resource_kind: "vehicle", segment_id: "S1", window: OPEN },
    { assignment_id: "A3", resource_id: "V2", resource_kind: "vehicle", segment_id: "S3", window: OPEN },
    { assignment_id: "A4", resource_id: "AP1", resource_kind: "aid_point", segment_id: "S2", window: OPEN },
  ];
}
