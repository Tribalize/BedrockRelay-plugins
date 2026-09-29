# Entity scan for BedrockRelay

This private plugin adds two Discord commands for a BedrockRelay-connected
Minecraft Bedrock server:

- `/entities <player> [chunks]` lists counts for every currently loaded entity
  type near an online player.
- `/lagcheck <player> [chunks]` shows a focused summary of dropped items, XP
  orbs, projectiles, vehicles, armor stands and villagers, plus the most common
  other entity types.

`chunks` is a **radius** choice: 1 through 6 chunks (16 through 96
blocks). The scan is a 3D radius around the player, not a whole-world or exact
square-chunk count. It can only find entities in currently loaded areas.

## Installation and access

1. In the BedrockRelay dashboard, open **Plugins** and choose **Upload a
   plugin** under **Your own plugins**.
2. Upload `plugin.js` from this folder, then install/enable it on the intended
   Minecraft server.
3. Use BedrockRelay's command/role controls to choose which Discord
   administrators or roles may run `/entities` and `/lagcheck`.

The plugin deliberately does not use `public: true`, so results are visible
only to the requester. BedrockRelay performs the Discord permission check
before the plugin's `run()` function is called; the plugin does not receive
Discord roles or tokens and cannot make a separate in-code role list.

The current file is version **1.0.1**. If version 1.0.0 is already installed,
use **Upload new version**, install the update for the server, and restart BDS.

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
