// Permission bits shared between the server and the client (kept below 2^30 so JS bit operations stay safe).
export const P = {
  ADMIN: 1,
  MANAGE_SERVER: 2,
  MANAGE_CHANNELS: 4,
  MANAGE_ROLES: 8,
  KICK_MEMBERS: 16,
  BAN_MEMBERS: 32,
  MANAGE_MESSAGES: 64,
  CREATE_INVITE: 128,
  SEND_MESSAGES: 256,
  ATTACH_FILES: 512,
  ADD_REACTIONS: 1024,
  MENTION_EVERYONE: 2048,
  CONNECT: 4096,
  SPEAK: 8192,
  VIDEO: 16384,
  MOVE_MEMBERS: 32768,
  VIEW_CHANNEL: 65536,
  MUTE_MEMBERS: 131072,
  DEAFEN_MEMBERS: 262144,
  MANAGE_WEBHOOKS: 524288,
  MODERATE_MEMBERS: 1048576,
  MANAGE_EXPRESSIONS: 2097152,
  MANAGE_EVENTS: 4194304,
  CREATE_THREADS: 8388608,
  SEND_IN_THREADS: 16777216,
  USE_SOUNDBOARD: 33554432,
  VIEW_AUDIT_LOG: 67108864,
  REQUEST_TO_SPEAK: 134217728,
  MANAGE_THREADS: 268435456,
} as const;

export const ALL_PERMS = Object.values(P).reduce((a, b) => a | b, 0);

export const DEFAULT_PERMS =
  P.VIEW_CHANNEL |
  P.CREATE_INVITE |
  P.SEND_MESSAGES |
  P.ATTACH_FILES |
  P.ADD_REACTIONS |
  P.CONNECT |
  P.SPEAK |
  P.VIDEO |
  P.CREATE_THREADS |
  P.SEND_IN_THREADS |
  P.USE_SOUNDBOARD |
  P.REQUEST_TO_SPEAK;

/** Permissions that only make sense per channel (shown in channel permission overrides). */
export const CHANNEL_PERMS =
  P.VIEW_CHANNEL |
  P.MANAGE_CHANNELS |
  P.CREATE_INVITE |
  P.SEND_MESSAGES |
  P.SEND_IN_THREADS |
  P.CREATE_THREADS |
  P.ATTACH_FILES |
  P.ADD_REACTIONS |
  P.MENTION_EVERYONE |
  P.MANAGE_MESSAGES |
  P.MANAGE_THREADS |
  P.CONNECT |
  P.SPEAK |
  P.VIDEO |
  P.USE_SOUNDBOARD |
  P.MUTE_MEMBERS |
  P.DEAFEN_MEMBERS |
  P.MOVE_MEMBERS |
  P.REQUEST_TO_SPEAK;

/** What a member keeps while in timeout (Discord's "time out" moderation). */
export const TIMEOUT_REMOVES = P.SEND_MESSAGES | P.SEND_IN_THREADS | P.CREATE_THREADS | P.ADD_REACTIONS | P.CONNECT | P.SPEAK | P.VIDEO | P.USE_SOUNDBOARD | P.REQUEST_TO_SPEAK;

export const PERM_LABELS: [number, string, string][] = [
  [P.ADMIN, 'Administrator', 'Grants every permission. Be careful with this one.'],
  [P.VIEW_CHANNEL, 'View Channels', 'See channels and read their messages.'],
  [P.MANAGE_SERVER, 'Manage Server', 'Change the server name and icon, change nicknames.'],
  [P.MANAGE_CHANNELS, 'Manage Channels', 'Create, edit, reorder and delete channels.'],
  [P.MANAGE_ROLES, 'Manage Roles', 'Create, edit and assign roles lower than their own.'],
  [P.MANAGE_EXPRESSIONS, 'Manage Expressions', 'Add or remove custom emoji, stickers and soundboard sounds.'],
  [P.MANAGE_WEBHOOKS, 'Manage Webhooks', 'Create, edit and delete webhooks.'],
  [P.MANAGE_EVENTS, 'Manage Events', 'Create, edit and cancel events.'],
  [P.VIEW_AUDIT_LOG, 'View Audit Log', 'See who changed what in this server.'],
  [P.KICK_MEMBERS, 'Kick Members', 'Remove members from the server.'],
  [P.BAN_MEMBERS, 'Ban Members', 'Permanently ban members from the server.'],
  [P.MODERATE_MEMBERS, 'Time Out Members', 'Stop members from chatting or talking for a while.'],
  [P.CREATE_INVITE, 'Create Invite', 'Invite new people to the server.'],
  [P.SEND_MESSAGES, 'Send Messages', 'Send messages in text channels.'],
  [P.SEND_IN_THREADS, 'Send Messages in Threads', 'Talk in threads and forum posts.'],
  [P.CREATE_THREADS, 'Create Threads', 'Start threads and forum posts.'],
  [P.MANAGE_THREADS, 'Manage Threads', 'Rename, archive and delete threads.'],
  [P.ATTACH_FILES, 'Attach Files', 'Upload images and files.'],
  [P.ADD_REACTIONS, 'Add Reactions', 'React to messages with emoji.'],
  [P.MENTION_EVERYONE, 'Mention @everyone', 'Notify every member at once.'],
  [P.MANAGE_MESSAGES, 'Manage Messages', 'Delete and pin messages of other members.'],
  [P.CONNECT, 'Connect', 'Join voice channels.'],
  [P.SPEAK, 'Speak', 'Talk in voice channels.'],
  [P.VIDEO, 'Video', 'Share camera or screen in voice channels.'],
  [P.USE_SOUNDBOARD, 'Use Soundboard', 'Play soundboard sounds in voice channels.'],
  [P.REQUEST_TO_SPEAK, 'Request to Speak', 'Raise a hand on stage channels.'],
  [P.MUTE_MEMBERS, 'Mute Members', 'Server-mute others in voice channels.'],
  [P.DEAFEN_MEMBERS, 'Deafen Members', 'Server-deafen others in voice channels.'],
  [P.MOVE_MEMBERS, 'Move Members', 'Move or disconnect others in voice channels.'],
];

export const CH = { TEXT: 0, DM: 1, VOICE: 2, GROUP: 3, CATEGORY: 4, ANNOUNCEMENT: 5, THREAD: 11, STAGE: 13, FORUM: 15 } as const;
/** Channel types that hold messages directly. */
export const TEXT_LIKE: number[] = [CH.TEXT, CH.ANNOUNCEMENT, CH.THREAD, CH.VOICE, CH.STAGE, CH.DM, CH.GROUP];
export const VOICE_LIKE: number[] = [CH.VOICE, CH.STAGE, CH.DM, CH.GROUP];
export const REL = { FRIEND: 1, BLOCKED: 2, INCOMING: 3, OUTGOING: 4 } as const;
export const MAX_FILE_SIZE = 25 * 1024 * 1024;
/** Default total upload space per user; override with the UPLOAD_QUOTA_MB setting. */
export const DEFAULT_UPLOAD_QUOTA_MB = 1024;
export const MAX_MESSAGE_LENGTH = 4000;

/** Discord-style permission calculation for one channel (also used by the client to hide buttons). */
export function computeChannelPerms(
  base: number,
  isOwnerOrAdmin: boolean,
  serverId: string,
  memberRoles: string[],
  userId: string,
  overwrites: { id: string; type: number; allow: number; deny: number }[]
): number {
  if (isOwnerOrAdmin) return ALL_PERMS;
  let p = base;
  const everyone = overwrites.find((o) => o.id === serverId);
  if (everyone) p = (p & ~everyone.deny) | everyone.allow;
  let allow = 0;
  let deny = 0;
  for (const o of overwrites) if (o.type === 0 && o.id !== serverId && memberRoles.includes(o.id)) (allow |= o.allow), (deny |= o.deny);
  p = (p & ~deny) | allow;
  const mine = overwrites.find((o) => o.type === 1 && o.id === userId);
  if (mine) p = (p & ~mine.deny) | mine.allow;
  return p & P.VIEW_CHANNEL ? p : 0;
}
