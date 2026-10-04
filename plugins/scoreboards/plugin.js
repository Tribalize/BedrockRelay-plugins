import { system, world, ScoreboardIdentityType } from "@minecraft/server";

/**
 * Scoreboards — a BedrockRelay plugin.
 * Top tens from any scoreboard on the world: money, kills, points, whatever
 * other addons keep there. /scoreboard shows one, and can keep it in the
 * channel as a live board; /scores shows one player on all of them.
 *
 * Minecraft only names a player's scores while they're online, so the names
 * are remembered here (one small record per player), which keeps offline
 * players on the board under their own name.
 */

const NAMES = "bedrockrelay:sb:";
// BedrockRelay's own bot on a Realm carries this tag: it isn't a player, so it's never ranked.
const BOT_TAG = "bedrockrelay:bot";
const isBot = (player) => { try { return player.hasTag(BOT_TAG); } catch { return false; } };
// By hand: the game's JavaScript has no locale data for toLocaleString.
const whole = (value) => String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const MEDALS = ["🥇", "🥈", "🥉"];
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/* ---------------- Who each score belongs to ---------------- */

const known = new Map();

function remembered(id) {
  if (!known.has(id)) {
    let entry = null;
    try { entry = JSON.parse(String(world.getDynamicProperty(NAMES + id) ?? "null")); } catch { /* unreadable: forget it */ }
    known.set(id, entry);
  }
  return known.get(id);
}

/** Note each online player's scoreboard identity: they only get one once they have a score. */
function remember() {
  for (const player of world.getAllPlayers().filter(Boolean)) {
    const id = player.scoreboardIdentity?.id;
    if (id === undefined) continue;
    const entry = { n: player.name, ...(isBot(player) ? { bot: true } : {}) };
    const before = remembered(id);
    if (before?.n === entry.n && Boolean(before?.bot) === Boolean(entry.bot)) continue;
    known.set(id, entry);
    try { world.setDynamicProperty(NAMES + id, JSON.stringify(entry)); } catch { /* storage full: still named while online */ }
  }
}
system.runInterval(remember, 200);
world.afterEvents.playerSpawn.subscribe(({ initialSpawn }) => { if (initialSpawn) system.runTimeout(remember, 20); });

/** A player's name for a score, or null for anything that isn't a player (or is our bot). */
function nameOf(participant) {
  if (participant.type !== ScoreboardIdentityType.Player) return null;
  let online;
  try { online = participant.getEntity(); } catch { online = undefined; }
  if (online) return isBot(online) ? null : online.name;
  const entry = remembered(participant.id);
  if (entry) return entry.bot ? null : entry.n;
  // Offline and never seen by this plugin: Minecraft's own name, unless it's its "offline player" placeholder.
  const shown = String(participant.displayName ?? "");
  return shown && !shown.startsWith("commands.") ? shown : null;
}

/* ---------------- Reading the world's scoreboards ---------------- */

function objectives() {
  try { return world.scoreboard.getObjectives(); } catch { return []; }
}

function objective(id) {
  const wanted = String(id ?? "").trim();
  return objectives().find((item) => item.id === wanted) ?? objectives().find((item) => same(item.id, wanted) || same(title(item), wanted));
}

const title = (item) => String(item.displayName || item.id).replace(/§./g, "");

/** Players' scores on one objective, highest first, each player once (their best, if the game ever gave them two entries). */
function ranked(item) {
  let scores = [];
  try { scores = item.getScores(); } catch { /* removed meanwhile */ }
  const seen = new Set();
  return scores
    .map(({ participant, score }) => ({ name: nameOf(participant), score }))
    .filter((entry) => entry.name)
    .sort((a, b) => b.score - a.score)
    .filter((entry) => !seen.has(entry.name.toLowerCase()) && seen.add(entry.name.toLowerCase()));
}

/**
 * The objectives offered in Discord and on the dashboard, read as the pack
 * starts: the ones players have scores on, most players first. Discord allows
 * 25; any other can still be asked for by its id through a restart.
 */
function offered() {
  const withPlayers = objectives()
    .map((item) => ({ item, players: ranked(item).length }))
    .filter((entry) => entry.players > 0)
    .sort((a, b) => b.players - a.players)
    .slice(0, 25);
  return withPlayers.length
    ? withPlayers.map(({ item }) => ({ name: (title(item) === item.id ? item.id : `${title(item)} (${item.id})`).slice(0, 100), value: item.id.slice(0, 100) }))
    : undefined;
}

/* ---------------- Commands ---------------- */

const objectiveOption = {
  name: "scoreboard",
  type: "string",
  description: "Which scoreboard",
  required: true,
  // Read when the pack reports its plugins, so the list is the world's own.
  get choices() { return offered(); },
};

export default {
  id: "scoreboards",
  name: "Scoreboards",
  version: "1.0.1",
  description: "Top tens from any scoreboard on your world, such as money, kills or points kept by other addons. Offline players stay on the board.",
  commands: [
    {
      name: "scoreboard",
      description: "The top ten players on one of the world's scoreboards",
      public: true,
      // live:True keeps it in the channel, updated every 10 minutes (the owner can change that).
      board: { every: 10 },
      options: [objectiveOption],
      run({ scoreboard }, { linkedPlayer }) {
        const item = objective(scoreboard);
        if (!item) return `There's no scoreboard called **${scoreboard}** on this world.`;
        const board = ranked(item);
        if (!board.length) return `Nobody has a score on **${title(item)}** yet.`;
        const lines = board.slice(0, 10).map((entry, index) => `${MEDALS[index] ?? `\`${String(index + 1).padStart(2)}\``} **${entry.name}** · ${whole(entry.score)}`);
        const mine = linkedPlayer ? board.findIndex((entry) => same(entry.name, linkedPlayer)) : -1;
        if (mine >= 10) lines.push(`\nYou: #${mine + 1} · ${whole(board[mine].score)}`);
        return {
          embed: {
            color: 0x5865f2,
            title: `📋 ${title(item)}`,
            description: lines.join("\n"),
            thumbnail: { player: board[0].name },
            footer: { text: `${board.length} ${board.length === 1 ? "player" : "players"} on the board` },
          },
        };
      },
    },
    {
      name: "scores",
      description: "A player's score on every scoreboard, and where they rank",
      public: true,
      options: [{ name: "player", type: "player", description: "Who (leave empty for you, once you've used /relay link)", required: false }],
      run({ player }, { linkedPlayer }) {
        const name = player ?? linkedPlayer;
        if (!name) return "Say which player, or link your own with `/relay link` so this knows who you are.";
        const fields = [];
        let shown = name;
        for (const item of objectives()) {
          const board = ranked(item);
          const at = board.findIndex((entry) => same(entry.name, name));
          if (at < 0) continue;
          shown = board[at].name;
          fields.push({ name: title(item).slice(0, 256), value: `${whole(board[at].score)} · #${at + 1}`, inline: true });
        }
        if (!fields.length) return `**${name}** has no scores yet.`;
        return { embed: { color: 0x5865f2, title: shown, thumbnail: { player: shown }, fields: fields.slice(0, 25) } };
      },
    },
  ],
};
