import assert from "node:assert/strict";
import test from "node:test";
import { applyExpansionPlan, buildExpansionPlan } from "../src/expansion-plan.js";

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
