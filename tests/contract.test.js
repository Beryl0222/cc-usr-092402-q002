import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { validateEvent } from "../src/race_medical_dispatch.js";

const readJson = async (url) => JSON.parse(await readFile(url, "utf8"));

test("样例符合领域约定", async () => {
  const record = await readJson(new URL("../data/sample.json", import.meta.url));
  assert.deepEqual(validateEvent(record), []);
});

test("全部脱敏样例事件符合领域约定", async () => {
  const dir = new URL("../data/samples/", import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  assert.ok(files.length > 0);
  for (const file of files) {
    const record = await readJson(new URL(file, dir));
    assert.deepEqual(validateEvent(record), [], `${file} 应符合约定`);
  }
});

test("未知事件种类被拒绝", () => {
  const problems = validateEvent({
    event_id: "x",
    kind: "NOT_A_KIND",
    occurred_at: "2026-09-23T10:00:00+08:00",
    subject_id: "s",
    payload: {},
  });
  assert.ok(problems.includes("kind"));
});

test("按事件种类校验 payload 最小字段", () => {
  const missingSeq = validateEvent({
    event_id: "x",
    kind: "POSITION_REPORTED",
    occurred_at: "2026-09-23T10:00:00+08:00",
    subject_id: "V1",
    payload: { source_id: "gps-V1", unit_id: "V1", position: { lng: 121.4, lat: 31.2 } },
  });
  assert.deepEqual(missingSeq, ["payload.seq"]);

  const ok = validateEvent({
    event_id: "x",
    kind: "PLAN_VERSION_PUBLISHED",
    occurred_at: "2026-09-23T10:00:00+08:00",
    subject_id: "P",
    payload: { plan_id: "P", version: 1 },
  });
  assert.deepEqual(ok, []);
});
