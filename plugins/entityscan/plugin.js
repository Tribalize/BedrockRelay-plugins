import { prettyName, findPlayer } from "../relay/api.js";

/**
 * Entity scan — a BedrockRelay plugin, by PPTribalize.
 *
 * /entities <player> [chunks] counts every currently loaded entity near an
 * online player. /lagcheck uses the same scan, but picks out the kinds of
 * entity that are commonly worth checking when a world is slow. Both are
 * private answers; the dashboard decides who may run them.
 *
 * One getEntities() call per command, limited to a 96-block radius, with one
 * cooldown shared by both commands.
 */

const DEFAULT_SCAN_CHUNKS = 4;
const MAX_SCAN_CHUNKS = 6;
const SCAN_COOLDOWN_MS = 15_000;
const MAX_TYPES_SHOWN = 15;
const MAX_LOCATIONS_SHOWN = 15;
const BOT_TAG = "bedrockrelay:bot";

let nextScanAt = 0;

const PROJECTILES = new Set([
  "minecraft:arrow",
  "minecraft:egg",
  "minecraft:ender_pearl",
  "minecraft:fireball",
  "minecraft:small_fireball",
  "minecraft:snowball",
  "minecraft:trident",
  "minecraft:wind_charge",
]);

const isBot = (entity) => { try { return entity.typeId === "minecraft:player" && entity.hasTag(BOT_TAG); } catch { return false; } };

function normaliseChunks(value) {
  if (value === undefined) return { chunks: DEFAULT_SCAN_CHUNKS };
  const chunks = Number(value);
  if (!Number.isInteger(chunks) || chunks < 1 || chunks > MAX_SCAN_CHUNKS) {
    return { error: `Choose a whole number of chunks from 1 to ${MAX_SCAN_CHUNKS}.` };
  }
  return { chunks };
}

function scanNear(player, chunks) {
  const now = Date.now();
  const wait = nextScanAt - now;
  if (wait > 0) return { error: `Please wait ${Math.ceil(wait / 1000)} seconds before the next entity scan.` };

  const radius = chunks * 16;
  const center = { x: player.location.x, y: player.location.y, z: player.location.z };
  let entities;
  try {
    // A sphere around the player, not a whole-dimension scan.
    entities = player.dimension.getEntities({ location: player.location, maxDistance: radius });
  } catch {
    return { error: `Couldn't scan near **${player.name}**. Their area may have unloaded; try again.` };
  }

  nextScanAt = now + SCAN_COOLDOWN_MS;
  const counts = new Map();
  const snapshots = [];
  let total = 0;
  for (const entity of entities) {
    try {
      if (isBot(entity)) continue;
      const type = entity.typeId;
      counts.set(type, (counts.get(type) ?? 0) + 1);
      const location = entity.location;
      snapshots.push({ type, location: { x: location.x, y: location.y, z: location.z } });
      total++;
    } catch {
      // An entity can disappear between the query and this loop.
    }
  }
  return { counts, chunks, radius, center, snapshots, total };
}

function sortedCounts(counts) {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function typeLine([type, count]) {
  return `• **${prettyName(type)}** ×${count}`;
}

/** Keep Discord's 1,024-character embed-field limit comfortably in range. */
function compactLines(rows, maximum = MAX_TYPES_SHOWN) {
  const shown = [];
  let length = 0;
  for (let index = 0; index < rows.length && index < maximum; index++) {
    const line = typeLine(rows[index]);
    if (length + line.length + 1 > 980) break;
    shown.push(line);
    length += line.length + 1;
  }
  const hidden = rows.length - shown.length;
  if (hidden) shown.push(`…and ${hidden} more ${hidden === 1 ? "type" : "types"}`);
  return shown.join("\n") || "_None_";
}

function lagGroup(type) {
  if (type === "minecraft:item") return "Dropped items";
  if (type === "minecraft:xp_orb") return "XP orbs";
  if (PROJECTILES.has(type)) return "Projectiles";
  if (type === "minecraft:tnt") return "Primed TNT";
  if (type === "minecraft:falling_block") return "Falling blocks";
  if (type.includes("minecart")) return "Minecarts";
  if (type === "minecraft:armor_stand") return "Armor stands";
  if (type.includes("boat")) return "Boats";
  if (type === "minecraft:villager" || type === "minecraft:villager_v2") return "Villagers";
  return null;
}

function lagSummary(counts) {
  const groups = new Map();
  for (const [type, count] of counts) {
    const group = lagGroup(type);
    if (group) groups.set(group, (groups.get(group) ?? 0) + count);
  }
  return [...groups.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function normaliseEntityType(value) {
  const typed = String(value ?? "").trim().toLowerCase();
  if (!typed) return null;
  const aliases = {
    item: "minecraft:item",
    items: "minecraft:item",
    dropped_item: "minecraft:item",
    dropped_items: "minecraft:item",
    xp: "minecraft:xp_orb",
    xp_orb: "minecraft:xp_orb",
    experience_orb: "minecraft:xp_orb",
    armorstand: "minecraft:armor_stand",
  };
  const simplified = typed.replace(/[ -]/g, "_");
  if (aliases[simplified]) return aliases[simplified];
  return simplified.includes(":") ? simplified : `minecraft:${simplified}`;
}

function distanceSquared(a, b) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
}

function coordinateLines(matches, center) {
  const sorted = [...matches].sort((a, b) => distanceSquared(a.location, center) - distanceSquared(b.location, center));
  const shown = sorted.slice(0, MAX_LOCATIONS_SHOWN).map(({ location }) =>
    `• \`${Math.floor(location.x)}, ${Math.floor(location.y)}, ${Math.floor(location.z)}\``,
  );
  const hidden = sorted.length - shown.length;
  if (hidden) shown.push(`…and ${hidden} more`);
  return shown.join("\n") || "_None_";
}

function scanInfo(scan) {
  return `${scan.chunks} ${scan.chunks === 1 ? "chunk" : "chunks"} · ${scan.radius}-block radius · currently loaded entities only`;
}

function requestedPlayer(name) {
  const player = findPlayer(name);
  if (!player || isBot(player)) return { error: `**${name}** isn't online right now, so there is no area to scan.` };
  return { player };
}

function prepare({ player: name, chunks: requestedChunks }) {
  const target = requestedPlayer(name);
  if (target.error) return target;
  const parsed = normaliseChunks(requestedChunks);
  if (parsed.error) return parsed;
  const scan = scanNear(target.player, parsed.chunks);
  if (scan.error) return scan;
  return { player: target.player, scan };
}

function entitiesCommand(args) {
  const { error, player, scan } = prepare(args);
  if (error) return error;
  const rows = sortedCounts(scan.counts);
  return {
    embed: {
      color: 0x5865f2,
      author: { name: `Entities near ${player.name}`, player: player.name },
      fields: [
        { name: "Scan", value: scanInfo(scan), inline: false },
        { name: "Total", value: String(scan.total), inline: true },
        { name: "Entity types", value: String(rows.length), inline: true },
        { name: "Most common", value: compactLines(rows) },
      ],
      footer: { text: "A high count is a clue, not proof of the source of lag." },
    },
  };
}

function lagcheckCommand(args) {
  const { error, player, scan } = prepare(args);
  if (error) return error;

  if (args.entity_type !== undefined) {
    const type = normaliseEntityType(args.entity_type);
    if (!type) return "Choose an entity type to locate, such as `item`, `minecart`, or `villager`.";
    const matches = scan.snapshots.filter((snapshot) => snapshot.type === type);
    return {
      embed: {
        color: matches.length ? 0xe67e22 : 0x57f287,
        author: { name: `${prettyName(type)} near ${player.name}`, player: player.name },
        fields: [
          { name: "Scan", value: scanInfo(scan), inline: false },
          { name: "Matching entities", value: String(matches.length), inline: true },
          { name: "Coordinates", value: coordinateLines(matches, scan.center) },
        ],
        footer: { text: "Locations are a loaded-entity snapshot and may change before you arrive." },
      },
    };
  }

  const suspects = lagSummary(scan.counts);
  const otherTypes = sortedCounts(new Map([...scan.counts].filter(([type]) => type !== "minecraft:player" && !lagGroup(type))));
  const suspectText = suspects.length
    ? suspects.map(([group, count]) => `• **${group}** ×${count}`).join("\n")
    : "_No dropped items, XP orbs, projectiles, primed TNT, falling blocks, vehicles, armor stands or villagers found._";

  return {
    embed: {
      color: suspects.length ? 0xe67e22 : 0x57f287,
      author: { name: `Lag check near ${player.name}`, player: player.name },
      fields: [
        { name: "Scan", value: scanInfo(scan), inline: false },
        { name: "Total entities", value: String(scan.total), inline: true },
        { name: "Common lag contributors", value: suspectText },
        { name: "Largest other entity types", value: compactLines(otherTypes, 8) },
      ],
      footer: { text: "This is a snapshot. A large farm of one animal can matter as much as anything above." },
    },
  };
}

const PLAYER_OPTION = { name: "player", type: "player", description: "The player whose surroundings to scan", required: true };

const CHUNKS_OPTION = {
  name: "chunks", type: "integer", description: "How far to look, in chunks (one chunk is 16 blocks)", required: false,
  choices: Array.from({ length: MAX_SCAN_CHUNKS }, (_, index) => {
    const chunks = index + 1;
    return { name: `${chunks} ${chunks === 1 ? "chunk" : "chunks"} · ${chunks * 16} blocks`, value: chunks };
  }),
};

const ENTITIES_OPTIONS = [
  PLAYER_OPTION,
  CHUNKS_OPTION,
];

const LAGCHECK_OPTIONS = [
  PLAYER_OPTION,
  { name: "entity_type", type: "string", description: "Optional entity type to count and locate, e.g. item or minecart", required: false },
  CHUNKS_OPTION,
];

export default {
  id: "entity-scan",
  name: "Entity scan",
  version: "1.1.1",
  description: "Counts the loaded entities within up to 96 blocks of an online player, highlights common lag contributors, and can locate matching entity types.",
  privacy: "Shows which player is being looked at and what entities are near them, which can reveal activity around a base.",
  minPackVersion: "0.4.0",
  commands: [
    {
      name: "entities",
      description: "Count loaded entities around an online player",
      options: ENTITIES_OPTIONS,
      run(args) {
        return entitiesCommand(args);
      },
    },
    {
      name: "lagcheck",
      description: "Pick out likely entity-related lag near an online player",
      options: LAGCHECK_OPTIONS,
      run(args) {
        return lagcheckCommand(args);
      },
    },
  ],
};
