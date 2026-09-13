import { mirrorChannelName } from "./mirror-name.js";

export function normalizeChannelName(value = "") {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function buildExpansionPlan({ channels, mappedIds = [], deniedNames = [], prefix = "", cohortSize = 25, inaccessible = [] }) {
  if (!Number.isInteger(cohortSize) || cohortSize < 1 || cohortSize > 100) throw new Error("cohortSize must be between 1 and 100");
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
  return { version: 1, cohortSize, candidates, excluded, inaccessible: [...inaccessible], cohorts };
}

export async function applyExpansionPlan({ plan, checkpoint = { completedCohorts: [] }, hooks, approveNext }) {
  const completed = new Set(checkpoint.completedCohorts ?? []);
  if (!checkpoint.backup) checkpoint.backup = await hooks.backup();
  for (let index = 0; index < plan.cohorts.length; index += 1) {
    if (completed.has(index)) continue;
    if (!(await approveNext({ index, cohort: plan.cohorts[index], checkpoint }))) return { status: "stopped", checkpoint };
    await hooks.joinAndMeasure(plan.cohorts[index]);
    await hooks.reconcile(plan.cohorts[index]);
    await hooks.backfill(plan.cohorts[index]);
    await hooks.verify(plan.cohorts[index]);
    checkpoint.completedCohorts = [...completed, index].sort((a, b) => a - b);
    completed.add(index);
    await hooks.saveCheckpoint(checkpoint);
  }
  return { status: "complete", checkpoint };
}
