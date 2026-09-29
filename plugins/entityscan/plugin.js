import { prettyName, findPlayer } from "../relay/api.js";

/**
 * Entity scan — a private BedrockRelay plugin.
 *
 * /entities <player> [chunks] gives a compact inventory of every currently
 * loaded entity near an online player. /lagcheck uses the same bounded scan,
 * but highlights entity kinds that are commonly worth checking when a world
 * is slow. Both commands are deliberately non-public: BedrockRelay's
 * dashboard decides which Discord administrators and roles may run them.
 */

// Server-owner tuning. A chunk is 16 blocks. Do not make MAX_SCAN_CHUNKS
// large: getEntities() returns every matching loaded entity at once.
const DEFAULT_SCAN_CHUNKS = 4;
const MAX_SCAN_CHUNKS = 6;
const SCAN_COOLDOWN_MS = 15_000;
const MAX_TYPES_SHOWN = 15;

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
  let entities;
  try {
    // This is a bounded 3D radius around the player, not a whole-server scan.
    entities = player.dimension.getEntities({ location: player.location, maxDistance: radius });
  } catch {
    return { error: `Couldn't scan near **${player.name}**. Their area may have unloaded; try again.` };
  }

  nextScanAt = now + SCAN_COOLDOWN_MS;
  const counts = new Map();
  for (const entity of entities) {
    try {
      const type = entity.typeId;
      counts.set(type, (counts.get(type) ?? 0) + 1);
    } catch {
      // An entity can disappear between the query and this loop.
    }
  }
  return { counts, chunks, radius, total: entities.length };
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

function scanInfo(scan) {
  return `${scan.chunks} ${scan.chunks === 1 ? "chunk" : "chunks"} · ${scan.radius}-block radius · currently loaded entities only`;
}

function requestedPlayer(name) {
  const player = findPlayer(name);
  if (!player) return { error: `**${name}** isn't online right now, so there is no area to scan.` };
  return { player };
}

function entitiesCommand({ player: name, chunks: requestedChunks }) {
  const target = requestedPlayer(name);
  if (target.error) return target.error;
  const parsed = normaliseChunks(requestedChunks);
  if (parsed.error) return parsed.error;
  const scan = scanNear(target.player, parsed.chunks);
  if (scan.error) return scan.error;
  const rows = sortedCounts(scan.counts);
  return {
    embed: {
      color: 0x5865f2,
      author: { name: `Entities near ${target.player.name}`, player: target.player.name },
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

function lagcheckCommand({ player: name, chunks: requestedChunks }) {
  const target = requestedPlayer(name);
  if (target.error) return target.error;
  const parsed = normaliseChunks(requestedChunks);
  if (parsed.error) return parsed.error;
  const scan = scanNear(target.player, parsed.chunks);
  if (scan.error) return scan.error;

  const suspects = lagSummary(scan.counts);
  const otherTypes = sortedCounts(new Map([...scan.counts].filter(([type]) => type !== "minecraft:player" && !lagGroup(type))));
  const suspectText = suspects.length
    ? suspects.map(([group, count]) => `• **${group}** ×${count}`).join("\n")
    : "_No dropped items, XP orbs, projectiles, vehicles, armor stands, or villagers found._";

  return {
    embed: {
      color: suspects.length ? 0xe67e22 : 0x57f287,
      author: { name: `Lag check near ${target.player.name}`, player: target.player.name },
      fields: [
        { name: "Scan", value: scanInfo(scan), inline: false },
        { name: "Total entities", value: String(scan.total), inline: true },
        { name: "Common lag contributors", value: suspectText },
        { name: "Largest other entity types", value: compactLines(otherTypes, 8) },
      ],
      footer: { text: "This is a snapshot. Repeat only after the 15-second scan cooldown." },
    },
  };
}

export default {
  // Keep this literal: BedrockRelay's private-plugin upload validation reads it.
  id: "entity-scan",
  name: "Entity scan",
  version: "1.0.1",
  description: "Counts currently loaded entities in a bounded radius around an online player, and highlights common lag contributors such as dropped items, XP orbs, projectiles, vehicles, armor stands and villagers.",
  privacy: "Shows which player is being inspected and what entities are currently near their location, which can reveal activity around a base.",
  minPackVersion: "0.4.0",
  commands: [
    {
      name: "entities",
      description: "Count loaded entities around an online player",
      options: [
        { name: "player", type: "player", description: "The player whose nearby area to scan", required: true },
        {
          name: "chunks", type: "integer", description: "Scan radius in chunks (1-6; one chunk is 16 blocks)", required: false,
          choices: [
            { name: "1 chunk · 16 blocks", value: 1 },
            { name: "2 chunks · 32 blocks", value: 2 },
            { name: "3 chunks · 48 blocks", value: 3 },
            { name: "4 chunks · 64 blocks", value: 4 },
            { name: "5 chunks · 80 blocks", value: 5 },
            { name: "6 chunks · 96 blocks", value: 6 },
          ],
        },
      ],
      // Keep this inline form, matching BedrockRelay's published plugin examples.
      run({ player: name, chunks }) {
        return entitiesCommand({ player: name, chunks });
      },
    },
    {
      name: "lagcheck",
      description: "Highlight likely entity-related lag contributors near a player",
      options: [
        { name: "player", type: "player", description: "The player whose nearby area to scan", required: true },
        {
          name: "chunks", type: "integer", description: "Scan radius in chunks (1-6; one chunk is 16 blocks)", required: false,
          choices: [
            { name: "1 chunk · 16 blocks", value: 1 },
            { name: "2 chunks · 32 blocks", value: 2 },
            { name: "3 chunks · 48 blocks", value: 3 },
            { name: "4 chunks · 64 blocks", value: 4 },
            { name: "5 chunks · 80 blocks", value: 5 },
            { name: "6 chunks · 96 blocks", value: 6 },
          ],
        },
      ],
      // Keep this inline form, matching BedrockRelay's published plugin examples.
      run({ player: name, chunks }) {
        return lagcheckCommand({ player: name, chunks });
      },
    },
  ],
};
