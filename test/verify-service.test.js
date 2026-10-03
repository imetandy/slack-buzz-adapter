import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalReplyTargets,
  formatVerificationReport,
  verifyChannelMirror,
} from "../src/verify-service.js";

function harness({ buzzMessages, stateMessages, buzzLimit = 200, repairThreads = false }) {
  const sent = [];
  const deleted = [];
  const slackClient = {
    async channelHistory() {
      return {
        messages: [
          { ts: "1.0", text: "root", reply_count: 1 },
          { ts: "2.0", text: "changed" },
        ],
      };
    },
    async threadReplies() {
      return {
        messages: [
          { ts: "1.0", text: "root" },
          { ts: "1.1", thread_ts: "1.0", text: "reply" },
        ],
      };
    },
  };
  const stateStore = {
    state: { messages: stateMessages },
    getMessage(key) {
      return stateMessages[key];
    },
    async record({ sourceKey, message }) {
      stateMessages[sourceKey] = message;
    },
  };
  return verifyChannelMirror({
    slackClient,
    buzzClient: {
      async getMessages() { return buzzMessages; },
      async sendMessage(channelId, content, replyTo) {
        sent.push({ channelId, content, replyTo });
        return { event_id: "E4" };
      },
      async deleteMessage(eventId) { deleted.push(eventId); },
    },
    stateStore,
    mapping: { slackChannelId: "C1", buzzChannelId: "B1" },
    buzzLimit,
    repairThreads,
  });
}

const STATE = {
  "C1:1.0": {
    buzzEventId: "E1",
    content: "root",
    source: { channelId: "C1" },
  },
  "C1:1.1": {
    buzzEventId: "E2",
    content: "reply",
    source: { channelId: "C1" },
    slackThreadTs: "1.0",
  },
  "C1:2.0": {
    buzzEventId: "E3",
    content: "changed",
    source: { channelId: "C1" },
    updatedAt: "2026-01-01T00:00:00Z",
  },
};

test("passes counts, receipts, thread linkage, and changed samples", async () => {
  const result = await harness({
    stateMessages: STATE,
    buzzMessages: [
      { id: "E1", content: "root", tags: [] },
      { id: "E2", content: "reply", tags: [["e", "E1"]] },
      { id: "E3", content: "changed", tags: [] },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.receipts, 3);
  assert.equal(result.threadLinks, 1);
  assert.match(formatVerificationReport([result]), /Result: PASS/);
});

test("reports missing receipts and invalid thread parents", async () => {
  const stateMessages = structuredClone(STATE);
  delete stateMessages["C1:2.0"];
  const result = await harness({
    stateMessages,
    buzzMessages: [
      { id: "E1", content: "root", tags: [] },
      { id: "E2", content: "reply", tags: [["e", "wrong"]] },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((failure) => failure.includes("missing receipt")));
  assert.ok(result.failures.some((failure) => failure.includes("thread parent")));
});

test("flags truncation and skips unsupported absence claims", async () => {
  const result = await harness({
    stateMessages: STATE,
    buzzMessages: [{ id: "unrelated", content: "x", tags: [] }],
    buzzLimit: 1,
  });
  assert.equal(result.buzzFetchTruncated, true);
  assert.equal(result.present, "skipped-truncated");
  assert.equal(
    result.failures.some((failure) => failure.includes("missing Buzz event")),
    false,
  );
});

test("canonical reply markers take precedence over root event tags", () => {
  assert.deepEqual(
    [...canonicalReplyTargets([
      ["e", "ROOT", "", "root"],
      ["e", "PARENT", "", "reply"],
    ])],
    ["PARENT"],
  );
  assert.deepEqual([...canonicalReplyTargets([["e", "LEGACY"]])], ["LEGACY"]);
});

test("repairs an orphan reply and records the canonical replacement", async () => {
  const stateMessages = structuredClone(STATE);
  const result = await harness({
    stateMessages,
    repairThreads: true,
    buzzMessages: [
      { id: "E1", content: "root", tags: [] },
      { id: "E2", content: "reply", tags: [] },
      { id: "E3", content: "changed", tags: [] },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.repairedThreads, 1);
  assert.equal(stateMessages["C1:1.1"].buzzEventId, "E4");
  assert.equal(stateMessages["C1:1.1"].buzzReplyToEventId, "E1");
  assert.deepEqual(stateMessages["C1:1.1"].supersededBuzzEventIds, ["E2"]);
});
