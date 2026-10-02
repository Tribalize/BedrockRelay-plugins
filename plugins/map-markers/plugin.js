import { system } from "@minecraft/server";
import { ActionFormData, FormCancelationReason, MessageFormData, ModalFormData } from "@minecraft/server-ui";
import { askRelay } from "../relay/api.js";

/**
 * Map markers: players put markers on the world's BedrockMap map from in game.
 * Type /relay, then add a marker where you stand (a name, a description and one
 * of the map's types), or delete one of your own.
 *
 * This file only draws the forms. BedrockRelay says what they show, in the
 * world's language, checks the map's rules and places or deletes the marker, so
 * the plugin never changes for any of that.
 */

const ask = (question) => askRelay("map-markers", question);

/** A form, shown again while the player still has chat open from typing /relay. */
async function show(form, player) {
  for (let tries = 0; tries < 40; tries++) {
    const response = await form.show(player);
    if (response.cancelationReason !== FormCancelationReason.UserBusy) return response;
    await new Promise((resolve) => system.runTimeout(resolve, 5));
  }
  return { canceled: true };
}

async function open(player) {
  const menu = await ask({ action: "menu", player: player.name });
  const { text } = menu;
  const form = new ActionFormData()
    .title(text.title)
    .body(`${text.body}\n§b${menu.mapUrl}§r${menu.why ? `\n\n§c${menu.why}` : ""}`)
    .button(menu.canPlace ? text.add : `§8${text.add}`)
    .button(text.mine)
    .button(text.close);
  const chosen = await show(form, player);
  if (chosen.canceled) return;
  if (chosen.selection === 0) return menu.canPlace ? add(player, menu) : player.sendMessage(`§c${menu.why}`);
  if (chosen.selection === 1) return mine(player, menu);
}

async function add(player, menu) {
  const { text } = menu;
  const form = new ModalFormData().title(text.addTitle)
    .textField(text.name, text.namePlaceholder)
    .textField(text.note, text.notePlaceholder);
  if (menu.types.length) form.dropdown(text.type, [text.typeNone, ...menu.types.map((type) => type.name)]);
  form.submitButton(text.submit);
  const filled = await show(form, player);
  if (filled.canceled) return;
  const [name, note, typeIndex] = filled.formValues;
  if (!String(name ?? "").trim()) return player.sendMessage(`§c${text.nameNeeded}`);
  // Where they stand as they press Add.
  const { x, y, z } = player.location;
  const type = typeIndex ? menu.types[typeIndex - 1]?.id : undefined;
  const result = await ask({ action: "place", player: player.name, name, note, type, x, y, z, dimension: player.dimension.id });
  player.sendMessage(`${result.placed ? "§a" : "§c"}${result.message}`);
}

async function mine(player, menu) {
  const { text } = menu;
  const form = new ActionFormData().title(text.mineTitle).body(menu.markers.length ? text.mineBody : text.none);
  for (const marker of menu.markers) form.button(`${marker.name}\n§8${marker.where}${marker.deletable ? "" : ` · ${text.websiteOnly}`}`);
  form.button(text.back);
  const chosen = await show(form, player);
  if (chosen.canceled) return;
  const marker = menu.markers[chosen.selection];
  if (!marker) return open(player);
  // Made on the website: deleted there, not here.
  if (!marker.deletable) return mine(player, menu);
  const sure = await show(new MessageFormData().title(text.deleteTitle).body(text.deleteBody.replace("{name}", marker.name))
    .button1(text.delete).button2(text.cancel), player);
  if (sure.canceled || sure.selection !== 0) return mine(player, menu);
  const result = await ask({ action: "remove", player: player.name, id: marker.id, name: marker.name });
  player.sendMessage(`${result.removed ? "§a" : "§c"}${result.message}`);
}

export default {
  id: "map-markers",
  name: "Map markers",
  version: "1.0.0",
  description: "Players put markers on your BedrockMap map from in game, with /relay.",
  menu: { name: "Map markers", open },
  commands: [],
};
