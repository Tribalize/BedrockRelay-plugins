import * as mc from "@minecraft/server";
import { ActionFormData, FormCancelationReason } from "@minecraft/server-ui";
import { askRelay, postToDiscord } from "../relay/api.js";

/**
 * Statistics — a BedrockRelay plugin.
 *
 * Counts what every player does (time played, travel, combat, blocks, items,
 * interactions and more), kept in the world itself so offline players stay on
 * the boards. Players open their numbers in game with /statistics (or /relay);
 * Discord gets /top, /stats, boards that update themselves and playtime
 * milestones. It replaces the Leaderboards plugin and takes over its totals.
 *
 * The numbers use BedrockStatistics' layout (seven groups, "bs:core" and the
 * rest), and the trackers are ported from it. When the world's owner lists it
 * on mcBedrock.net (the world's Integrations tab), this file hands what changed
 * to BedrockRelay every few minutes with askRelay(); BedrockRelay decides what
 * happens next. Unlisted, nothing leaves the world.
 *
 * Stable Script API only, so it runs on Realms too.
 */

const { system, world } = mc;
const ID = "statistics";

/* ================================ The numbers ================================ */

const GROUPS = ["bs:core", "bs:travel", "bs:combat", "bs:blocks", "bs:items", "bs:interactions", "bs:misc"];
const [CORE, TRAVEL, COMBAT, BLOCKS, ITEMS, INTERACTIONS, MISC] = GROUPS;

/** Every number a player starts with: BedrockStatistics' DEFAULT_DATA, unchanged except for chat, which needs Beta APIs. */
const DEFAULTS = {
  "bs:core": {
    time: { played: 0, session: 0, sessionStart: null, firstJoined: null, sinceRest: 0, sinceDeath: 0, sneakTime: 0 },
    sessions: { total: 0 },
    deaths: { total: 0, lastCause: null, lastTime: null },
    life: { current: 0, longest: 0 },
    xp: { current: 0, total: 0, highest: 0, level: 0 },
    movement: { jumped: 0, climbed: 0, fallen: 0 },
    coordinates: { highest: 0, lowest: 0, furthest: 0 },
    dimensions: { overworld: 0, nether: 0, the_end: 0 },
    biomes: { discovered: [], timeIn: {} },
    sleep: { total: 0 },
  },
  "bs:travel": {
    distance: { walked: 0, sprinted: 0, crouched: 0, swum: 0, flown: 0, fallen: 0, onWater: 0, underWater: 0, climbed: 0 },
    vehicles: {
      boat: { time: 0, distance: 0 }, horse: { time: 0, distance: 0 }, minecart: { time: 0, distance: 0 },
      pig: { time: 0, distance: 0 }, strider: { time: 0, distance: 0 }, happyGhast: { time: 0, distance: 0 },
      camel: { time: 0, distance: 0 }, donkey: { time: 0, distance: 0 }, mule: { time: 0, distance: 0 },
      llama: { time: 0, distance: 0 },
    },
    portals: { total: 0, transitions: {} },
  },
  "bs:combat": {
    kills: { mobs: { total: 0, byType: {} }, players: { total: 0, byPlayer: {} } },
    damage: {
      dealt: { total: 0, toMobs: 0, toPlayers: 0, absorbed: 0, resisted: 0 },
      taken: { total: 0, fromMobs: 0, fromPlayers: 0, environmental: 0, absorbed: 0, blocked: 0, resisted: 0 },
    },
    deaths: { total: 0, byMob: 0, byPlayer: 0, causes: {} },
    tools: { totalBroken: 0, byType: {} },
  },
  "bs:blocks": {
    mined: { total: 0, byType: {} },
    placed: { total: 0, byType: {} },
  },
  "bs:items": {
    used: { total: 0, byType: {} }, crafted: { total: 0, byType: {} }, broken: { total: 0, byType: {} },
    picked: { total: 0, byType: {} }, dropped: { total: 0, byType: {} }, food: { total: 0, byType: {} },
    enchanted: { total: 0 },
  },
  "bs:interactions": {
    chest: 0, enderChest: 0, barrel: 0, copperChest: 0, shulkerBox: 0, trappedChest: 0,
    craftingTable: 0, furnace: 0, blastFurnace: 0, smoker: 0, brewingStand: 0, enchantingTable: 0,
    anvil: 0, grindstone: 0, stonecutter: 0, cartographyTable: 0, loom: 0, smithingTable: 0,
    beacon: 0, lectern: 0, jukebox: 0, noteblock: { played: 0 }, bell: 0, campfire: 0,
    cauldron: { used: 0, filled: 0, bottleFilled: 0, armorCleaned: 0, bannerCleaned: 0, shulkerCleaned: 0 },
    flowerPot: { planted: 0 }, musicDisc: { played: 0 }, cake: 0,
    dispenser: 0, dropper: 0, hopper: 0,
    villager: { talked: 0, traded: 0 }, animals: { bred: 0 },
  },
  "bs:misc": {
    effects: { total: 0, unique: [], byType: {} },
    emotes: { total: 0 },
    raids: { triggered: 0, won: 0 },
    targetBlock: { hit: 0 },
  },
};

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const copy = (value) => JSON.parse(JSON.stringify(value));

/** What was saved, over the defaults, so a number added later starts at zero. */
function withDefaults(defaults, saved) {
  const out = copy(defaults);
  if (!isObject(saved)) return out;
  for (const [key, value] of Object.entries(saved)) out[key] = isObject(value) && isObject(out[key]) ? withDefaults(out[key], value) : value;
  return out;
}

/** "minecraft:stone" -> "stone", as BedrockStatistics stores types. */
const clean = (typeId) => String(typeId ?? "unknown").replace(/^minecraft:/, "");
const dimensionOf = (id) => (String(id).includes("nether") ? "nether" : String(id).includes("end") ? "the_end" : "overworld");

/* ================================ Storage ================================ */

/*
 * Each player is a record kept in world dynamic properties, so offline players
 * can be ranked and sent: "statistics:m:<id>" holds their name and a summary for
 * the boards, and each group of numbers is saved as JSON in pieces under
 * "statistics:d:<id>:<group>:<piece>" (Minecraft keeps at most 32 KB a value).
 * A player is keyed by player.id, as Leaderboards did, or by "n:<name>" when
 * they came from mcBedrock before ever joining here.
 */

const META = "statistics:m:";
const DATA = "statistics:d:";
const STATE = "statistics:state";
const PIECE = 12000;
const MAX_PENDING = 400;

const records = new Map();
let seq = 0;

function read(key) {
  try { return world.getDynamicProperty(key); } catch { return undefined; }
}
function write(key, value) {
  try { world.setDynamicProperty(key, value); return true; } catch { return false; }
}
function parse(raw, fallback) {
  try { return raw === undefined ? fallback : JSON.parse(String(raw)); } catch { return fallback; }
}

/** The record for this id, read from the world the first time. */
function record(id, name) {
  let rec = records.get(id);
  if (!rec) {
    const meta = parse(read(META + id), null) ?? { n: name ?? "Unknown", k: {} };
    meta.k ??= {};
    rec = { id, meta, data: null, dirty: new Set(), metaDirty: false, pending: new Map(), full: !!meta.f };
    for (const [group, path] of Array.isArray(meta.p) ? meta.p : []) mark(rec, group, path);
    records.set(id, rec);
  }
  if (name && rec.meta.n !== name) { rec.meta.n = name; rec.metaDirty = true; }
  return rec;
}

/** Its numbers, read the first time they're needed. */
function numbers(rec) {
  if (rec.data) return rec.data;
  rec.data = {};
  GROUPS.forEach((group, index) => {
    const pieces = rec.meta.k[index] ?? 0;
    let json = "";
    for (let i = 0; i < pieces; i++) json += String(read(`${DATA}${rec.id}:${index}:${i}`) ?? "");
    rec.data[group] = withDefaults(DEFAULTS[group], pieces ? parse(json, {}) : {});
  });
  return rec.data;
}

function save(rec) {
  if (rec.data) {
    for (const group of rec.dirty) {
      const index = GROUPS.indexOf(group);
      const json = JSON.stringify(rec.data[group]);
      const pieces = Math.max(1, Math.ceil(json.length / PIECE));
      for (let i = 0; i < pieces; i++) write(`${DATA}${rec.id}:${index}:${i}`, json.slice(i * PIECE, (i + 1) * PIECE));
      for (let i = pieces; i < (rec.meta.k[index] ?? 0); i++) write(`${DATA}${rec.id}:${index}:${i}`, undefined);
      rec.meta.k[index] = pieces;
    }
    if (rec.dirty.size) rec.meta.s = summary(rec.data);
  }
  rec.dirty.clear();
  // What hasn't reached BedrockRelay yet survives a restart; too much of it, and everything goes next time.
  rec.meta.f = rec.full ? 1 : undefined;
  rec.meta.p = rec.full ? undefined : [...rec.pending.values()].map(({ group, path }) => [group, path]);
  write(META + rec.id, JSON.stringify(rec.meta));
  rec.metaDirty = false;
}

let saving = false;
function saveAll() {
  if (saving) return;
  saving = true;
  try {
    for (const rec of records.values()) if (rec.dirty.size || rec.metaDirty) save(rec);
  } finally {
    saving = false;
  }
}

/** Every player ever counted, offline ones included. */
function everyone() {
  for (const key of safeIds()) if (key.startsWith(META)) record(key.slice(META.length));
  return [...records.values()];
}
function safeIds() {
  try { return world.getDynamicPropertyIds(); } catch { return []; }
}

/* ================================ Changing numbers ================================ */

/** A path as a list of keys: "kills.mobs.total", or a list when a key is a name. */
const steps = (path) => (Array.isArray(path) ? path : String(path).split("."));
const keyOf = (group, path) => `${group}\u0000${path.join("\u0000")}`;

function mark(rec, group, path) {
  if (rec.full) return;
  rec.pending.set(keyOf(group, path), { group, path, seq: ++seq });
  if (rec.pending.size > MAX_PENDING) { rec.full = true; rec.pending.clear(); }
  rec.metaDirty = true;
}

function parentOf(rec, group, path) {
  let node = numbers(rec)[group];
  for (const key of path.slice(0, -1)) {
    if (!isObject(node[key])) node[key] = {};
    node = node[key];
  }
  return node;
}

function change(rec, group, rawPath, update) {
  const path = steps(rawPath);
  const parent = parentOf(rec, group, path);
  const last = path[path.length - 1];
  const before = parent[last];
  const after = update(before);
  if (after === before) return before;
  parent[last] = after;
  rec.dirty.add(group);
  mark(rec, group, path);
  return after;
}

// BedrockRelay's own bot on a Realm carries this tag: it isn't a player, so it's never counted or ranked.
const BOT_TAG = "bedrockrelay:bot";
const isBot = (player) => { try { return player.hasTag(BOT_TAG); } catch { return false; } };

/** The record of a player we count, or null (the bot, a simulated player, anything else). */
function counted(player) {
  if (!player || player.typeId !== "minecraft:player") return null;
  try { if (!player.isValid) return null; } catch { return null; }
  if (isBot(player)) return null;
  const rec = record(player.id, player.name);
  return rec.meta.b ? null : rec;
}

function add(player, group, path, amount = 1) {
  const rec = counted(player);
  if (!rec || !Number.isFinite(amount) || amount === 0) return 0;
  return change(rec, group, path, (value) => (Number(value) || 0) + amount);
}
function set(player, group, path, value) {
  const rec = counted(player);
  if (rec) change(rec, group, path, () => value);
}
function most(player, group, path, value) {
  const rec = counted(player);
  if (rec) change(rec, group, path, (current) => Math.max(Number(current) || 0, value));
}
function least(player, group, path, value) {
  const rec = counted(player);
  if (rec) change(rec, group, path, (current) => Math.min(Number(current) || 0, value));
}
function include(player, group, path, item) {
  const rec = counted(player);
  if (rec) change(rec, group, path, (list) => (Array.isArray(list) ? (list.includes(item) ? list : [...list, item]) : [item]));
}
function value(player, group, path) {
  const rec = counted(player);
  if (!rec) return undefined;
  const at = steps(path);
  return parentOf(rec, group, at)[at[at.length - 1]];
}

/* ================================ The bot ================================ */

/**
 * A Realm owner can lend their own account as the bot for a while, then play on
 * it again: a minute without the tag makes them a player again, with what they'd
 * counted before. A minute, because our bot is untagged for its first few seconds.
 */
const untaggedSince = new Map();
function checkBot(player, now) {
  const rec = record(player.id, player.name);
  if (isBot(player)) {
    untaggedSince.delete(player.id);
    if (!rec.meta.b) { rec.meta.b = 1; rec.metaDirty = true; }
    return;
  }
  if (!rec.meta.b) return;
  const since = untaggedSince.get(player.id) ?? now;
  untaggedSince.set(player.id, since);
  if (now - since < 60_000) return;
  delete rec.meta.b;
  rec.metaDirty = true;
  untaggedSince.delete(player.id);
}

/* ================================ Trackers ================================ */

// Ported from BedrockStatistics' trackers, with every category switched on.

const subscribe = (signal, handler) => {
  try { signal?.subscribe((event) => { try { handler(event); } catch { /* one odd event never stops the rest */ } }); } catch { /* not in this version */ }
};
const after = world.afterEvents;

/* ---- Players: sessions, time, XP, life, sleep, dimensions ---- */

const MILESTONE_HOURS = [10, 25, 50, 100, 250, 500, 1000];
const xpSeen = new Map();
const sleeping = new Set();

function joined(player) {
  const rec = counted(player);
  if (!rec) return;
  adoptSeeded(rec, player.name);
  const now = Date.now();
  add(player, CORE, "sessions.total");
  set(player, CORE, "time.session", 0);
  set(player, CORE, "time.sessionStart", now);
  if (!value(player, CORE, "time.firstJoined")) set(player, CORE, "time.firstJoined", now);
  try { xpSeen.set(player.id, player.getTotalXp()); } catch { xpSeen.set(player.id, 0); }
}

subscribe(after.playerSpawn, ({ player, initialSpawn }) => { if (initialSpawn) joined(player); });
subscribe(after.playerLeave, ({ playerId }) => {
  xpSeen.delete(playerId);
  sleeping.delete(playerId);
  lastPosition.delete(playerId);
  untaggedSince.delete(playerId);
  const rec = records.get(playerId);
  if (rec) save(rec);
});
subscribe(after.playerDimensionChange, ({ player, fromDimension, toDimension }) => {
  add(player, TRAVEL, "portals.total");
  add(player, TRAVEL, ["portals", "transitions", `${dimensionOf(fromDimension.id)}_to_${dimensionOf(toDimension.id)}`]);
});

const SECOND = 20;
function everySecond() {
  const now = Date.now();
  for (const player of world.getAllPlayers().filter(Boolean)) {
    try {
      checkBot(player, now);
      if (!counted(player)) continue;
      const played = add(player, CORE, "time.played", SECOND);
      add(player, CORE, "time.session", SECOND);
      add(player, CORE, "time.sinceRest", SECOND);
      add(player, CORE, "time.sinceDeath", SECOND);
      add(player, CORE, ["dimensions", dimensionOf(player.dimension.id)], SECOND);
      if (player.isSneaking) add(player, CORE, "time.sneakTime", SECOND);
      most(player, CORE, "life.longest", add(player, CORE, "life.current", SECOND));
      xp(player);
      sleep(player);
      milestone(player, played);
    } catch { /* gone mid-loop */ }
  }
}

function xp(player) {
  try {
    const total = player.getTotalXp();
    const before = xpSeen.get(player.id) ?? total;
    if (total > before) add(player, CORE, "xp.total", total - before);
    xpSeen.set(player.id, total);
    set(player, CORE, "xp.current", total);
    set(player, CORE, "xp.level", player.level);
    most(player, CORE, "xp.highest", player.level);
  } catch { /* no XP here */ }
}

function sleep(player) {
  let now = false;
  try { now = player.isSleeping; } catch { return; }
  if (!now) return sleeping.delete(player.id);
  set(player, CORE, "time.sinceRest", 0);
  if (!sleeping.has(player.id)) { sleeping.add(player.id); add(player, CORE, "sleep.total"); }
}

const passed = (playedTicks) => MILESTONE_HOURS.filter((hours) => playedTicks >= hours * 3600 * SECOND).pop() ?? 0;

/** Hours brought in from elsewhere (Leaderboards, mcBedrock) were never played here: their milestones are passed, not announced. */
function milestonesPassed(rec) {
  const reached = passed(Number(numbers(rec)[CORE].time.played) || 0);
  if (reached > (rec.meta.mh ?? 0)) { rec.meta.mh = reached; rec.metaDirty = true; }
}

/** Playtime milestones go to the channels the owner picked for this plugin. A new install counts from zero, so old history is never announced. */
function milestone(player, playedTicks) {
  const rec = counted(player);
  if (!rec) return;
  const reached = passed(playedTicks);
  if (!reached || reached <= (rec.meta.mh ?? 0)) return;
  rec.meta.mh = reached;
  rec.metaDirty = true;
  postToDiscord({
    plugin: ID,
    embed: { color: 0xfee75c, author: { name: player.name, player: player.name }, description: `🎉 **${player.name}** has played for **${reached} hours**!` },
  });
}

/* ---- Combat ---- */

const ENVIRONMENTAL = new Set([
  "fall", "lava", "fire", "drown", "starve", "suffocate", "void", "wither", "lightning", "freeze", "magma",
  "flyIntoWall", "fireworks", "campfire", "stalactite", "stalagmite", "unknown", "anvil", "cactus", "explosion",
  "thorns", "sonicBoom", "entityExplosion", "blockExplosion", "magic", "contact", "cramming", "dragonBreath",
  "hotFloor", "inWall", "outOfWorld", "piston", "selfDestruct", "fireTick", "drowning", "suffocation", "fallingBlock",
]);

function causeOf(source) {
  const damager = source?.damagingEntity;
  if (damager) return damager.typeId === "minecraft:player" ? "player" : clean(damager.typeId);
  return source?.cause ? clean(source.cause) : "unknown";
}

subscribe(after.entityDie, ({ deadEntity, damageSource }) => {
  const killer = damageSource?.damagingEntity;
  if (deadEntity?.typeId === "minecraft:player") {
    const cause = causeOf(damageSource);
    add(deadEntity, CORE, "deaths.total");
    set(deadEntity, CORE, "deaths.lastCause", cause);
    set(deadEntity, CORE, "deaths.lastTime", Date.now());
    add(deadEntity, COMBAT, "deaths.total");
    add(deadEntity, COMBAT, ["deaths", "causes", cause]);
    if (cause === "player") add(deadEntity, COMBAT, "deaths.byPlayer");
    else if (!ENVIRONMENTAL.has(cause)) add(deadEntity, COMBAT, "deaths.byMob");
    set(deadEntity, CORE, "time.sinceDeath", 0);
    set(deadEntity, CORE, "life.current", 0);
  }
  if (killer?.typeId !== "minecraft:player" || killer === deadEntity) return;
  if (deadEntity?.typeId === "minecraft:player") {
    add(killer, COMBAT, "kills.players.total");
    add(killer, COMBAT, ["kills", "players", "byPlayer", deadEntity.name || "Unknown"]);
  } else {
    add(killer, COMBAT, "kills.mobs.total");
    add(killer, COMBAT, ["kills", "mobs", "byType", clean(deadEntity?.typeId)]);
  }
});

subscribe(after.entityHurt, ({ hurtEntity, damageSource, damage }) => {
  // Tenths of a heart, as Java Edition counts them.
  const amount = Math.round(damage * 10);
  const damager = damageSource?.damagingEntity;
  if (hurtEntity?.typeId === "minecraft:player") {
    add(hurtEntity, COMBAT, "damage.taken.total", amount);
    if (!damager) add(hurtEntity, COMBAT, "damage.taken.environmental", amount);
    else add(hurtEntity, COMBAT, damager.typeId === "minecraft:player" ? "damage.taken.fromPlayers" : "damage.taken.fromMobs", amount);
  }
  if (damager?.typeId === "minecraft:player") {
    add(damager, COMBAT, "damage.dealt.total", amount);
    add(damager, COMBAT, hurtEntity?.typeId === "minecraft:player" ? "damage.dealt.toPlayers" : "damage.dealt.toMobs", amount);
  }
});

// A projectile stopped by a raised shield fires no hurt event, only this.
subscribe(after.projectileHitEntity, (event) => {
  const player = event.getEntityHit()?.entity;
  if (player?.typeId !== "minecraft:player" || !player.isSneaking) return;
  const equipment = player.getComponent("equippable");
  const shield = ["Mainhand", "Offhand"].some((slot) => equipment?.getEquipment(slot)?.typeId === "minecraft:shield");
  if (shield) add(player, COMBAT, "damage.blocked.projectiles");
});

/* ---- Blocks ---- */

const TOOLS = ["_shovel", "_pickaxe", "_axe", "_hoe", "_sword"];
const isTool = (typeId) => TOOLS.some((part) => typeId.includes(part)) || typeId === "minecraft:shears" || typeId === "minecraft:flint_and_steel";

subscribe(after.playerBreakBlock, ({ player, brokenBlockPermutation, itemStackBeforeBreak }) => {
  add(player, BLOCKS, "mined.total");
  add(player, BLOCKS, ["mined", "byType", clean(brokenBlockPermutation.type.id)]);
  if (itemStackBeforeBreak && isTool(itemStackBeforeBreak.typeId)) used(player, itemStackBeforeBreak.typeId);
});

const placedJustNow = new Map();
subscribe(after.playerPlaceBlock, ({ player, block }) => {
  placedJustNow.set(`${player.id}:${block.typeId}`, Date.now());
  add(player, BLOCKS, "placed.total");
  add(player, BLOCKS, ["placed", "byType", clean(block.typeId)]);
});

/* ---- Items ---- */

function used(player, typeId, amount = 1) {
  add(player, ITEMS, "used.total", amount);
  add(player, ITEMS, ["used", "byType", clean(typeId)], amount);
}

const FOOD = new Set([
  "beef", "porkchop", "chicken", "mutton", "rabbit", "cod", "salmon", "cooked_beef", "cooked_porkchop", "cooked_chicken",
  "cooked_mutton", "cooked_rabbit", "cooked_cod", "cooked_salmon", "apple", "golden_apple", "enchanted_golden_apple",
  "melon_slice", "sweet_berries", "glow_berries", "carrot", "golden_carrot", "potato", "baked_potato", "poisonous_potato",
  "beetroot", "chorus_fruit", "bread", "cookie", "pumpkin_pie", "mushroom_stew", "beetroot_soup", "rabbit_stew",
  "suspicious_stew", "dried_kelp", "rotten_flesh", "spider_eye", "tropical_fish", "pufferfish", "honey_bottle", "milk_bucket",
]);

subscribe(after.itemCompleteUse, ({ source, itemStack }) => {
  if (!itemStack?.typeId) return;
  used(source, itemStack.typeId);
  if (FOOD.has(clean(itemStack.typeId))) {
    add(source, ITEMS, "food.total");
    add(source, ITEMS, ["food", "byType", clean(itemStack.typeId)]);
  }
});
subscribe(after.itemReleaseUse, ({ source, itemStack }) => { if (itemStack?.typeId) used(source, itemStack.typeId); });

const ON_PRESS = new Set(["minecraft:fishing_rod", "minecraft:carrot_on_a_stick", "minecraft:warped_fungus_on_a_stick", "minecraft:elytra", "minecraft:turtle_helmet"]);
const isArmour = (typeId) => ["_helmet", "_chestplate", "_leggings", "_boots"].some((part) => typeId.includes(part));
subscribe(after.itemStartUse, ({ source, itemStack }) => {
  const typeId = itemStack?.typeId;
  if (typeId && (ON_PRESS.has(typeId) || isArmour(typeId))) used(source, typeId);
});

subscribe(after.entityItemPickup, ({ entity, items }) => {
  if (entity?.typeId !== "minecraft:player") return;
  for (const stack of Array.from(items ?? [])) {
    if (!stack?.typeId) continue;
    add(entity, ITEMS, "picked.total", stack.amount || 1);
    add(entity, ITEMS, ["picked", "byType", clean(stack.typeId)], stack.amount || 1);
  }
});
subscribe(after.entityItemDrop, ({ entity, items }) => {
  if (entity?.typeId !== "minecraft:player") return;
  for (const item of Array.from(items ?? [])) {
    const stack = item?.getComponent?.("minecraft:item")?.itemStack;
    if (!stack?.typeId) continue;
    add(entity, ITEMS, "dropped.total", stack.amount || 1);
    add(entity, ITEMS, ["dropped", "byType", clean(stack.typeId)], stack.amount || 1);
  }
});

// A tool or piece of armour that vanished from a slot while all but worn out has broken.
subscribe(after.playerInventoryItemChange, ({ player, beforeItemStack, itemStack }) => {
  if (!beforeItemStack || itemStack) return;
  const durability = beforeItemStack.getComponent("durability");
  if (!durability || durability.damage < durability.maxDurability - 2) return;
  add(player, COMBAT, "tools.totalBroken");
  add(player, COMBAT, ["tools", "byType", clean(beforeItemStack.typeId)]);
});

/* ---- Interactions ---- */

const shulkers = ["", "white_", "orange_", "magenta_", "light_blue_", "yellow_", "lime_", "pink_", "gray_", "light_gray_", "cyan_", "purple_", "blue_", "brown_", "green_", "red_", "black_", "undyed_"];
const coppers = ["", "exposed_", "weathered_", "oxidized_", "waxed_", "waxed_exposed_", "waxed_weathered_", "waxed_oxidized_"];
const BLOCK_USES = {
  chest: "chest", trapped_chest: "trappedChest", ender_chest: "enderChest", barrel: "barrel",
  ...Object.fromEntries(coppers.map((prefix) => [`${prefix}copper_chest`, "copperChest"])),
  ...Object.fromEntries(shulkers.map((prefix) => [`${prefix}shulker_box`, "shulkerBox"])),
  crafting_table: "craftingTable", furnace: "furnace", lit_furnace: "furnace", blast_furnace: "blastFurnace",
  lit_blast_furnace: "blastFurnace", smoker: "smoker", lit_smoker: "smoker", brewing_stand: "brewingStand",
  enchanting_table: "enchantingTable", anvil: "anvil", chipped_anvil: "anvil", damaged_anvil: "anvil",
  grindstone: "grindstone", stonecutter: "stonecutter", stonecutter_block: "stonecutter",
  cartography_table: "cartographyTable", loom: "loom", smithing_table: "smithingTable",
  beacon: "beacon", lectern: "lectern", jukebox: "jukebox", noteblock: "noteblock.played", bell: "bell",
  campfire: "campfire", soul_campfire: "campfire", cauldron: "cauldron.used", water_cauldron: "cauldron.used",
  lava_cauldron: "cauldron.used", powder_snow_cauldron: "cauldron.used", cake: "cake",
  dispenser: "dispenser", dropper: "dropper", hopper: "hopper", crafter: "crafter",
};
const PLANTS = new Set([
  "oak_sapling", "spruce_sapling", "birch_sapling", "jungle_sapling", "acacia_sapling", "dark_oak_sapling", "cherry_sapling",
  "mangrove_propagule", "red_mushroom", "brown_mushroom", "crimson_fungus", "warped_fungus", "cactus", "bamboo", "dead_bush",
  "dandelion", "poppy", "blue_orchid", "allium", "azure_bluet", "red_tulip", "orange_tulip", "white_tulip", "pink_tulip",
  "oxeye_daisy", "cornflower", "lily_of_the_valley", "wither_rose", "torchflower", "fern", "azalea", "flowering_azalea",
]);

function cauldron(player, item) {
  if (item === "water_bucket") return add(player, INTERACTIONS, "cauldron.filled");
  if (item === "glass_bottle") return add(player, INTERACTIONS, "cauldron.bottleFilled");
  if (item.startsWith("leather_")) return add(player, INTERACTIONS, "cauldron.armorCleaned");
  if (item.endsWith("banner")) return add(player, INTERACTIONS, "cauldron.bannerCleaned");
  if (item.endsWith("shulker_box")) return add(player, INTERACTIONS, "cauldron.shulkerCleaned");
}

/*
 * Containers that really opened, from Minecraft itself (stable 2.10.0): no guess
 * from a click that opened nothing. On BDS 1.26.51 that's chests (trapped, ender,
 * copper), shulker boxes and crafting tables; every other block is still counted
 * from the player using it.
 */
const OPENS = (type) => type === "chest" || type === "trapped_chest" || type === "ender_chest" || type === "crafting_table"
  || type.endsWith("shulker_box") || type.endsWith("copper_chest");
subscribe(after.blockContainerOpened, ({ block, openSource }) => {
  const type = clean(block.typeId);
  if (OPENS(type) && BLOCK_USES[type]) add(openSource?.entity, INTERACTIONS, BLOCK_USES[type]);
});

/** Chests on things that move: minecarts, boats, and donkeys, mules and llamas. */
const ENTITY_CHESTS = {
  "minecraft:chest_minecart": "minecartChest", "minecraft:chest_boat": "boatChest",
  "minecraft:donkey": "animalChest", "minecraft:mule": "animalChest", "minecraft:llama": "animalChest", "minecraft:trader_llama": "animalChest",
};
subscribe(after.entityContainerOpened, ({ entity, openSource }) => {
  if (ENTITY_CHESTS[entity?.typeId]) add(openSource?.entity, INTERACTIONS, ENTITY_CHESTS[entity.typeId]);
});

subscribe(after.entityTamed, ({ tamingEntity }) => add(tamingEntity, INTERACTIONS, "animals.tamed"));

subscribe(after.playerInteractWithBlock, ({ player, block, itemStack }) => {
  // Placing a block fires this too: not an interaction.
  const placed = placedJustNow.get(`${player.id}:${block.typeId}`);
  if (placed && Date.now() - placed < 500) return placedJustNow.delete(`${player.id}:${block.typeId}`);
  const type = clean(block.typeId);
  const item = itemStack ? clean(itemStack.typeId) : "";
  if (BLOCK_USES[type] && !OPENS(type)) add(player, INTERACTIONS, BLOCK_USES[type]);
  if (type.includes("cauldron") && item) cauldron(player, item);
  if (type === "jukebox" && item.startsWith("music_disc_")) add(player, INTERACTIONS, "musicDisc.played");
  if (type === "flower_pot" && PLANTS.has(item)) add(player, INTERACTIONS, "flowerPot.planted");
  // Items used on blocks: bone meal, flint and steel, buckets, spawn eggs, cocoa.
  if (item === "bone_meal" || item === "flint_and_steel" || item === "cocoa_beans" || item.includes("bucket") || item.includes("spawn_egg")) used(player, itemStack.typeId);
});

subscribe(after.playerInteractWithEntity, ({ player, target }) => {
  if (target?.typeId === "minecraft:villager_v2" || target?.typeId === "minecraft:wandering_trader") add(player, INTERACTIONS, "villager.talked");
});

const distanceSquared = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
function nearestPlayer(entity, range, also = () => true) {
  let best = null;
  let bestDistance = Infinity;
  for (const player of entity.dimension.getPlayers({ location: entity.location, maxDistance: range }).filter(Boolean)) {
    const d = distanceSquared(player.location, entity.location);
    if (d < bestDistance && also(player)) { best = player; bestDistance = d; }
  }
  return best;
}

/* ---- Spawns: babies bred, things thrown, fishing ---- */

const THROWN = {
  "minecraft:ender_pearl": "minecraft:ender_pearl", "minecraft:eye_of_ender_signal": "minecraft:ender_eye",
  "minecraft:snowball": "minecraft:snowball", "minecraft:egg": "minecraft:egg", "minecraft:splash_potion": "minecraft:splash_potion",
  "minecraft:lingering_potion": "minecraft:lingering_potion", "minecraft:xp_bottle": "minecraft:experience_bottle",
};
const CATCHES = new Set([
  "cod", "salmon", "pufferfish", "tropical_fish", "bow", "enchanted_book", "fishing_rod", "name_tag", "nautilus_shell", "saddle",
  "leather_boots", "stick", "string", "bowl", "tripwire_hook", "rotten_flesh", "bone", "ink_sac", "water_bottle",
]);
const hooks = new Map();

subscribe(after.entitySpawn, ({ entity, cause }) => {
  const type = entity?.typeId;
  if (!type) return;
  if (THROWN[type]) {
    const owner = entity.getComponent("minecraft:projectile")?.owner;
    if (owner?.typeId === "minecraft:player") used(owner, THROWN[type]);
    return;
  }
  if (type === "minecraft:fishing_hook") return fishingHook(entity);
  if (type === "minecraft:item") return fishingCatch(entity);
  if (cause !== mc.EntityInitializationCause?.Born || type === "minecraft:slime" || type === "minecraft:magma_cube") return;
  const age = entity.getComponent("minecraft:ageable")?.age;
  if (age !== undefined && age >= 0) return;
  const breeder = nearestPlayer(entity, 10);
  if (breeder) add(breeder, INTERACTIONS, "animals.bred");
});

function fishingHook(hook) {
  // Bedrock doesn't give a hook its owner: the nearest player holding a rod cast it.
  const fisher = nearestPlayer(hook, 16, (player) => {
    try { return player.getComponent("minecraft:inventory")?.container?.getItem(player.selectedSlotIndex)?.typeId === "minecraft:fishing_rod"; } catch { return false; }
  });
  if (!fisher) return;
  const id = hook.id;
  const entry = { location: hook.location, playerId: fisher.id };
  entry.watch = system.runInterval(() => {
    const now = world.getEntity(id);
    if (now) { entry.location = now.location; return; }
    system.clearRun(entry.watch);
    system.runTimeout(() => hooks.delete(id), 10);
  }, 5);
  system.runTimeout(() => { system.clearRun(entry.watch); hooks.delete(id); }, 1200);
  hooks.set(id, entry);
}

function fishingCatch(item) {
  const stack = item.getComponent("minecraft:item")?.itemStack;
  if (!stack || !CATCHES.has(clean(stack.typeId))) return;
  for (const [id, hook] of hooks) {
    if (distanceSquared(item.location, hook.location) > 4) continue;
    const player = world.getEntity(hook.playerId);
    if (player) add(player, MISC, "fishing.caught");
    system.clearRun(hook.watch);
    hooks.delete(id);
    return;
  }
}

/* ---- Other: effects, emotes, raids, targets ---- */

subscribe(after.effectAdd, ({ entity, effect }) => {
  if (entity?.typeId !== "minecraft:player") return;
  const type = clean(effect.typeId);
  add(entity, MISC, "effects.total");
  add(entity, MISC, ["effects", "byType", type]);
  include(entity, MISC, "effects.unique", type);
  // Hero of the Village from winning a raid lasts 40 minutes.
  if (effect.typeId === "minecraft:village_hero" && effect.duration > 46800) add(entity, MISC, "raids.won");
});
subscribe(after.playerEmote, ({ player }) => add(player, MISC, "emotes.total"));
subscribe(after.dataDrivenEntityTrigger, ({ entity, eventId }) => {
  if (entity?.typeId === "minecraft:player" && eventId === "minecraft:remove_raid_trigger") add(entity, MISC, "raids.triggered");
});
subscribe(after.targetBlockHit, ({ source, redstonePower }) => {
  const player = source?.typeId === "minecraft:player" ? source : source?.getComponent?.("minecraft:projectile")?.owner;
  if (player?.typeId !== "minecraft:player") return;
  add(player, MISC, "targetBlock.hit");
  if (redstonePower === 15) add(player, MISC, "targetBlock.bullseye");
});

/* ---- Movement: every five seconds ---- */

const FIVE_SECONDS = 100;
const VEHICLES = {
  "minecraft:boat": "boat", "minecraft:chest_boat": "boat", "minecraft:minecart": "minecart", "minecraft:chest_minecart": "minecart",
  "minecraft:hopper_minecart": "minecart", "minecraft:tnt_minecart": "minecart", "minecraft:command_block_minecart": "minecart",
  "minecraft:horse": "horse", "minecraft:skeleton_horse": "horse", "minecraft:zombie_horse": "horse", "minecraft:donkey": "donkey",
  "minecraft:mule": "mule", "minecraft:pig": "pig", "minecraft:strider": "strider", "minecraft:camel": "camel",
  "minecraft:llama": "llama", "minecraft:trader_llama": "llama", "minecraft:happy_ghast": "happyGhast",
  "minecraft:nautilus": "nautilus", "minecraft:zombie_nautilus": "nautilus",
};
const CLIMBABLE = ["ladder", "vine", "scaffolding"];
const lastPosition = new Map();

subscribe(after.playerButtonInput, ({ player, button, newButtonState }) => {
  if (button !== mc.InputButton?.Jump || newButtonState !== mc.ButtonState?.Pressed) return;
  if (player.isFlying || player.isGliding || player.isSwimming) return;
  add(player, CORE, "movement.jumped");
});

function everyFiveSeconds() {
  for (const player of world.getAllPlayers().filter(Boolean)) {
    try {
      if (!counted(player)) continue;
      travel(player);
      const { x, y, z } = player.location;
      most(player, CORE, "coordinates.highest", Math.floor(y));
      least(player, CORE, "coordinates.lowest", Math.floor(y));
      most(player, CORE, "coordinates.furthest", Math.floor(Math.sqrt(x * x + z * z)));
      const biome = player.dimension.getBiome?.(player.location);
      if (biome) {
        include(player, CORE, "biomes.discovered", clean(biome.id));
        add(player, CORE, ["biomes", "timeIn", clean(biome.id)], FIVE_SECONDS);
      }
    } catch { /* gone mid-loop */ }
  }
}

function travel(player) {
  const here = { ...player.location, dimension: player.dimension.id };
  const before = lastPosition.get(player.id);
  lastPosition.set(player.id, here);
  if (!before || before.dimension !== here.dimension) return;
  const dx = here.x - before.x;
  const dy = here.y - before.y;
  const dz = here.z - before.z;
  const moved = dx * dx + dy * dy + dz * dz;
  // Over 400 blocks in five seconds is a teleport, not travel (an ice boat manages about 360).
  if (moved < 0.0001 || moved > 400 * 400) return;
  // Centimetres, as Java Edition counts them.
  const across = Math.round(Math.sqrt(dx * dx + dz * dz) * 100);
  const up = Math.round(Math.abs(dy) * 100);
  const vehicle = player.getComponent("minecraft:riding")?.entityRidingOn;
  if (vehicle && VEHICLES[vehicle.typeId]) {
    add(player, TRAVEL, ["vehicles", VEHICLES[vehicle.typeId], "distance"], across);
    add(player, TRAVEL, ["vehicles", VEHICLES[vehicle.typeId], "time"], FIVE_SECONDS);
    return;
  }
  if (player.isGliding) add(player, TRAVEL, "distance.flown", across);
  else if (player.isSwimming) add(player, TRAVEL, "distance.swum", across);
  else if (player.isInWater && !player.isOnGround) add(player, TRAVEL, "distance.underWater", across);
  else if (player.isSprinting) add(player, TRAVEL, "distance.sprinted", across);
  else if (player.isSneaking) add(player, TRAVEL, "distance.crouched", across);
  else if (player.isOnGround) add(player, TRAVEL, "distance.walked", across);
  if (dy < -0.5 && !player.isGliding && !player.isFlying) add(player, TRAVEL, "distance.fallen", up);
  if (dy > 0.1) {
    const block = player.dimension.getBlock({ x: Math.floor(here.x), y: Math.floor(here.y), z: Math.floor(here.z) });
    if (CLIMBABLE.some((part) => (block?.typeId ?? "").includes(part))) {
      add(player, TRAVEL, "distance.climbed", up);
      add(player, CORE, "movement.climbed", up);
    }
  }
}

/* ================================ Boards ================================ */

const sum = (values) => values.reduce((total, item) => total + (Number(item) || 0), 0);
const travelled = (data) => sum(Object.values(data[TRAVEL].distance)) - (Number(data[TRAVEL].distance.fallen) || 0)
  + sum(Object.values(data[TRAVEL].vehicles).map((vehicle) => vehicle?.distance));

/** What the boards rank, kept with the player's name so offline players rank without reading all their numbers. */
function summary(data) {
  return {
    pt: data[CORE].time.played,
    d: data[CORE].deaths.total,
    k: data[COMBAT].kills.mobs.total,
    pk: data[COMBAT].kills.players.total,
    bm: data[BLOCKS].mined.total,
    bp: data[BLOCKS].placed.total,
    dist: travelled(data),
    j: data[CORE].movement.jumped,
    br: data[INTERACTIONS].animals.bred,
    bio: data[CORE].biomes.discovered.length,
  };
}

const whole = (number) => String(Math.floor(Number(number) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const duration = (ticks) => {
  const seconds = Math.floor((Number(ticks) || 0) / SECOND);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${whole(h)} h ${m} min` : `${m} min`;
};
const distance = (cm) => {
  const metres = (Number(cm) || 0) / 100;
  return metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.floor(metres)} m`;
};
const pretty = (type) => String(type).split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");

/** Each board: its key in the summary, its name, and how to show a value. Leaderboards' seven come first, with their names. */
const STATS = {
  playtime: { key: "pt", name: "Playtime", show: duration },
  deaths: { key: "d", name: "Deaths", show: whole },
  kills: { key: "k", name: "Mobs killed", show: whole },
  pvp: { key: "pk", name: "Players killed", show: whole },
  mined: { key: "bm", name: "Blocks mined", show: whole },
  placed: { key: "bp", name: "Blocks placed", show: whole },
  distance: { key: "dist", name: "Distance travelled", show: distance },
  jumps: { key: "j", name: "Jumps", show: whole },
  bred: { key: "br", name: "Animals bred", show: whole },
  biomes: { key: "bio", name: "Biomes discovered", show: whole },
};

const ranked = (stat) => everyone()
  .filter((rec) => !rec.meta.b && (rec.meta.s?.[stat.key] ?? 0) > 0)
  .sort((a, b) => b.meta.s[stat.key] - a.meta.s[stat.key]);
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const byName = (name) => everyone().find((rec) => !rec.meta.b && same(rec.meta.n, name));

/* ================================ In game ================================ */

/*
 * The menu, laid out as BedrockStatistics' is: a page per category with coloured
 * headings, a "•" line per number, rates and shares, and a detailed page with every
 * block, mob and item. Without its resource pack there are no icons.
 */

/** A form, shown again while the player still has chat open from typing the command. */
async function show(form, player) {
  for (let tries = 0; tries < 40; tries++) {
    const response = await form.show(player);
    if (response.cancelationReason !== FormCancelationReason.UserBusy) return response;
    await new Promise((resolve) => system.runTimeout(resolve, 5));
  }
  return { canceled: true };
}

/** Looking at someone else's numbers is for operators: game directors and up. */
function isDirector(player) {
  try {
    if (player.commandPermissionLevel >= (mc.CommandPermissionLevel?.GameDirectors ?? 1)) return true;
  } catch { /* not in this version */ }
  try { return player.playerPermissionLevel >= (mc.PlayerPermissionLevel?.Operator ?? 2); } catch { return false; }
}

// BedrockStatistics' formatters. By hand: the game's JavaScript has no locale data.
const time = (ticks) => {
  const total = Math.floor((Number(ticks) || 0) / SECOND);
  if (total <= 0) return "0s";
  if (total < 60) return `${total}s`;
  if (total < 3600) { const m = Math.floor(total / 60); const s = total % 60; return s ? `${m}m ${s}s` : `${m}m`; }
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
};
const blocksOf = (cm) => {
  const blocks = (Number(cm) || 0) / 100;
  if (blocks <= 0) return "0 blocks";
  return blocks < 1000 ? `${blocks.toFixed(1)} blocks` : `${(blocks / 1000).toFixed(2)} km`;
};
const heartsOf = (tenths) => {
  const value = (Number(tenths) || 0) / 10;
  return value < 10 ? value.toFixed(1) : whole(value);
};
const perHour = (count, ticks) => {
  const hours = (Number(ticks) || 0) / SECOND / 3600;
  return !count || hours < 0.01 ? "0/hr" : `${(count / hours).toFixed(1)}/hr`;
};
// "%%": a form's text treats a single % as the start of a placeholder.
const share = (value, total) => (total ? `${((value / total) * 100).toFixed(1)}%%` : "0.0%%");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const date = (ms) => {
  if (!ms) return "Unknown";
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
};
const entries = (map) => Object.entries(map ?? {}).filter(([, n]) => Number(n) > 0).sort((a, b) => b[1] - a[1]);
const DEATH_CAUSES = {
  fall: "Fall Damage", drowning: "Drowning", drown: "Drowning", lava: "Lava", fire: "Fire", fireTick: "Fire", fire_tick: "Fire",
  suffocation: "Suffocation", void: "The Void", outOfWorld: "The Void", starve: "Starvation", magic: "Magic", wither: "Wither Effect",
  anvil: "Falling Anvil", fallingBlock: "Falling Block", thorns: "Thorns", flyIntoWall: "Kinetic Energy", freeze: "Freezing",
  lightning: "Lightning", entityExplosion: "Explosion", blockExplosion: "Explosion", projectile: "Projectile", player: "Player Attack",
};
const cause = (type) => DEATH_CAUSES[type] ?? pretty(type);

/** A page's text: headings, "•" lines, and indented "-" lines under them. */
const heading = (colour, text) => `§${colour}- ${text} -§r\n`;
const item = (label, value, colour = "e", after = "") => `§7• §f${label}: §${colour}${value}${after ? ` ${after}` : ""}§r\n`;
const sub = (label, value, colour = "e") => `§8    - §f${label}: §${colour}${value}§r\n`;
const tops = (map, count, colour, name = pretty) => entries(map).slice(0, count).map(([type, n]) => sub(name(type), whole(n), colour)).join("");

function generalPage(data) {
  const core = data[CORE];
  const played = core.time.played;
  const deaths = core.deaths.total;
  const kills = data[COMBAT].kills.mobs.total;
  return "§l§6- General Statistics -§r\n\n"
    + heading("e", "Time")
    + item("Time Played", time(played), "a")
    + item("Sessions", whole(core.sessions.total))
    + item("First Joined", date(core.time.firstJoined), "b")
    + item("Current Life", time(core.life.current), "a")
    + item("Longest Life", time(core.life.longest), "6") + "\n"
    + heading("a", "Experience")
    + item("Total XP Collected", whole(core.xp.total), "a")
    + item("Current Level", whole(core.xp.level))
    + item("Highest Level", whole(core.xp.highest), "6") + "\n"
    + heading("b", "Quick Stats")
    + item("Deaths", whole(deaths), "c", `§8(${perHour(deaths, played)})`)
    + item("Mob Kills", whole(kills), "e", `§8(${perHour(kills, played)})`)
    + item("Blocks Mined", whole(data[BLOCKS].mined.total))
    + item("Blocks Placed", whole(data[BLOCKS].placed.total), "a")
    + item("Food Consumed", whole(data[ITEMS].food.total), "d");
}

function combatPage(data) {
  const { kills, damage, deaths } = data[COMBAT];
  const played = data[CORE].time.played;
  const topMobs = tops(kills.mobs.byType, 5, "e");
  const topPlayers = tops(kills.players.byPlayer, 5, "c", (name) => name);
  const topCauses = tops(deaths.causes, 5, "c", cause);
  return "§l§c- Combat Statistics -§r\n\n"
    + heading("c", "Kills")
    + item("Mob Kills", whole(kills.mobs.total), "e", `§8(${perHour(kills.mobs.total, played)})`)
    + (topMobs ? "§7  Top Mobs:§r\n" + topMobs : "")
    + item("Player Kills", whole(kills.players.total), "c")
    + (topPlayers ? "§7  Top Players:§r\n" + topPlayers : "") + "\n"
    + heading("6", "Damage")
    + item("Dealt", heartsOf(damage.dealt.total), "e", "§7hearts")
    + `§8    To Mobs: ${heartsOf(damage.dealt.toMobs)}§r\n`
    + `§8    To Players: ${heartsOf(damage.dealt.toPlayers)}§r\n`
    + item("Taken", heartsOf(damage.taken.total), "c", "§7hearts")
    + `§8    From Mobs: ${heartsOf(damage.taken.fromMobs)}§r\n`
    + `§8    From Players: ${heartsOf(damage.taken.fromPlayers)}§r\n`
    + `§8    Environmental: ${heartsOf(damage.taken.environmental)}§r\n`
    + item("Projectiles Blocked", whole(damage.blocked?.projectiles), "a") + "\n"
    + heading("4", "Deaths")
    + item("Total", whole(deaths.total), "c", `§8(${perHour(deaths.total, played)})`)
    + item("By Mob", whole(deaths.byMob), "c")
    + item("By Player", whole(deaths.byPlayer), "c")
    + (topCauses ? "§7  Top Causes:§r\n" + topCauses : "");
}

function buildingPage(data) {
  const { mined, placed } = data[BLOCKS];
  const use = data[INTERACTIONS];
  return "§l§6- Building Statistics -§r\n\n"
    + heading("e", "Blocks Mined") + item("Total", whole(mined.total)) + tops(mined.byType, 8, "e") + "\n"
    + heading("a", "Blocks Placed") + item("Total", whole(placed.total), "a") + tops(placed.byType, 8, "a") + "\n"
    + heading("d", "Workstation Usage")
    + item("Crafting Tables", whole(use.craftingTable)) + item("Furnaces", whole(use.furnace)) + item("Blast Furnaces", whole(use.blastFurnace))
    + item("Smokers", whole(use.smoker)) + item("Anvils", whole(use.anvil)) + item("Enchanting Tables", whole(use.enchantingTable), "d")
    + item("Brewing Stands", whole(use.brewingStand), "d") + item("Grindstones", whole(use.grindstone)) + item("Stonecutters", whole(use.stonecutter))
    + item("Looms", whole(use.loom)) + item("Cartography Tables", whole(use.cartographyTable)) + item("Smithing Tables", whole(use.smithingTable))
    + item("Beacons", whole(use.beacon), "b") + item("Campfires", whole(use.campfire), "6") + item("Lecterns", whole(use.lectern)) + "\n"
    + heading("c", "Redstone Components")
    + item("Hoppers", whole(use.hopper)) + item("Droppers", whole(use.dropper)) + item("Dispensers", whole(use.dispenser)) + item("Crafters", whole(use.crafter));
}

const VEHICLE_NAMES = { happyGhast: "Happy Ghast" };
function explorationPage(data) {
  const { distance: by, vehicles, portals } = data[TRAVEL];
  const core = data[CORE];
  const methods = [
    ["Walking", by.walked], ["Sprinting", by.sprinted], ["Crouching", by.crouched], ["Swimming", by.swum],
    ["Under Water", by.underWater], ["Flying (Elytra)", by.flown], ["Climbing", by.climbed],
  ];
  const onFoot = sum(methods.map(([, cm]) => cm));
  const rides = Object.entries(vehicles).filter(([, ride]) => ride?.distance > 0);
  const riding = sum(rides.map(([, ride]) => ride.distance));
  const dims = [["Overworld", core.dimensions.overworld], ["Nether", core.dimensions.nether], ["The End", core.dimensions.the_end]].filter(([, t]) => t > 0);
  const inDims = sum(dims.map(([, t]) => t));
  const found = core.biomes.discovered;
  const inBiomes = sum(Object.values(core.biomes.timeIn));
  const biomes = found.map((name) => [name, core.biomes.timeIn[name] ?? 0]).sort((a, b) => b[1] - a[1]);
  return "§l§b- Exploration Statistics -§r\n\n"
    + heading("b", "Travel Stats")
    + item("Total Distance", blocksOf(onFoot + riding), "a")
    + item("Highest Point", whole(core.coordinates.highest), "e", "§7Y")
    + item("Lowest Point", String(Math.floor(core.coordinates.lowest)), "e", "§7Y")
    + item("Furthest from Spawn", whole(core.coordinates.furthest), "b", "§7blocks") + "\n"
    + heading("e", "Travel Methods")
    + methods.filter(([, cm]) => cm > 0).map(([label, cm]) => item(label, blocksOf(cm), "b", `§8(${share(cm, onFoot)})`)).join("")
    + (by.fallen > 0 ? item("Fallen", blocksOf(by.fallen), "c") : "") + "\n"
    + (rides.length ? heading("9", "Vehicle Travel") + rides.map(([name, ride]) =>
      item(VEHICLE_NAMES[name] ?? pretty(name), `${time(ride.time)} §7- §b${blocksOf(ride.distance)}`, "a", `§8(${share(ride.distance, riding)})`)).join("") + "\n" : "")
    + (dims.length ? heading("5", "Dimension Time") + dims.map(([name, t]) => item(name, time(t), "a", `§8(${share(t, inDims)})`)).join("") + "\n" : "")
    + heading("2", "Biomes Discovered")
    + item("Total Discovered", String(found.length), "a")
    + biomes.slice(0, 6).map(([name, t]) => (t > 0 ? sub(pretty(name), `${time(t)} §8(${share(t, inBiomes)})`, "a") : sub(pretty(name), "discovered", "7"))).join("")
    + (found.length > 6 ? `§8    ...and ${found.length - 6} more§r\n` : "") + "\n"
    + heading("d", "Portal Usage") + item("Total Transitions", whole(portals.total), "d") + "\n"
    + heading("f", "Movement") + item("Jumps", whole(core.movement.jumped));
}

function survivalPage(data) {
  const items = data[ITEMS];
  const use = data[INTERACTIONS];
  const misc = data[MISC];
  const core = data[CORE];
  const tools = data[COMBAT].tools;
  return "§l§a- Survival Statistics -§r\n\n"
    + heading("a", "Food Consumed") + item("Total", whole(items.food.total), "a") + tops(items.food.byType, 5, "a") + "\n"
    + heading("e", "Items")
    + item("Used", whole(items.used.total)) + tops(items.used.byType, 5, "e")
    + item("Picked Up", whole(items.picked.total), "b") + tops(items.picked.byType, 3, "b")
    + item("Dropped", whole(items.dropped.total), "c") + tops(items.dropped.byType, 3, "c") + "\n"
    + heading("5", "Status Effects")
    + item("Total Applied", whole(misc.effects.total), "d") + item("Unique Effects", String(misc.effects.unique.length), "a")
    + tops(misc.effects.byType, 5, "d") + "\n"
    + heading("6", "Containers Opened")
    + item("Chests", whole(use.chest)) + item("Ender Chests", whole(use.enderChest), "d") + item("Copper Chests", whole(use.copperChest), "6")
    + item("Barrels", whole(use.barrel)) + item("Shulker Boxes", whole(use.shulkerBox), "d") + item("Trapped Chests", whole(use.trappedChest), "c")
    + item("Minecart Chests", whole(use.minecartChest)) + item("Boat Chests", whole(use.boatChest)) + item("Animal Chests", whole(use.animalChest)) + "\n"
    + heading("5", "Tools Broken") + item("Total", whole(tools.totalBroken)) + tops(tools.byType, 5, "e") + "\n"
    + heading("9", "Sleep") + item("Times Slept", whole(core.sleep.total), "b") + item("Time Since Rest", time(core.time.sinceRest));
}

function miscPage(data) {
  const misc = data[MISC];
  const use = data[INTERACTIONS];
  return "§l§d- Miscellaneous Statistics -§r\n\n"
    + heading("e", "Emotes") + item("Total Used", whole(misc.emotes.total)) + "\n"
    + heading("d", "Interactions")
    + item("Bells Rung", whole(use.bell)) + item("Cake Slices Eaten", whole(use.cake), "d") + item("Villagers Talked To", whole(use.villager.talked), "a")
    + item("Animals Bred", whole(use.animals.bred), "a") + item("Animals Tamed", whole(use.animals.tamed), "a")
    + item("Plants Potted", whole(use.flowerPot.planted), "a") + item("Note Blocks Played", whole(use.noteblock.played), "b")
    + item("Music Discs Played", whole(use.musicDisc.played), "d") + item("Target Blocks Hit", whole(misc.targetBlock.hit))
    + item("Bullseyes", whole(misc.targetBlock.bullseye), "6") + "\n"
    + heading("b", "Fishing") + item("Fish Caught", whole(misc.fishing?.caught), "b") + "\n"
    + heading("3", "Cauldron Usage")
    + item("Total Used", whole(use.cauldron.used), "b") + item("Filled (Water Bucket)", whole(use.cauldron.filled), "b")
    + item("Bottles Filled", whole(use.cauldron.bottleFilled), "b") + item("Armor Cleaned", whole(use.cauldron.armorCleaned))
    + item("Banners Cleaned", whole(use.cauldron.bannerCleaned)) + item("Shulkers Cleaned", whole(use.cauldron.shulkerCleaned), "d") + "\n"
    + heading("c", "Raids") + item("Triggered", whole(misc.raids.triggered), "c") + item("Won", whole(misc.raids.won), "a");
}

/** Every entry of some lists, under bold headings: the detailed pages. */
const everything = (lists, empty) => lists.map(([title, colour, map, valueColour, name = pretty]) => {
  const all = entries(map);
  return all.length ? `§l§${colour}- ${title} -§r\n` + all.map(([type, n]) => item(name(type), whole(n), valueColour)).join("") + "\n" : "";
}).join("") || `§7${empty}§r`;

const PAGES = [
  { title: "§6General", subtitle: "§8Time played, sessions, XP, deaths", page: generalPage },
  {
    title: "§cCombat", subtitle: "§8Kills, damage, deaths", page: combatPage,
    detail: (data) => everything([
      ["All Mob Kills", "c", data[COMBAT].kills.mobs.byType, "e"],
      ["All Player Kills", "c", data[COMBAT].kills.players.byPlayer, "c", (name) => name],
      ["All Death Causes", "4", data[COMBAT].deaths.causes, "c", cause],
    ], "No detailed combat data yet."),
  },
  {
    title: "§6Building", subtitle: "§8Blocks mined and placed", page: buildingPage,
    detail: (data) => everything([
      ["All Blocks Mined", "e", data[BLOCKS].mined.byType, "e"],
      ["All Blocks Placed", "a", data[BLOCKS].placed.byType, "a"],
    ], "No detailed building data yet."),
  },
  { title: "§bExploration", subtitle: "§8Distance, biomes, dimensions", page: explorationPage },
  {
    title: "§2Survival", subtitle: "§8Items, food, containers", page: survivalPage,
    detail: (data) => everything([
      ["All Food Consumed", "a", data[ITEMS].food.byType, "a"],
      ["All Items Used", "e", data[ITEMS].used.byType, "e"],
      ["All Items Picked Up", "b", data[ITEMS].picked.byType, "b"],
      ["All Items Dropped", "c", data[ITEMS].dropped.byType, "c"],
      ["All Status Effects", "5", data[MISC].effects.byType, "d"],
      ["All Tools Broken", "5", data[COMBAT].tools.byType, "e"],
    ], "No detailed survival data yet."),
  },
  { title: "§dMiscellaneous", subtitle: "§8Emotes, interactions, raids", page: miscPage },
];

const plainTitle = (page) => page.title.replace(/§./g, "");

async function open(player) {
  const director = isDirector(player);
  const form = new ActionFormData().title("§l§6Statistics")
    .body("§7Track your Minecraft journey!\n\n§fSelect a category to view detailed statistics.");
  for (const page of PAGES) form.button(`${page.title}\n${page.subtitle}`);
  form.button("§eTop Players\n§8Who leads in each statistic");
  if (director) form.button("§9Another Player\n§8Anyone's statistics (operators only)");
  const chosen = await show(form, player);
  if (chosen.canceled) return;
  const index = chosen.selection ?? -1;
  if (index < PAGES.length) return category(player, record(player.id, player.name), PAGES[index], () => open(player));
  if (index === PAGES.length) return top(player);
  if (director) return others(player);
}

/** One category of a player's numbers; Back goes to `back` (the menu, or that player's categories). */
async function category(player, rec, page, back) {
  const own = rec.id === player.id;
  const form = new ActionFormData().title(`§l${own ? "" : `${rec.meta.n} · `}${plainTitle(page)} Statistics`)
    .body(page.page(numbers(rec))).button("§3← Back");
  if (page.detail) form.button("§eView Detailed Stats\n§8Full breakdown of all items");
  const chosen = await show(form, player);
  if (chosen.canceled) return;
  if (chosen.selection === 1 && page.detail) return detail(player, rec, page, back);
  return back();
}

async function detail(player, rec, page, back) {
  const form = new ActionFormData().title(`§l${plainTitle(page)} - Detailed`).body(page.detail(numbers(rec))).button("§3← Back");
  const chosen = await show(form, player);
  if (!chosen.canceled) return category(player, rec, page, back);
}

/** Someone else's categories, for operators. */
async function pages(player, rec) {
  if (!isDirector(player)) return;
  const form = new ActionFormData().title(`§l${rec.meta.n}`);
  for (const page of PAGES) form.button(`${page.title}\n${page.subtitle}`);
  form.button("§3← Back");
  const chosen = await show(form, player);
  if (chosen.canceled) return;
  const page = PAGES[chosen.selection];
  return page ? category(player, rec, page, () => pages(player, rec)) : others(player);
}

async function top(player) {
  const all = Object.values(STATS);
  const form = new ActionFormData().title("§l§eTop Players");
  for (const stat of all) form.button(stat.name);
  form.button("§3← Back to Menu");
  const chosen = await show(form, player);
  if (chosen.canceled) return;
  const stat = all[chosen.selection];
  if (!stat) return open(player);
  const board = ranked(stat);
  const colours = ["6", "f", "c"];
  const lines = board.slice(0, 10).map((rec, index) => `§${colours[index] ?? "7"}${index + 1}. §f${rec.meta.n} §7- §e${stat.show(rec.meta.s[stat.key])}§r`);
  const mine = board.findIndex((rec) => rec.id === player.id);
  if (mine >= 10) lines.push(`\n§7You: §f#${mine + 1} §7- §e${stat.show(board[mine].meta.s[stat.key])}`);
  const view = new ActionFormData().title(`§l${stat.name}`).body(`§l§e- ${stat.name} -§r\n\n${lines.length ? lines.join("\n") : "§7Nobody yet."}`).button("§3← Back");
  const back = await show(view, player);
  if (!back.canceled) return top(player);
}

async function others(player) {
  if (!isDirector(player)) return;
  const people = everyone().filter((rec) => !rec.meta.b && rec.id !== player.id).sort((a, b) => (b.meta.s?.pt ?? 0) - (a.meta.s?.pt ?? 0)).slice(0, 40);
  if (!people.length) return player.sendMessage("§7[Statistics]§r Nobody else yet.");
  const form = new ActionFormData().title("§l§9Another Player");
  for (const rec of people) form.button(`${rec.meta.n}\n§8${time(rec.meta.s?.pt)} played`);
  form.button("§3← Back to Menu");
  const chosen = await show(form, player);
  if (chosen.canceled) return;
  const rec = people[chosen.selection];
  return rec ? pages(player, rec) : open(player);
}

/* ================================ Leaderboards' totals ================================ */

/**
 * Once per world: what the Leaderboards plugin counted, so nobody starts again
 * from zero. Both plugins key players by player.id. Its distance was every kind
 * of travel in metres; here it counts as walked.
 */
const LEADERBOARDS = "bedrockrelay:lb:";
function takeOverLeaderboards(state) {
  if (state.lb) return;
  for (const key of safeIds()) {
    if (!key.startsWith(LEADERBOARDS)) continue;
    const old = parse(read(key), null);
    if (!isObject(old)) continue;
    const rec = record(key.slice(LEADERBOARDS.length), old.n);
    if (old.bot) rec.meta.b = 1;
    if (old.mh) rec.meta.mh = Math.max(rec.meta.mh ?? 0, old.mh);
    const raise = (group, path, amount) => {
      if (Number(amount) > 0) change(rec, group, path, (current) => Math.max(Number(current) || 0, Math.floor(amount)));
    };
    raise(CORE, "time.played", (old.pt ?? 0) * SECOND);
    raise(CORE, "deaths.total", old.d);
    raise(COMBAT, "deaths.total", old.d);
    raise(COMBAT, "kills.mobs.total", old.k);
    raise(COMBAT, "kills.players.total", old.pk);
    raise(BLOCKS, "mined.total", old.bm);
    raise(BLOCKS, "placed.total", old.bp);
    raise(TRAVEL, "distance.walked", (old.dist ?? 0) * 100);
    milestonesPassed(rec);
  }
  state.lb = 1;
}

/* ================================ Sending to mcBedrock ================================ */

/*
 * Every five minutes, what changed goes to BedrockRelay with askRelay(), a few
 * players an ask, spread over the five minutes, one ask at a time. BedrockRelay
 * keeps it safely before answering { accepted: true }; only then does a change
 * stop waiting here. Any other answer, or none, and everything waits for the next
 * round. BedrockRelay may also ask for everything (resync), or first hand over
 * what mcBedrock already holds for this world (seed). The full set goes once a
 * day too, so the two sides never drift.
 */

const ROUND = 6000;
const ASK_SIZE = 8000;
const DAY = 24 * 60 * 60 * 1000;
let state = { lb: 0, lastFull: 0 };
let busy = false;
let linked = true;

const saveState = () => write(STATE, JSON.stringify(state));

/** A plain object of the current values at these paths, grouped as the numbers are. */
function changesOf(rec, entries) {
  const data = numbers(rec);
  const out = {};
  for (const { group, path } of entries) {
    let from = data[group];
    let to = (out[group] ??= {});
    for (let i = 0; i < path.length - 1 && isObject(from); i++) {
      from = from[path[i]];
      to = isObject(to[path[i]]) ? to[path[i]] : (to[path[i]] = {});
    }
    const last = path[path.length - 1];
    if (isObject(from) && from[last] !== undefined) to[last] = copy(from[last]);
  }
  return out;
}

const sizeOf = (value) => JSON.stringify(value).length;

/** Split a tree of numbers into trees of at most `limit` characters; merged back together, they're the whole. */
function split(tree, limit) {
  if (sizeOf(tree) <= limit) return [tree];
  const out = [];
  let current = {};
  for (const [key, item] of Object.entries(tree)) {
    const alone = { [key]: item };
    if (sizeOf(alone) > limit && isObject(item)) {
      for (const piece of split(item, limit - key.length - 8)) out.push({ [key]: piece });
      continue;
    }
    if (sizeOf({ ...current, ...alone }) > limit && Object.keys(current).length) { out.push(current); current = {}; }
    current[key] = item;
  }
  if (Object.keys(current).length) out.push(current);
  return out;
}

/** Asks of a few players each: [{ players: [{ name, changes }], entries: [{ rec, key, seq }] }], in order. */
function batch(items) {
  const asks = [];
  let current = { players: [], entries: [], size: 0 };
  for (const { rec, changes, entries } of items) {
    const pieces = split(changes, ASK_SIZE - 200);
    pieces.forEach((piece, index) => {
      const size = sizeOf(piece) + rec.meta.n.length + 30;
      if (current.players.length && current.size + size > ASK_SIZE) { asks.push(current); current = { players: [], entries: [], size: 0 }; }
      current.players.push({ name: rec.meta.n, changes: piece });
      // A player's changes stop waiting with their last piece: asks go in order, and stop at the first not kept.
      if (index === pieces.length - 1) current.entries.push(...entries);
      current.size += size;
    });
  }
  if (current.players.length) asks.push(current);
  return asks;
}

const ask = (question) => askRelay(ID, { v: 1, ...question });
const pause = (ticks) => new Promise((resolve) => system.runTimeout(resolve, ticks));

async function round() {
  if (busy) return;
  busy = true;
  try {
    saveAll();
    // Unlisted last time: a question with nothing in it first, so nothing is gathered just to be turned away.
    if (!linked && !handle(await ask({ full: false, players: [] }))) return;
    const everybody = everyone().filter((rec) => !rec.meta.b);
    if (Date.now() - state.lastFull > DAY) for (const rec of everybody) rec.full = true;
    const full = everybody.some((rec) => rec.full);
    if (full) await sendFull(everybody);
    else await sendChanges(everybody);
  } catch {
    // Relaying is off, the plugin is switched off, or no answer came: everything waits for the next round.
  } finally {
    busy = false;
  }
}

async function sendChanges(everybody) {
  const items = everybody.filter((rec) => rec.pending.size).map((rec) => {
    const entries = [...rec.pending.entries()].map(([key, entry]) => ({ rec, key, seq: entry.seq, group: entry.group, path: entry.path }));
    return { rec, changes: changesOf(rec, entries), entries };
  });
  const asks = batch(items);
  const gap = asks.length ? Math.max(10, Math.floor((ROUND * 0.8) / asks.length)) : 0;
  for (const { players, entries } of asks) {
    const answer = await ask({ full: false, players });
    if (!handle(answer)) return;
    for (const { rec, key, seq: sent } of entries) if (rec.pending.get(key)?.seq === sent) rec.pending.delete(key);
    for (const { rec } of entries) rec.metaDirty = true;
    await pause(gap);
  }
}

async function sendFull(everybody) {
  const started = seq;
  const items = everybody.map((rec) => ({ rec, changes: copy(numbers(rec)), entries: [] }));
  const asks = batch(items);
  const id = `f${Date.now().toString(36)}`;
  const gap = Math.max(10, Math.floor((ROUND * 0.8) / Math.max(1, asks.length)));
  for (let i = 0; i < asks.length; i++) {
    const answer = await ask({ full: true, fullId: id, part: i + 1, parts: asks.length, players: asks[i].players });
    if (!handle(answer)) return;
    await pause(gap);
  }
  // Every part kept: what changed since it began still waits.
  for (const rec of everybody) {
    rec.full = false;
    for (const [key, entry] of rec.pending) if (entry.seq <= started) rec.pending.delete(key);
    rec.metaDirty = true;
  }
  state.lastFull = Date.now();
  saveState();
}

/** Whether BedrockRelay kept what was sent; what else it says is acted on here. */
function handle(answer) {
  linked = answer?.linked !== false;
  if (answer?.resync) for (const rec of everyone()) rec.full = true;
  if (answer?.waiting === "seed") { void seed(); return false; }
  return answer?.accepted === true;
}

/* ---- Seeding: what mcBedrock already holds for this world ---- */

/*
 * A world whose listing on mcBedrock was fed before BedrockRelay gets those
 * numbers back first, merged in so nothing counted here is lost: the larger of
 * two counts, the lower of two lowest points, the earlier first join, both lists
 * together, and the seed's own value for what's only true now.
 */

const SEED_LATEST = new Set(["time.session", "time.sessionStart", "deaths.lastCause", "deaths.lastTime", "life.current", "xp.current", "xp.level"]);
let seeding = false;

function mergeSeed(mine, theirs, path = []) {
  if (!isObject(theirs)) return mine;
  const out = isObject(mine) ? mine : {};
  for (const [key, incoming] of Object.entries(theirs)) {
    const at = [...path, key];
    const name = at.join(".");
    const current = out[key];
    if (isObject(incoming)) out[key] = mergeSeed(current, incoming, at);
    else if (Array.isArray(incoming)) out[key] = [...new Set([...(Array.isArray(current) ? current : []), ...incoming])];
    else if (SEED_LATEST.has(name.replace(/^[^.]*\./, ""))) out[key] = incoming;
    else if (name.endsWith("time.firstJoined")) out[key] = current && incoming ? Math.min(current, incoming) : (current || incoming);
    else if (name.endsWith("coordinates.lowest")) out[key] = Math.min(Number(current) || 0, Number(incoming) || 0);
    else if (typeof incoming === "number") out[key] = Math.max(Number(current) || 0, incoming);
    else if (current === undefined || current === null) out[key] = incoming;
  }
  return out;
}

/** A seeded player who never joined here waits under their name until they do. */
function adoptSeeded(rec, name) {
  const waiting = records.get(`n:${String(name).toLowerCase()}`) ?? (read(`${META}n:${String(name).toLowerCase()}`) ? record(`n:${String(name).toLowerCase()}`) : null);
  if (!waiting || waiting === rec) return;
  const data = numbers(rec);
  const theirs = numbers(waiting);
  for (const group of GROUPS) { data[group] = mergeSeed(data[group], theirs[group], [group]); rec.dirty.add(group); }
  rec.meta.mh = Math.max(rec.meta.mh ?? 0, waiting.meta.mh ?? 0);
  milestonesPassed(rec);
  rec.full = true;
  for (let index = 0; index < GROUPS.length; index++) for (let i = 0; i < (waiting.meta.k[index] ?? 0); i++) write(`${DATA}${waiting.id}:${index}:${i}`, undefined);
  write(META + waiting.id, undefined);
  records.delete(waiting.id);
}

async function seed() {
  if (seeding) return;
  seeding = true;
  try {
    let cursor;
    for (let pages = 0; pages < 10_000; pages++) {
      const page = await ask({ seed: { cursor } });
      for (const player of Array.isArray(page?.players) ? page.players : []) {
        if (typeof player?.gamertag !== "string" || !isObject(player.stats)) continue;
        const rec = byName(player.gamertag) ?? record(`n:${player.gamertag.toLowerCase()}`, player.gamertag);
        const data = numbers(rec);
        for (const group of GROUPS) if (isObject(player.stats[group])) { data[group] = mergeSeed(data[group], player.stats[group], [group]); rec.dirty.add(group); }
        milestonesPassed(rec);
      }
      saveAll();
      if (page?.done || !page?.next) break;
      cursor = page.next;
      await pause(10);
    }
    // Everything merged goes back in full, which tells mcBedrock the seed is in.
    for (const rec of everyone()) rec.full = true;
    saveAll();
  } catch (error) {
    console.warn(`[Statistics] seeding paused: ${error?.message ?? error}`);
  } finally {
    seeding = false;
  }
}

/* ================================ Starting ================================ */

// Nothing here reads the world while it's still loading: that waits for the first tick.
system.run(() => {
  state = { ...state, ...parse(read(STATE), {}) };
  takeOverLeaderboards(state);
  saveState();
  for (const player of world.getAllPlayers().filter(Boolean)) {
    const rec = counted(player);
    if (!rec) continue;
    adoptSeeded(rec, player.name);
    try { xpSeen.set(player.id, player.getTotalXp()); } catch { /* no XP here */ }
  }
  saveAll();
  system.runInterval(everySecond, SECOND);
  system.runInterval(everyFiveSeconds, FIVE_SECONDS);
  system.runInterval(saveAll, 600);
  system.runInterval(() => { for (const [key, at] of placedJustNow) if (Date.now() - at > 5000) placedJustNow.delete(key); }, 1200);
  // The first round a minute in, so a resync or seed isn't kept waiting.
  system.runTimeout(() => { void round(); system.runInterval(() => void round(), ROUND); }, 1200);
});

/* ================================ Discord ================================ */

const MEDALS = ["🥇", "🥈", "🥉"];

export default {
  id: "statistics",
  name: "Statistics",
  version: "1.0.0",
  description: "Everything players do, from playtime and travel to blocks, kills and items, with top tens in Discord and a menu in game. Replaces Leaderboards.",
  posts: "Playtime milestones: when someone reaches 10, 25, 50, 100, 250, 500 or 1,000 hours.",
  menu: { name: "Statistics", command: "statistics", open },
  commands: [
    {
      name: "top",
      description: "The top ten players for one statistic",
      public: true,
      // live:True keeps it in the channel, updated every 10 minutes (the owner can change that).
      board: { every: 10 },
      options: [{
        name: "stat", type: "string", description: "Which statistic", required: true,
        choices: Object.entries(STATS).map(([value, stat]) => ({ name: stat.name, value })),
      }],
      run({ stat: which }, { linkedPlayer }) {
        const stat = STATS[which];
        if (!stat) return `Choose one of: ${Object.values(STATS).map((item) => item.name).join(", ")}.`;
        const board = ranked(stat);
        if (!board.length) return `Nobody has any ${stat.name.toLowerCase()} yet.`;
        const lines = board.slice(0, 10).map((rec, index) => `${MEDALS[index] ?? `\`${String(index + 1).padStart(2)}\``} **${rec.meta.n}** · ${stat.show(rec.meta.s[stat.key])}`);
        const mine = linkedPlayer ? board.findIndex((rec) => same(rec.meta.n, linkedPlayer)) : -1;
        if (mine >= 10) lines.push(`\nYou: #${mine + 1} · ${stat.show(board[mine].meta.s[stat.key])}`);
        return {
          embed: {
            color: 0xfee75c,
            title: `🏆 ${stat.name}`,
            description: lines.join("\n"),
            thumbnail: { player: board[0].meta.n },
            footer: { text: `${board.length} ${board.length === 1 ? "player" : "players"} on the board` },
          },
        };
      },
    },
    {
      name: "stats",
      description: "A player's numbers and where they rank",
      public: true,
      options: [{ name: "player", type: "player", description: "Who (leave empty for you, once you've used /relay link)", required: false }],
      run({ player }, { linkedPlayer }) {
        const name = player ?? linkedPlayer;
        if (!name) return "Say which player, or link your own with `/relay link` so this knows who you are.";
        const rec = byName(name);
        if (!rec || !rec.meta.s) return `No statistics for **${name}** yet.`;
        const fields = Object.values(STATS).map((stat) => {
          const amount = rec.meta.s[stat.key] ?? 0;
          const rank = amount > 0 ? ranked(stat).indexOf(rec) + 1 : 0;
          return { name: stat.name, value: `${stat.show(amount)}${rank ? ` · #${rank}` : ""}`, inline: true };
        });
        return { embed: { color: 0xfee75c, title: rec.meta.n, thumbnail: { player: rec.meta.n }, fields } };
      },
    },
  ],
};
