import { system, world } from "@minecraft/server";
import { findPlayer } from "../relay/api.js";

/**
 * Map — a BedrockRelay plugin.
 * /map draws the land around a player the way an in-game map does, with their
 * head in the middle and anyone else nearby where they stand.
 *
 * Reading 16,384 columns has a cost, so it's spread out: 256 per game tick
 * (a few milliseconds of each 50 ms tick, for about three seconds), one map at
 * a time, with a pause between maps. Only chunks the server is ticking can be
 * read, so how much is drawn depends on its simulation distance; the rest is
 * left as bare paper. The gateway turns the pixels into the picture.
 */

const SIZE = 128;
const BORDER = 4;
const PER_TICK = 256;
const COOLDOWN_MS = 15_000;
const BOT_TAG = "bedrockrelay:bot";

/* ---------------- Minecraft's map colours ---------------- */

const C = {
  grass: [127, 178, 56], sand: [247, 233, 163], wool: [199, 199, 199], fire: [255, 0, 0], ice: [160, 160, 255],
  metal: [167, 167, 167], plant: [0, 124, 0], snow: [255, 255, 255], clay: [164, 168, 184], dirt: [151, 109, 77],
  stone: [112, 112, 112], water: [64, 64, 255], wood: [143, 119, 72], quartz: [255, 252, 245], orange: [216, 127, 51],
  magenta: [178, 76, 216], light_blue: [102, 153, 216], yellow: [229, 229, 51], lime: [127, 204, 25], pink: [242, 127, 165],
  gray: [76, 76, 76], light_gray: [153, 153, 153], cyan: [76, 127, 153], purple: [127, 63, 178], blue: [51, 76, 178],
  brown: [102, 76, 51], green: [102, 127, 51], red: [153, 51, 51], black: [25, 25, 25], gold: [250, 238, 77],
  diamond: [92, 219, 213], lapis: [74, 128, 255], emerald: [0, 217, 58], podzol: [129, 86, 49], nether: [112, 2, 0],
  terracotta: [209, 177, 161], crimson_nylium: [189, 48, 49], crimson_stem: [148, 63, 97], warped_nylium: [22, 126, 134],
  warped_stem: [58, 142, 140], warped_wart: [20, 180, 133], deepslate: [100, 100, 100], tuff: [57, 41, 35],
};
const DYES = ["light_blue", "light_gray", "white", "orange", "magenta", "yellow", "lime", "pink", "gray", "cyan", "purple", "blue", "brown", "green", "red", "black"];
const WOODS = { pale_oak: "quartz", dark_oak: "brown", oak: "wood", spruce: "podzol", birch: "sand", jungle: "dirt", acacia: "orange", mangrove: "red", cherry: "terracotta", bamboo: "yellow", crimson: "crimson_stem", warped: "warped_stem" };

/** A block's map colour, by the same families the game uses. */
function colourOf(typeId) {
  const id = typeId.replace(/^minecraft:/, "");
  if (id === "waterlily") return C.plant;
  if (id.includes("water") || id === "bubble_column") return C.water;
  if (id.includes("lava") || id === "fire") return C.fire;
  if (id.includes("ice")) return C.ice;
  if (id.includes("snow")) return C.snow;
  if (id === "pale_oak_leaves") return C.light_gray;
  if (id === "cherry_leaves") return C.pink;
  if (id.endsWith("leaves") || id === "cactus" || id.includes("vine") || id.startsWith("azalea")) return C.plant;
  if (id === "grass_block" || id.startsWith("moss")) return C.grass;
  if (id === "pale_moss_block" || id === "pale_moss_carpet") return C.light_gray;
  if (id === "mycelium") return C.purple;
  if (id === "podzol") return C.podzol;
  if (id.includes("nylium")) return id.startsWith("warped") ? C.warped_nylium : C.crimson_nylium;
  if (id === "warped_wart_block") return C.warped_wart;
  if (id === "nether_wart_block") return C.red;
  for (const [wood, colour] of Object.entries(WOODS)) if (id.startsWith(wood + "_") || id === wood || id.startsWith("stripped_" + wood)) return C[colour];
  if (id.includes("red_sand")) return C.orange;
  if (id.includes("sand") && !id.includes("soul")) return C.sand;
  if (id.startsWith("soul")) return C.brown;
  for (const dye of DYES) if (id.startsWith(dye + "_")) return id.includes("terracotta") ? C[dye === "white" ? "terracotta" : dye].map((v) => Math.floor(v * 0.75)) : C[dye === "white" ? "snow" : dye];
  if (id.includes("terracotta")) return C.orange.map((v) => Math.floor(v * 0.8));
  if (id.includes("dirt") || id === "farmland" || id.includes("mud") || id === "granite" || id.includes("brown_mushroom")) return C.dirt;
  if (id.includes("red_mushroom")) return C.red;
  if (id === "clay") return C.clay;
  if (id.includes("deepslate")) return C.deepslate;
  if (id.includes("tuff")) return C.tuff;
  if (id.includes("netherrack") || id.includes("nether_brick") || id === "magma") return C.nether;
  if (id.includes("blackstone") || id.includes("basalt") || id === "obsidian") return C.black;
  if (id.includes("quartz") || id.includes("diorite") || id === "calcite") return C.quartz;
  if (id === "gold_block") return C.gold;
  if (id === "diamond_block") return C.diamond;
  if (id === "emerald_block") return C.emerald;
  if (id === "lapis_block") return C.lapis;
  if (id === "iron_block" || id.includes("anvil")) return C.metal;
  if (id === "end_stone" || id.includes("end_stone") || id === "glowstone") return C.sand;
  if (id.includes("pumpkin")) return C.orange;
  if (id.includes("melon")) return C.lime;
  if (id === "hay_block") return C.yellow;
  if (id.includes("glass")) return C.wool;
  return C.stone;
}

/* ---------------- Reading the land ---------------- */

const downward = { x: 0, y: -1, z: 0 };

/**
 * The first solid block looking straight down, or the water (or lava) over it,
 * and for water how deep it is. Rays treat liquids as passable, so a ray that
 * skips passable blocks goes straight through water even with
 * includeLiquidBlocks, and getTopmostBlock skips it too. So: find the floor,
 * and only if liquid sits on it (seagrass and kelp are waterlogged, not
 * liquid) look again for the surface.
 */
function column(dimension, x, z, fromY) {
  try {
    const start = { x: x + 0.5, y: fromY, z: z + 0.5 };
    const floor = dimension.getBlockFromRay(start, downward, { includeLiquidBlocks: false, includePassableBlocks: false, maxDistance: fromY + 70 })?.block;
    if (!floor?.typeId) return null;
    const y = floor.location.y;
    const above = dimension.getBlock({ x, y: y + 1, z });
    if (above && (above.isLiquid || above.isWaterlogged)) {
      const surface = dimension.getBlockFromRay(start, downward, { includeLiquidBlocks: true, includePassableBlocks: true, maxDistance: fromY - y })?.block;
      if (surface?.typeId && surface.location.y > y) {
        const id = surface.typeId;
        return { id, y: surface.location.y, depth: id.includes("water") ? surface.location.y - y : 0 };
      }
    }
    return { id: floor.typeId, y, depth: 0 };
  } catch {
    // Outside the chunks the server is ticking.
    return null;
  }
}

/** Every column of the square, PER_TICK at a time. */
function survey(dimension, left, top, fromY) {
  const cells = new Array(SIZE * SIZE);
  let i = 0;
  return new Promise((resolve) => {
    const job = system.runInterval(() => {
      for (let n = 0; n < PER_TICK && i < cells.length; n++, i++) cells[i] = column(dimension, left + (i % SIZE), top + Math.floor(i / SIZE), fromY);
      if (i < cells.length) return;
      system.clearRun(job);
      resolve(cells);
    }, 1);
  });
}

/* ---------------- Drawing ---------------- */

const PAPER = [222, 203, 160];
const FRAME = [196, 170, 120];
const EDGE = [120, 95, 60];
const SHADES = [180, 220, 255];

/** The game's shading: lighter than the block to the north if higher, darker if lower; water by depth. */
function shaded(cells, x, z) {
  const here = cells[z * SIZE + x];
  if (here.depth) {
    const d = here.depth * 0.1 + ((x + z) & 1) * 0.2;
    return colourOf(here.id).map((v) => Math.floor((v * SHADES[d < 0.5 ? 2 : d > 0.9 ? 0 : 1]) / 255));
  }
  const north = (z > 0 && cells[(z - 1) * SIZE + x]) || here;
  const d = here.y - north.y + (((x + z) & 1) - 0.5) * 0.4;
  return colourOf(here.id).map((v) => Math.floor((v * SHADES[d > 0.6 ? 2 : d < -0.6 ? 0 : 1]) / 255));
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)] + (b === undefined ? "=" : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]) + (c === undefined ? "=" : B64[c & 63]);
  }
  return out;
}

/** The map on a paper frame, as palette indices; the gateway makes the picture. */
function picture(cells) {
  const side = SIZE + BORDER * 2;
  const palette = [];
  const index = new Map();
  const colour = (rgb) => {
    const hex = "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");
    if (!index.has(hex)) { index.set(hex, palette.length); palette.push(hex); }
    return index.get(hex);
  };
  const data = new Uint8Array(side * side);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const edge = Math.min(x, y, side - 1 - x, side - 1 - y);
    const mx = x - BORDER, mz = y - BORDER;
    const inside = edge >= BORDER;
    data[y * side + x] = !inside ? colour(edge < 1 ? EDGE : FRAME) : cells[mz * SIZE + mx] ? colour(shaded(cells, mx, mz)) : colour(PAPER);
  }
  return { width: side, height: side, palette, data: base64(data) };
}

/* ---------------- The command ---------------- */

let busy = false;
let lastAt = 0;

const DIMENSIONS = { "minecraft:overworld": "Overworld", "minecraft:nether": "Nether", "minecraft:the_end": "End" };

export default {
  id: "map",
  name: "Map",
  version: "1.0.2",
  description: "A map of the land around a player, drawn like an in-game map, with their head in the middle.",
  privacy: "A map shows the land around a player, which can give away where their base is, so keep this to people you trust.",
  commands: [
    {
      name: "map",
      description: "A map of the area around a player",
      options: [{ name: "player", type: "player", description: "Who (leave empty for you, once you've used /relay link)", required: false }],
      async run({ player: name }, { linkedPlayer }) {
        const wanted = name ?? linkedPlayer;
        if (!wanted) return "Say which player, or link your own with `/relay link` so this knows who you are.";
        const player = findPlayer(wanted);
        if (!player || player.hasTag(BOT_TAG)) return `**${wanted}** isn't online right now.`;
        if (busy) return "A map is being drawn already. Try again in a few seconds.";
        const wait = Math.ceil((lastAt + COOLDOWN_MS - Date.now()) / 1000);
        if (wait > 0) return `Maps take a moment to draw, so there's a short pause between them. Try again in ${wait} s.`;

        busy = true;
        try {
          const dimension = player.dimension;
          const cx = Math.floor(player.location.x), cz = Math.floor(player.location.z);
          const left = cx - SIZE / 2, top = cz - SIZE / 2;
          // The Nether has a roof: look down from just above the player instead of from the sky.
          const fromY = dimension.id === "minecraft:nether" ? Math.min(126, Math.floor(player.location.y) + 4) : dimension.heightRange.max - 1;
          const cells = await survey(dimension, left, top, fromY);
          const drawn = cells.filter(Boolean).length;
          if (!drawn) return `Nothing around **${player.name}** could be read just now.`;

          // Everyone else in the square, where they stand; the player themselves in the middle.
          const markers = [{ x: BORDER + SIZE / 2, y: BORDER + SIZE / 2, player: player.name }];
          for (const other of dimension.getPlayers()) {
            if (!other || other.id === player.id || other.hasTag(BOT_TAG) || markers.length >= 10) continue;
            const mx = Math.floor(other.location.x) - left, mz = Math.floor(other.location.z) - top;
            if (mx >= 0 && mz >= 0 && mx < SIZE && mz < SIZE) markers.push({ x: BORDER + mx, y: BORDER + mz, player: other.name });
          }
          return {
            embed: {
              color: 0xc4aa78,
              title: `🗺️ Around ${player.name}`,
              description: `${DIMENSIONS[dimension.id] ?? dimension.id} · centred on ${cx}, ${cz}`,
              footer: { text: `${SIZE} × ${SIZE} blocks, north at the top${drawn < cells.length ? " · paper where the world isn't loaded" : ""}` },
              image: { pixels: { ...picture(cells), markers } },
            },
          };
        } finally {
          busy = false;
          lastAt = Date.now();
        }
      },
    },
  ],
};
