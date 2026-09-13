import assert from "node:assert/strict";
import test from "node:test";
import { mirrorChannelName } from "../src/mirror-name.js";

test("preserves mirror names that fit", () => {
  assert.equal(mirrorChannelName({ prefix: "mirror-", sourceName: "general", slackChannelId: "C1" }), "mirror-general");
});

test("shortens deterministically to 64 characters", () => {
  const args = { prefix: "mirror-", sourceName: "x".repeat(80), slackChannelId: "C123" };
  const name = mirrorChannelName(args);
  assert.equal([...name].length, 64);
  assert.equal(name, mirrorChannelName(args));
});

test("uses the stable Slack id to avoid truncation collisions", () => {
  const sourceName = "same-prefix-" + "x".repeat(80);
  const left = mirrorChannelName({ prefix: "mirror-", sourceName, slackChannelId: "C1" });
  const right = mirrorChannelName({ prefix: "mirror-", sourceName, slackChannelId: "C2" });
  assert.notEqual(left, right);
});
