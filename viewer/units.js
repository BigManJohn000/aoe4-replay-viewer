"use strict";
// Unit classification shared by the viewer (model.js) and tools/convert.py, which parses the object below as JSON, so
// keep it plain JSON: double quotes, no comments or trailing commas inside.
// attachment: entities that are parts of others (weapons, projectiles, props, dummy placeholders, and siege_cart, the
// no-HP cart riding under every mangonel and bombard); checked before the building flag.
// rules: [pattern, category, icon type] for every other non-building blueprint, first match wins. Unmatched blueprints
// are category "unit" with no icon type. Categories decide army values, fight losses and what counts as army; icon types
// pick the map figure (map.js UNIT_TYPES). _viz_ are decorative entities such as Jin grassland horses; khan_hunter
// (the Mongol khan's summoned hunters) comes before livestock's "deer".
// military: the categories counted as army.
// tools/check_units.py compares the categories with aoe4world's unit classes (data.aoe4world.com).
window.RV_UNITS = {
  "attachment": "^wpn_|^projectile_|_prop$|_prop_|dummy|siege_cart",
  "rules": [
    ["falcon|_flag|marker|holy_site|_viz_|^resource_|bribe_obj", "other", null],
    ["khan_hunter", "cavalry", "horsearcher"],
    ["sheep|cattle|goat|pig|deer|boar|wolf|_ox|yak", "livestock", null],
    ["villager", "villager", "villager"],
    ["trade_ship", "econ", "ship"],
    ["fishing", "econ", "fishboat"],
    ["worker_elephant", "econ", "elephant"],
    ["trader|trade_cart|trade_camel|treasure_caravan|pilgrim", "econ", "trader"],
    ["_cart|official|emissary|yatai", "econ", null],
    ["ship|boat|galley|junk|dhow|hulk|carrack|baghlah|lodya|demolition|naval_", "ship", "ship"],
    ["elephant_ballista", "siege", "elephant"],
    ["elephant", "cavalry", "elephant"],
    ["khan|jeanne|hero|daimyo|leader|sultan|abbey_king", "hero", "hero"],
    ["_ram_|_ram$|battering", "siege", "ram"],
    ["handcannon|musket|janissary|streltsy|gunner|grenadier|ozutsu|eruptor", "ranged", "gun"],
    ["springald|mangonel|trebuchet|bombard|culverin|ribauldequin|cannon|siege|nest_of_bees|organ|catapult|bedcrossbow", "siege", "siege"],
    ["monk|prelate|imam|scholar|shaman|dervish|priest|abbess|shinto|buddhist|healer", "religious", "monk"],
    ["scout", "cavalry", "scout"],
    ["mohe|mangudai|horse_?archer|camel_archer|cavalry_archer|kipchak|genitour", "cavalry", "horsearcher"],
    ["teutonic_knight|knight_hospitaller|ghulam", "infantry", "sword"],
    ["knight|lancer|iron_pagoda|cataphract|keshik|sipahi|gendarme|cuirassier|chevalier|bodyguard|ming_guard", "cavalry", "knight"],
    ["horse|camel|cavalry|rider|raider|hobelar|mounted|mehter|mamluk|yuan_guard", "cavalry", "horseman"],
    ["spear|pike", "infantry", "spear"],
    ["manatarms|man_at_arms", "infantry", "maa"],
    ["crossbow|arbalet|zhuge", "ranged", "crossbow"],
    ["archer|longbow|yumi|slinger|javelin|yeoman|ranger|samurai_range|bow", "ranged", "archer"],
    ["maa|landsknecht|infantry|footman|samurai|ashigaru|warrior|varangian|limitanei|templar|sword|axe|militia|guard|onna_bugeisha|gbeto|rus_tribute|kharash|pirate|shinobi|condot|serjeant|musofadi|kanabo", "infantry", "sword"]
  ],
  "military": ["infantry", "ranged", "cavalry", "siege", "religious", "hero", "ship", "unit"]
};
