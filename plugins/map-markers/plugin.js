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

/** Where the player stands, for the gateway to put into words. */
const standing = (player) => ({ x: player.location.x, z: player.location.z, dimension: player.dimension.id });

/** A tooltip, when the gateway has one (gateways before these forms had none). */
const tip = (tooltip) => (tooltip ? { tooltip } : undefined);

async function open(player) {
  const menu = await ask({ action: "menu", player: player.name, ...standing(player) });
  const { text } = menu;
  const form = new ActionFormData().title(`§l${text.title}`).body(text.body);
  if (menu.mapUrl) form.label(`§7${text.mapLink ?? ""} §b${menu.mapUrl}`);
  if (menu.why) form.label(`§c${menu.why}`);
  form.divider()
    .button(menu.canPlace ? `§l§2${text.add}§r${menu.here ? `\n§8${menu.here}` : ""}` : `§8${text.add}`)
    .button(`§l§1${text.mine}§r${text.mineHint ? `\n§8${text.mineHint}` : ""}`)
    .button(`§8${text.close}`);
  const chosen = await show(form, player);
  if (chosen.canceled) return;
  if (chosen.selection === 0) return menu.canPlace ? add(player, menu) : player.sendMessage(`§c${menu.why}`);
  if (chosen.selection === 1) return mine(player, menu);
}

async function add(player, menu) {
  const { text } = menu;
  const form = new ModalFormData().title(`§l${text.addTitle}`)
    .textField(`§l${text.name}`, text.namePlaceholder, tip(text.nameTip))
    .textField(text.note, text.notePlaceholder, tip(text.noteTip));
  if (menu.types.length) form.dropdown(text.type, [text.typeNone, ...menu.types.map((type) => type.name)], tip(text.typeTip));
  // After the fields, so it can't move their place in formValues.
  if (menu.here && text.addHere) form.divider().label(`§7${text.addHere} §e${menu.here}`);
  form.submitButton(`§l§2${text.submit}`);
  const filled = await show(form, player);
  if (filled.canceled) return;
  const [name, note, typeIndex] = filled.formValues;
  if (!String(name ?? "").trim()) return player.sendMessage(`§c${text.nameNeeded}`);
  // Where they stand as they press Add.
  const { x, y, z } = player.location;
  const type = menu.types.length && typeIndex ? menu.types[typeIndex - 1]?.id : undefined;
  const result = await ask({ action: "place", player: player.name, name, note, type, x, y, z, dimension: player.dimension.id });
  player.sendMessage(`${result.placed ? "§a" : "§c"}${result.message}`);
}

async function mine(player, menu) {
  const { text } = menu;
  const form = new ActionFormData().title(`§l${text.mineTitle}`).body(menu.markers.length ? text.mineBody : text.none);
  if (menu.markers.length) form.divider();
  for (const marker of menu.markers) {
    form.button(marker.deletable ? `§l§0${marker.name}§r\n§8${marker.where}` : `§8${marker.name}\n§8${marker.where} · ${text.websiteOnly}`);
  }
  form.button(`§8${text.back}`);
  const chosen = await show(form, player);
  if (chosen.canceled) return;
  const marker = menu.markers[chosen.selection];
  if (!marker) return open(player);
  // Made on the website: deleted there, not here.
  if (!marker.deletable) return mine(player, menu);
  const sure = await show(new MessageFormData().title(`§l${text.deleteTitle}`).body(text.deleteBody.replace("{name}", `§e${marker.name}§r`))
    .button1(`§l§4${text.delete}`).button2(text.cancel), player);
  if (sure.canceled || sure.selection !== 0) return mine(player, menu);
  const result = await ask({ action: "remove", player: player.name, id: marker.id, name: marker.name });
  player.sendMessage(`${result.removed ? "§a" : "§c"}${result.message}`);
}

export default {
  id: "map-markers",
  name: "Map markers",
  version: "1.1.0",
  description: "Players put markers on your BedrockMap map from in game, with /relay.",
  menu: { name: "Map markers", open },
  commands: [],
};
