import assert from "node:assert/strict";
import test from "node:test";
import { applyExpansionPlan, buildExpansionPlan, classifyCohortActivity } from "../src/expansion-plan.js";

test("plans 501 channels without omission and enforces deny rules", () => {
  const channels = Array.from({ length: 501 }, (_, i) => ({ id: `C${String(i).padStart(4, "0")}`, name: `channel-${i}` }));
  channels[10].name = "Board Meeting";
  channels[11].is_im = true;
  const plan = buildExpansionPlan({ channels, deniedNames: ["board-meeting"], cohortSize: 25, prefix: "mirror-", inaccessible: [{ name: "private-unknown", reason: "not-visible" }] });
  assert.equal(plan.candidates.length, 499);
  assert.equal(plan.excluded.length, 2);
  assert.equal(plan.cohorts.flat().length, 499);
  assert.equal(plan.cohorts.length, 20);
  assert.equal(plan.inaccessible.length, 1);
});

test("stops before a cohort and resumes completed cohorts without duplication", async () => {
  const plan = buildExpansionPlan({ channels: Array.from({ length: 5 }, (_, i) => ({ id: `C${i}`, name: `c-${i}` })), cohortSize: 2 });
  const calls = [];
  const hooks = Object.fromEntries(["joinAndMeasure", "reconcile", "backfill", "verify"].map((name) => [name, async (cohort) => calls.push(`${name}:${cohort[0].id}`)]));
  hooks.backup = async () => "backup-ref";
  hooks.saveCheckpoint = async () => {};
  const first = await applyExpansionPlan({ plan, hooks, approveNext: async ({ index }) => index === 0 });
  assert.equal(first.status, "stopped");
  assert.deepEqual(first.checkpoint.completedCohorts, [0]);
  const second = await applyExpansionPlan({ plan, checkpoint: first.checkpoint, hooks, approveNext: async () => true });
  assert.equal(second.status, "complete");
  assert.equal(calls.filter((c) => c.endsWith(":C0")).length, 4);
});

test("classifies recent, quiet, and inaccessible channels without omission", () => {
  const cohort = [
    { id: "C1", name: "recent" },
    { id: "C2", name: "legacy" },
    { id: "C3", name: "empty" },
    { id: "C4", name: "private" },
  ];
  const result = classifyCohortActivity({
    cohort,
    nowEpoch: 20_000_000,
    activityDays: 180,
    measurements: [
      { id: "C1", accessible: true, lastSubstantiveTs: 19_000_000 },
      { id: "C2", accessible: true, lastSubstantiveTs: 1_000_000 },
      { id: "C3", accessible: true, lastSubstantiveTs: null },
      { id: "C4", accessible: false, reason: "not-visible" },
    ],
  });
  assert.deepEqual(result.active.map((item) => item.id), ["C1"]);
  assert.deepEqual(result.quiet.map((item) => item.id), ["C2", "C3"]);
  assert.deepEqual(result.inaccessible.map((item) => item.id), ["C4"]);
  assert.equal(result.active.length + result.quiet.length + result.inaccessible.length, cohort.length);
});

test("applies only channels active inside the configured window", async () => {
  const plan = buildExpansionPlan({ channels: [{ id: "C1", name: "recent" }, { id: "C2", name: "quiet" }], activityDays: 180 });
  const reconciled = [];
  const hooks = {
    backup: async () => "backup-ref",
    nowEpoch: () => 20_000_000,
    joinAndMeasure: async () => [
      { id: "C1", accessible: true, lastSubstantiveTs: 19_000_000 },
      { id: "C2", accessible: true, lastSubstantiveTs: null },
    ],
    reconcile: async (cohort) => reconciled.push(...cohort.map((item) => item.id)),
    backfill: async () => {},
    verify: async () => {},
    saveCheckpoint: async () => {},
  };
  const result = await applyExpansionPlan({ plan, hooks, approveNext: async () => true });
  assert.deepEqual(reconciled, ["C1"]);
  assert.deepEqual(result.checkpoint.quiet.map((item) => item.id), ["C2"]);
});
