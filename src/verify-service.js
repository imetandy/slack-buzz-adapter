import { collectChannelMessages } from "./backfill-service.js";
import { normalizeSlackMessage, sourceKey } from "./format.js";

export async function verifyChannelMirror({
  slackClient,
  buzzClient,
  stateStore,
  mapping,
  oldest,
  buzzLimit = 200,
  repairThreads = false,
}) {
  const collection = await collectChannelMessages({
    slackClient,
    channelId: mapping.slackChannelId,
    oldest,
  });
  const sourceMessages = collection.messages.filter((message) => {
    const normalized = normalizeSlackMessage({
      ...message,
      type: "message",
      channel: mapping.slackChannelId,
    });
    return normalized?.action === "create" && normalized.message?.ts;
  });
  const buzzMessages = await buzzClient.getMessages(
    mapping.buzzChannelId,
    buzzLimit,
  );
  const buzzById = new Map(buzzMessages.map((message) => [message.id, message]));
  const truncated = buzzMessages.length >= buzzLimit;
  const failures = [];
  let receipts = 0;
  let present = 0;
  let threadLinks = 0;
  let repairedThreads = 0;

  for (const message of sourceMessages) {
    const receipt = stateStore.getMessage(
      sourceKey(mapping.slackChannelId, message.ts),
    );
    if (!receipt?.buzzEventId) {
      failures.push(`missing receipt for ${message.ts}`);
      continue;
    }
    receipts += 1;
    const mirrored = buzzById.get(receipt.buzzEventId);
    if (mirrored) present += 1;
    else if (!truncated) failures.push(`missing Buzz event ${receipt.buzzEventId}`);

    if (message.thread_ts && message.thread_ts !== message.ts) {
      const parent = stateStore.getMessage(
        sourceKey(mapping.slackChannelId, message.thread_ts),
      );
      const hasReplyTarget = canonicalReplyTargets(mirrored?.tags).has(
        parent?.buzzEventId,
      );
      if (parent?.buzzEventId && hasReplyTarget) {
        threadLinks += 1;
      } else if (parent?.buzzEventId && mirrored && repairThreads) {
        const replacement = await buzzClient.sendMessage(
          mapping.buzzChannelId,
          receipt.content,
          parent.buzzEventId,
        );
        if (!replacement?.event_id) {
          failures.push(`thread repair did not return an event ID for ${message.ts}`);
          continue;
        }
        const previousEventId = receipt.buzzEventId;
        await stateStore.record({
          sourceKey: sourceKey(mapping.slackChannelId, message.ts),
          message: {
            ...receipt,
            buzzEventId: replacement.event_id,
            buzzReplyToEventId: parent.buzzEventId,
            supersededBuzzEventIds: [
              ...(receipt.supersededBuzzEventIds ?? []),
              previousEventId,
            ],
            threadRepairedAt: new Date().toISOString(),
          },
        });
        await buzzClient.deleteMessage(previousEventId);
        repairedThreads += 1;
        threadLinks += 1;
      } else if (mirrored || !truncated) {
        failures.push(`invalid thread parent for ${message.ts}`);
      }
    }
  }

  const changedReceipts = Object.values(stateStore.state.messages)
    .filter(
      (receipt) =>
        receipt.source?.channelId === mapping.slackChannelId &&
        (receipt.updatedAt || receipt.deletedAt),
    )
    .slice(0, 10);
  let changedSamples = 0;
  for (const receipt of changedReceipts) {
    const mirrored = buzzById.get(receipt.buzzEventId);
    if (mirrored?.content === receipt.content) changedSamples += 1;
    else if (mirrored || !truncated) {
      failures.push(`changed message mismatch for ${receipt.buzzEventId}`);
    }
  }

  return {
    ok: failures.length === 0,
    slackChannelId: mapping.slackChannelId,
    buzzChannelId: mapping.buzzChannelId,
    sourceMessages: sourceMessages.length,
    receipts,
    present: truncated ? "skipped-truncated" : present,
    threadLinks,
    repairedThreads,
    changedSamples,
    buzzFetchTruncated: truncated,
    failures,
  };
}

export function formatVerificationReport(results, observedAt = new Date()) {
  const lines = [
    "Slack -> Buzz mirror verification",
    `Observed: ${observedAt.toISOString()}`,
    `Result: ${results.every((result) => result.ok) ? "PASS" : "FAIL"}`,
    "",
  ];
  for (const result of results) {
    lines.push(
      `Slack ${result.slackChannelId} -> Buzz ${result.buzzChannelId}`,
      `  result: ${result.ok ? "PASS" : "FAIL"}`,
      `  source messages: ${result.sourceMessages}`,
      `  receipts: ${result.receipts}`,
      `  Buzz presence: ${result.present}`,
      `  thread links: ${result.threadLinks}`,
      `  repaired thread links: ${result.repairedThreads}`,
      `  changed/deleted samples: ${result.changedSamples}`,
      `  Buzz fetch truncated: ${result.buzzFetchTruncated}`,
    );
    for (const failure of result.failures) lines.push(`  failure: ${failure}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export function canonicalReplyTargets(tags = []) {
  const replyTags = tags.filter(
    (tag) => tag[0] === "e" && tag[3] === "reply" && tag[1],
  );
  if (replyTags.length > 0) return new Set(replyTags.map((tag) => tag[1]));
  const eventTags = tags.filter((tag) => tag[0] === "e" && tag[1]);
  return new Set(eventTags.slice(-1).map((tag) => tag[1]));
}
