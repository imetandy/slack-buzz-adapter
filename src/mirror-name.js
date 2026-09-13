import { createHash } from "node:crypto";

export const MAX_BUZZ_CHANNEL_NAME_CHARS = 64;

export function mirrorChannelName({ prefix = "", sourceName, slackChannelId }) {
  const full = `${prefix}${sourceName}`;
  if ([...full].length <= MAX_BUZZ_CHANNEL_NAME_CHARS) return full;
  const suffix = createHash("sha256")
    .update(`${slackChannelId}\0${sourceName}`)
    .digest("hex")
    .slice(0, 10);
  const room = MAX_BUZZ_CHANNEL_NAME_CHARS - suffix.length - 1;
  return `${[...full].slice(0, room).join("")}-${suffix}`;
}
