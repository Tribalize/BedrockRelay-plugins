import { system, world } from "@minecraft/server";

/**
 * World — a BedrockRelay plugin.
 * /world shows the state of the world: day, time, weather, moon, difficulty,
 * who's on and how the server is running. live: True keeps it in the channel,
 * updated every minute, with a countdown to nightfall or daybreak that Discord
 * ticks down by itself in between.
 */

// BedrockRelay's own bot on a Realm carries this tag: it isn't a player, so it's never counted.
const BOT_TAG = "bedrockrelay:bot";
const isBot = (player) => { try { return player.hasTag(BOT_TAG); } catch { return false; } };

// Numbered as the Script API numbers them.
const MOON = ["🌕 Full moon", "🌖 Waning gibbous", "🌓 First quarter", "🌘 Waning crescent", "🌑 New moon", "🌒 Waxing crescent", "🌗 Last quarter", "🌔 Waxing gibbous"];
const WEATHER = { Clear: "☀️ Clear", Rain: "🌧️ Rain", Thunder: "⛈️ Thunderstorm" };

/** Ticks per second, measured over the last ten seconds. 20 is a server keeping up. */
const samples = [];
let last = Date.now();
system.runInterval(() => {
  const now = Date.now();
  samples.push(Math.min(20, 20000 / Math.max(1, now - last)));
  if (samples.length > 10) samples.shift();
  last = now;
}, 20);
const tps = () => (samples.length ? samples.reduce((sum, value) => sum + value, 0) / samples.length : 20);

/**
 * The Overworld's weather. Dimension.getWeather() is in the beta API only, so a
 * Realm (no Beta APIs) doesn't have it: there, remember what the stable
 * weatherChange event last said, and until it says something, leave it out.
 */
let heardWeather = null;
world.afterEvents.weatherChange.subscribe(({ dimension, newWeather }) => {
  if (String(dimension).endsWith("overworld")) heardWeather = newWeather;
});
function weather() {
  const overworld = world.getDimension("minecraft:overworld");
  if (typeof overworld.getWeather === "function") {
    try { return overworld.getWeather(); } catch { /* fall back to what we heard */ }
  }
  return heardWeather;
}

function clock(ticks) {
  // Tick 0 is 6:00 in the morning.
  const minutes = Math.floor(((ticks / 1000 + 6) % 24) * 60);
  const phase = ticks < 12000 ? "Day" : ticks < 13000 ? "Sunset" : ticks < 23000 ? "Night" : "Sunrise";
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")} (${phase})`;
}

/**
 * When night falls (tick 13000) or day breaks (tick 0), as a Discord timestamp
 * that counts down by itself. Left out when time stands still or the server is
 * too slow for the estimate to mean anything. Sleeping or /time set make it
 * wrong only until the next refresh.
 */
function countdown(ticks, speed) {
  let cycle = true;
  try { cycle = world.gameRules.doDayLightCycle; } catch { /* assume it runs */ }
  if (!cycle || speed < 15) return null;
  const night = ticks < 13000;
  const left = night ? 13000 - ticks : 24000 - ticks;
  const at = Math.round((Date.now() + (left / speed) * 1000) / 1000);
  return { name: night ? "Night falls" : "Day breaks", value: `<t:${at}:R>`, inline: true };
}

export default {
  id: "world",
  name: "World",
  version: "1.1.0",
  description: "The state of the world: day, time, weather, moon, difficulty, who's on and server speed. Can stay in a channel, updated every minute.",
  commands: [
    {
      name: "world",
      description: "Day, time, weather and how the server is running",
      public: true,
      // live:True keeps it in the channel, updated every minute (the owner can change that).
      board: { every: 1 },
      options: [],
      run() {
        const ticks = world.getTimeOfDay();
        const speed = tps();
        const online = world.getAllPlayers().filter((player) => !isBot(player)).length;
        const fields = [
          { name: "Day", value: String(world.getDay()), inline: true },
          { name: "Time", value: clock(ticks), inline: true },
        ];
        const next = countdown(ticks, speed);
        if (next) fields.push(next);
        const now = weather();
        if (now) fields.push({ name: "Weather", value: WEATHER[now] ?? String(now), inline: true });
        fields.push(
          { name: "Moon", value: MOON[world.getMoonPhase()] ?? "Unknown", inline: true },
          { name: "Difficulty", value: String(world.getDifficulty()), inline: true },
          { name: "Players", value: String(online), inline: true },
          { name: "Server speed", value: `${speed >= 19 ? "🟢" : speed >= 15 ? "🟡" : "🔴"} ${speed.toFixed(1)} TPS`, inline: true },
        );
        return {
          embed: {
            color: 0x5865f2,
            title: "The world right now",
            fields,
          },
        };
      },
    },
  ],
};
