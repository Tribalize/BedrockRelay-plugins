import { system, world } from "@minecraft/server";

/**
 * Player list — a BedrockRelay plugin.
 * /playerlist shows who is on right now: the device each player is on, how long
 * they've been on this time, and their playtime in total. Add live: True to
 * keep it in the channel, updated every minute.
 */

const PREFIX = "bedrockrelay:pl:";
// The Leaderboards plugin's records: when it's installed, its playtime is the total shown, so the two never disagree.
const LEADERBOARDS = "bedrockrelay:lb:";
// BedrockRelay's own bot on a Realm carries this tag: it isn't a player, so it's never listed.
const BOT_TAG = "bedrockrelay:bot";
const isBot = (player) => { try { return player.hasTag(BOT_TAG); } catch { return false; } };

const DEVICES = {
  Desktop: { icon: "🖥️", name: "PC" },
  Mobile: { icon: "📱", name: "Mobile" },
  Console: { icon: "🎮", name: "Console" },
};
const UNKNOWN_DEVICE = { icon: "❔", name: "Unknown" };
// An embed's description holds 4,096 characters; this many lines stays well inside it.
const MAX_LINES = 40;

function device(player) {
  try { return DEVICES[player.clientSystemInfo.platformType] ?? UNKNOWN_DEVICE; } catch { return UNKNOWN_DEVICE; }
}

function duration(seconds) {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return "just joined";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/* ---------------- Storage: { pt: seconds played, j: when this session began }, saved every minute ---------------- */

const cache = new Map();
const dirty = new Set();

function read(key) {
  try { return JSON.parse(String(world.getDynamicProperty(key) ?? "null")); } catch { return null; }
}

function record(id) {
  let entry = cache.get(id);
  if (!entry) {
    entry = read(PREFIX + id) ?? {};
    cache.set(id, entry);
  }
  return entry;
}

function save() {
  for (const id of dirty) {
    try { world.setDynamicProperty(PREFIX + id, JSON.stringify(cache.get(id))); } catch { /* storage full: keep counting in memory */ }
  }
  dirty.clear();
}
system.runInterval(save, 1200);

/** Total playtime in seconds: the Leaderboards plugin's when it has one, else our own count. */
function total(player) {
  const counted = read(LEADERBOARDS + player.id)?.pt;
  return typeof counted === "number" ? counted : record(player.id).pt ?? 0;
}

/* ---------------- Sessions and playtime ---------------- */

world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  if (!initialSpawn || !player || isBot(player)) return;
  record(player.id).j = Date.now();
  dirty.add(player.id);
});

// Players already on when the plugin loads (after a /reload) keep the session they had. Not during startup, when the world can't be read yet.
system.run(() => {
  for (const player of world.getAllPlayers().filter(Boolean)) {
    if (isBot(player)) continue;
    const entry = record(player.id);
    if (!entry.j) { entry.j = Date.now(); dirty.add(player.id); }
  }
});

let lastTick = Date.now();
system.runInterval(() => {
  const now = Date.now();
  // Real seconds, capped so a stalled server doesn't hand out free hours.
  const seconds = Math.min(5, (now - lastTick) / 1000);
  lastTick = now;
  for (const player of world.getAllPlayers().filter(Boolean)) {
    if (isBot(player)) continue;
    const entry = record(player.id);
    entry.pt = (entry.pt ?? 0) + seconds;
    dirty.add(player.id);
  }
}, 20);

/* ---------------- The command ---------------- */

export default {
  id: "playerlist",
  name: "Player list",
  version: "1.0.1",
  description: "Who is online right now, the device each is playing on, and their playtime.",
  commands: [
    {
      name: "playerlist",
      description: "Who is online right now",
      public: true,
      // live:True keeps it in the channel, updated every minute (the owner can change that).
      board: { every: 1 },
      options: [],
      run() {
        const now = Date.now();
        const players = world.getAllPlayers().filter(Boolean)
          .filter((player) => !isBot(player))
          .map((player) => ({ player, since: record(player.id).j ?? now }))
          .sort((a, b) => a.since - b.since);

        if (!players.length) {
          return { embed: { color: 0x80848e, title: "Nobody online", description: "Nobody is playing right now." } };
        }

        const lines = players.slice(0, MAX_LINES).map(({ player, since }) => {
          const { icon } = device(player);
          const played = total(player);
          return `${icon} **${player.name}** · on for ${duration((now - since) / 1000)} · ${played < 60 ? "first visit" : `${duration(played)} in total`}`;
        });
        if (players.length > MAX_LINES) lines.push(`…and ${players.length - MAX_LINES} more`);

        const counts = Object.values(DEVICES).concat(UNKNOWN_DEVICE)
          .map((kind) => [kind, players.filter(({ player }) => device(player) === kind).length])
          .filter(([, count]) => count)
          .map(([kind, count]) => `${kind.icon} ${count} ${kind.name}`);

        return {
          embed: {
            color: 0x57f287,
            title: `🟢 ${players.length} ${players.length === 1 ? "player" : "players"} online`,
            description: lines.join("\n"),
            footer: { text: counts.join(" · ") },
          },
        };
      },
    },
  ],
};
