# Entity scan for BedrockRelay

This plugin adds two Discord commands for a BedrockRelay-connected
Minecraft Bedrock server:

- `/entities <player> [chunks]` lists counts for every currently loaded entity
  type near an online player.
- `/lagcheck <player> [entity_type] [chunks]` shows a focused summary of
  dropped items, XP orbs, projectiles, primed TNT, falling blocks, vehicles,
  armor stands and villagers, plus up to 15 nearest non-player entities with world coordinates (X, Y, Z). With `entity_type`, it instead counts that type
  and lists its nearest loaded-entity coordinate snapshots.

`chunks` is a **radius** choice: 1 through 6 chunks (16 through 96
blocks). The scan is a 3D radius around the player, not a whole-world or exact
square-chunk count. It can only find entities in currently loaded areas.

For example, `/lagcheck Steve minecart` counts loaded minecarts near Steve and
lists up to 15 nearest coordinates. Common short names include `item`, `xp`,
`armorstand`, `minecart`, and `villager`; full IDs such as
`minecraft:chest_minecart` also work. Coordinates are a point-in-time snapshot
and may change before an administrator reaches them.

## Installation and access

1. Keep `plugin.js` and `plugin.json` together when adding this plugin to a
   BedrockRelay plugin folder or catalog repository. `plugin.json` supplies the
   catalog-facing ID, command list, compatibility and privacy metadata.
2. In the BedrockRelay dashboard, open **Plugins** and choose **Upload a
   plugin** under **Your own plugins**. Upload `plugin.js` from this folder,
   then install/enable it on the intended Minecraft server.
3. Use BedrockRelay's command/role controls to choose which Discord
   administrators or roles may run `/entities` and `/lagcheck`.

The plugin deliberately does not use `public: true`, so results are visible
only to the requester. BedrockRelay performs the Discord permission check
before the plugin's `run()` function is called; the plugin does not receive
Discord roles or tokens and cannot make a separate in-code role list.

The current file is version **1.1.2**. If an earlier version is already
installed, use **Upload new version**, install the update for the server, and
restart BDS.

## Safety and tuning

The default scan radius is 4 chunks (64 blocks), with a 6-chunk maximum for
servers using that render distance, and one scan for the server every 15
seconds. Edit these
constants at the top of `plugin.js` before uploading if needed:

```js
const DEFAULT_SCAN_CHUNKS = 4;
const MAX_SCAN_CHUNKS = 6;
const SCAN_COOLDOWN_MS = 15_000;
```

Use the 5- and 6-chunk choices only when needed. The Minecraft Script API has to collect all
matching loaded entities before the plugin can count them. A result is a useful
snapshot for diagnosing entity buildup; it is not proof that a listed entity
type is causing server lag.

The plugin contains no network requests, no server-secret access, and no
world-changing behavior.
