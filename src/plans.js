// 方案版本与发布流程：草稿 → 审批 → 发布 → 废止。
// 关键不变量：
//   - 演练建议只产生新的草稿版本，不能直接覆盖已发布方案；
//   - 同一资源在重叠时段只能被一个已发布方案占用（占用台账原子申领）；
//   - 重复发布同一版本是幂等操作，资源不会被占用两次；
//   - 人工选择较慢路径时必须留下理由。

import { computeCoverage, pathMinutes, route } from "./coverage.js";
import { applyDisruptions, suggestSubstitutions } from "./disruptions.js";
import { overlaps } from "./time.js";

export const PLAN_STATUSES = Object.freeze(["draft", "approved", "published", "superseded"]);

const keyOf = (planId, version) => `${planId}#${version}`;

export function createPlanStore() {
  return { versions: new Map() };
}

export function getVersion(store, planId, version) {
  return store.versions.get(keyOf(planId, version)) ?? null;
}

export function publishedVersion(store, planId) {
  for (const rec of store.versions.values()) {
    if (rec.plan_id === planId && rec.status === "published") return rec;
  }
  return null;
}

// 新建草稿版本。assignments 深拷贝入库，之后对入参的修改不影响已存版本。
export function draftVersion(store, planId, assignments, opts = {}) {
  let nextVersion = 1;
  for (const rec of store.versions.values()) {
    if (rec.plan_id === planId) nextVersion = Math.max(nextVersion, rec.version + 1);
  }
  const record = {
    plan_id: planId,
    version: nextVersion,
    status: "draft",
    assignments: structuredClone(assignments ?? []),
    path_choices: structuredClone(opts.path_choices ?? []),
    suggestions: structuredClone(opts.suggestions ?? []),
    based_on: opts.based_on ?? null,
    created_at: opts.created_at ?? null,
    approved_at: null,
    published_at: null,
  };
  store.versions.set(keyOf(planId, nextVersion), record);
  return record;
}

export function approveVersion(store, planId, version, at = null) {
  const rec = getVersion(store, planId, version);
  if (!rec) return { ok: false, problem: "VERSION_NOT_FOUND" };
  if (rec.status !== "draft") return { ok: false, problem: "NOT_A_DRAFT" };
  rec.status = "approved";
  rec.approved_at = at;
  return { ok: true };
}

// ---- 资源占用台账 ----

export function createOccupancyLedger() {
  return { claims: [] };
}

const sameClaim = (a, b) =>
  a.resource_id === b.resource_id &&
  a.plan_id === b.plan_id &&
  a.version === b.version &&
  a.window.start === b.window.start &&
  a.window.end === b.window.end;

// 原子申领：全部可占才写入，任一冲突则整体不生效。
// 同一 (plan_id, version) 的重复申领按幂等处理，不产生第二条占用记录。
export function claimIntervals(ledger, claims) {
  const fresh = [];
  for (const claim of claims) {
    if (ledger.claims.some((c) => sameClaim(c, claim)) || fresh.some((c) => sameClaim(c, claim))) {
      continue; // 幂等去重
    }
    fresh.push(claim);
  }
  const conflicts = [];
  for (const claim of fresh) {
    for (const held of ledger.claims) {
      if (
        held.resource_id === claim.resource_id &&
        (held.plan_id !== claim.plan_id || held.version !== claim.version) &&
        overlaps(held.window, claim.window)
      ) {
        conflicts.push({ resource_id: claim.resource_id, window: claim.window, held_by: { plan_id: held.plan_id, version: held.version } });
      }
    }
  }
  if (conflicts.length > 0) return { ok: false, conflicts };
  ledger.claims.push(...fresh);
  return { ok: true, claimed: fresh.length };
}

export function releaseClaims(ledger, planId, version) {
  ledger.claims = ledger.claims.filter((c) => !(c.plan_id === planId && c.version === version));
}

// 某资源在指定窗口内被多少个不同方案占用（正常应为 0 或 1）。
export function resourceLoad(ledger, resourceId, window) {
  const plans = new Set(
    ledger.claims
      .filter((c) => c.resource_id === resourceId && overlaps(c.window, window))
      .map((c) => c.plan_id),
  );
  return plans.size;
}

// 发布：仅允许已审批版本；原子地完成“释放旧版本占用 + 申领新版本占用”。
// 重复发布同一版本直接返回成功（already_published），不重复占用资源。
export function publishVersion(store, ledger, planId, version, opts = {}) {
  const rec = getVersion(store, planId, version);
  if (!rec) return { ok: false, problem: "VERSION_NOT_FOUND" };
  if (rec.status === "published") return { ok: true, already_published: true, events: [] };
  if (rec.status === "superseded") return { ok: false, problem: "VERSION_SUPERSEDED" };
  if (rec.status !== "approved") return { ok: false, problem: "NOT_APPROVED" };

  const prev = publishedVersion(store, planId);
  const claims = rec.assignments.map((a) => ({
    resource_id: a.resource_id,
    plan_id: planId,
    version,
    window: a.window,
  }));

  if (prev) releaseClaims(ledger, planId, prev.version);
  const claimed = claimIntervals(ledger, claims);
  if (!claimed.ok) {
    if (prev) claimIntervals(ledger, prev.assignments.map((a) => ({ resource_id: a.resource_id, plan_id: planId, version: prev.version, window: a.window })));
    return { ok: false, problem: "RESOURCE_CONFLICT", conflicts: claimed.conflicts };
  }

  const events = [];
  if (prev) {
    prev.status = "superseded";
    events.push({
      kind: "PLAN_VERSION_SUPERSEDED",
      occurred_at: opts.at ?? null,
      subject_id: planId,
      payload: { plan_id: planId, version: prev.version, superseded_by: version },
    });
  }
  rec.status = "published";
  rec.published_at = opts.at ?? null;
  events.push({
    kind: "PLAN_VERSION_PUBLISHED",
    occurred_at: opts.at ?? null,
    subject_id: planId,
    payload: { plan_id: planId, version },
  });
  return { ok: true, superseded: prev?.version ?? null, events };
}

// 覆盖演练：在受扰动的世界副本上评估当前已发布方案，
// 产出建议并保存为一个新的草稿版本；已发布方案保持原样。
export function runDrill(store, world, planId, opts = {}) {
  const published = publishedVersion(store, planId);
  if (!published) return { ok: false, problem: "NO_PUBLISHED_VERSION" };
  const disturbed = applyDisruptions(world, opts.disruptions ?? [], opts.at);
  const coverage = computeCoverage(disturbed, opts.at, opts.policy);
  const suggestions = suggestSubstitutions(disturbed, coverage, published.assignments, opts.policy);
  const draft = draftVersion(store, planId, published.assignments, {
    based_on: published.version,
    suggestions,
    created_at: opts.at ?? null,
  });
  return { ok: true, draft_version: draft.version, coverage, suggestions };
}

// 人工路径校验：所选路径慢于当前最快路径时，必须填写非空理由。
export function validatePathChoices(planVersion, world) {
  const problems = [];
  for (const choice of planVersion.path_choices ?? []) {
    const fastest = route(world, choice.from, choice.to);
    const chosenMinutes = choice.minutes ?? (choice.path ? pathMinutes(world, choice.path) : fastest.minutes);
    const reasonMissing = !(typeof choice.reason === "string" && choice.reason.trim().length > 0);
    if (chosenMinutes > fastest.minutes && reasonMissing) {
      problems.push({
        path_choice_id: choice.id ?? null,
        problem: "SLOWER_PATH_NEEDS_REASON",
        chosen_minutes: chosenMinutes,
        fastest_minutes: fastest.minutes,
      });
    }
  }
  return problems;
}
