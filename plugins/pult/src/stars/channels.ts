// A Star's channels (xaxis `pult/issues/star-channels.md`): a channel is a slug nothing registers,
// told on a thread by its tag `pult:channel:<slug>`; `user` is the one with the user, and `work`
// the one a message lands in that names none.

/** A channel's slug: lowercase letters, digits and hyphens, starting with a letter or a digit, up to 51 characters, which is what a tag's 64 leave. */
export type Channel = string;

export const USER_CHANNEL: Channel = "user";
export const WORK_CHANNEL: Channel = "work";

const CHANNEL_TAG_PREFIX = "pult:channel:";

/** The slug rule, for the tool's parameter and the tag's reading alike. */
export const CHANNEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,50}$/u;

export const isChannel = (slug: string): slug is Channel => CHANNEL_PATTERN.test(slug);

/** The tag that says a thread's channel. */
export const channelTag = (channel: Channel) => `${CHANNEL_TAG_PREFIX}${channel}`;

/** The channel the first valid channel tag names; undefined where none does. */
export const taggedChannel = (tags: ReadonlyArray<string> | undefined): Channel | undefined =>
  tags
    ?.filter((tag) => tag.startsWith(CHANNEL_TAG_PREFIX))
    .map((tag) => tag.slice(CHANNEL_TAG_PREFIX.length))
    .find(isChannel);

/** The tag a Star gives every thread it launches, its child: `pult:child:star:<id>`. */
export const childTag = (starId: string) => `pult:child:star:${starId}`;
