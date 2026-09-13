import { mirrorChannelName } from "./mirror-name.js";

export function normalizeChannelName(value = "") {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function buildExpansionPlan({ channels, mappedIds = [], deniedNames = [], prefix = "", cohortSize = 25, activityDays = 180, inaccessible = [] }) {
  if (!Number.isInteger(cohortSize) || cohortSize < 1 || cohortSize > 100) throw new Error("cohortSize must be between 1 and 100");
  if (!Number.isInteger(activityDays) || activityDays < 90 || activityDays > 180) throw new Error("activityDays must be between 90 and 180");
  const denied = new Set(deniedNames.map(normalizeChannelName));
  const mapped = new Set(mappedIds);
  const candidates = [];
  const excluded = [];
  for (const channel of channels) {
    const normalizedName = normalizeChannelName(channel.name);
    let reason;
    if (!channel.id || !/^[CG][A-Z0-9]+$/.test(channel.id)) reason = "invalid-id";
    else if (channel.is_im || channel.is_mpim) reason = "denied-type";
    else if (channel.is_archived) reason = "archived";
    else if (denied.has(normalizedName)) reason = "denied-name";
    if (reason) excluded.push({ id: channel.id ?? null, name: channel.name ?? "", reason });
    else candidates.push({ id: channel.id, name: channel.name, alreadyMapped: mapped.has(channel.id), mirrorName: mirrorChannelName({ prefix, sourceName: channel.name || channel.id, slackChannelId: channel.id }) });
  }
  candidates.sort((a, b) => a.id.localeCompare(b.id));
  const pending = candidates.filter((c) => !c.alreadyMapped);
  const cohorts = [];
  for (let i = 0; i < pending.length; i += cohortSize) cohorts.push(pending.slice(i, i + cohortSize));
  return { version: 2, cohortSize, activityDays, candidates, excluded, inaccessible: [...inaccessible], cohorts };
}

export function classifyCohortActivity({ cohort, measurements, nowEpoch, activityDays }) {
  if (!Number.isInteger(nowEpoch) || nowEpoch < 1) throw new Error("nowEpoch must be a positive integer");
  if (!Number.isInteger(activityDays) || activityDays < 90 || activityDays > 180) throw new Error("activityDays must be between 90 and 180");
  const byId = new Map(measurements.map((item) => [item.id, item]));
  const cutoff = nowEpoch - activityDays * 86400;
  const active = [];
  const quiet = [];
  const inaccessible = [];
  for (const channel of cohort) {
    const measurement = byId.get(channel.id);
    if (!measurement || measurement.accessible === false) {
      inaccessible.push({ ...channel, reason: measurement?.reason || "history-not-measured" });
      continue;
    }
    const timestamp = Number(measurement.lastSubstantiveTs);
    if (Number.isFinite(timestamp) && timestamp >= cutoff) active.push({ ...channel, lastSubstantiveTs: timestamp });
    else quiet.push({ ...channel, lastSubstantiveTs: Number.isFinite(timestamp) ? timestamp : null, reason: "no-recent-substantive-activity" });
  }
  return { cutoff, active, quiet, inaccessible };
}

export async function applyExpansionPlan({ plan, checkpoint = { completedCohorts: [] }, hooks, approveNext }) {
  const completed = new Set(checkpoint.completedCohorts ?? []);
  checkpoint.quiet ??= [];
  checkpoint.inaccessible ??= [];
  if (!checkpoint.backup) checkpoint.backup = await hooks.backup();
  for (let index = 0; index < plan.cohorts.length; index += 1) {
    if (completed.has(index)) continue;
    if (!(await approveNext({ index, cohort: plan.cohorts[index], checkpoint }))) return { status: "stopped", checkpoint };
    const measurements = await hooks.joinAndMeasure(plan.cohorts[index]);
    const selection = !Array.isArray(measurements)
      ? { active: plan.cohorts[index], quiet: [], inaccessible: [] }
      : classifyCohortActivity({ cohort: plan.cohorts[index], measurements, nowEpoch: hooks.nowEpoch(), activityDays: plan.activityDays });
    checkpoint.quiet.push(...selection.quiet);
    checkpoint.inaccessible.push(...selection.inaccessible);
    if (selection.active.length > 0) {
      await hooks.reconcile(selection.active);
      await hooks.backfill(selection.active);
      await hooks.verify(selection.active);
    }
    checkpoint.completedCohorts = [...completed, index].sort((a, b) => a - b);
    completed.add(index);
    await hooks.saveCheckpoint(checkpoint);
  }
  return { status: "complete", checkpoint };
}
