# Map

`/map [player]` draws the 128 × 128 blocks around a player the way an in-game
map does: each block's map colour, lighter or darker with the lie of the land,
deeper water darker. The player's head is in the middle, and anyone else in the
area is shown where they stand. North is at the top.

The answer is shown only to the person who asked, because a map can give away
where someone's base is. Keep the command to people you trust.

## Performance

A map is 16,384 columns, and each one is found by looking straight down from the
sky until something solid (or water) is hit. That's how the map shows tree
tops rather than the ground under them, but it's the most expensive part.

So the work is spread out:

- **256 columns per game tick.** On a test server that was a few milliseconds of
  each 50 ms tick, for about three seconds. A slower host takes longer, and
  a server that's already struggling will feel it more.
- **One map at a time**, and a 15-second pause after each one, so a busy channel
  can't keep the server drawing maps.
- Nothing runs until someone asks for a map. There's no background work.

If your server is often short of time already (below 20 TPS; the World plugin
shows it), keep `/map` to a few people.

## What gets drawn

Only chunks the server is ticking can be read, which depends on its
**simulation distance**. At the default of 4 chunks, that's roughly a circle of
128 blocks across around the player, and the corners are left as bare paper.
A higher simulation distance fills in more of the square.

In the Nether, the map looks down from just above the player, since the sky is
a bedrock roof.

## Requirements

Pack 0.4.0 or newer on a dedicated server. The picture is made by BedrockRelay
from the colours the plugin sends, so the plugin never handles images or links.
