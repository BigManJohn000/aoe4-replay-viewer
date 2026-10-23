/**
 * core/analysis.js — panel queries over a core Replay: no Three.js, no DOM. Ported from the 2D viewer's app.js
 * (renderPlayers, techTable, the kill feed filter, jumpFight) so both viewers show the same numbers.
 */
import { idxAt } from './replay.js';

/** Banked (unspent) resources and population of a player at t, or null before their first stats sample. */
export function statsAt(R, idx, t) {
  const s = R.stats.get(idx);
  if (!s) return null;
  const i = idxAt(s.t, t);
  if (i < 0) return null;
  const r = s.rows[i];
  return { food: r[1], wood: r[2], gold: r[3], stone: r[4], pop: r[5] };
}

/**
 * Living villagers, military units and army value of a player at t from the converter's army series (one sample per
 * army.step seconds from 0, the last sample held to the end); null without a series. Missing values are undefined.
 */
export function armyAt(R, idx, t) {
  const a = R.army?.players?.[String(idx)];
  if (!a) return null;
  const k = Math.min(Math.floor(t / R.army.step), (a.military ?? []).length - 1);
  if (k < 0) return null;
  return { villagers: a.villagers?.[k], military: a.military?.[k], value: a.armyValue?.[k] };
}

/**
 * Age-ups and eco upgrades: one row per tech label in first-research order, with each player's first research time
 * (at: Map idx → t) and the earliest of them (best).
 */
export function techTable(R) {
  const rows = new Map();
  for (const [t, idx, label, kind] of R.techs) {
    if (!rows.has(label)) rows.set(label, { label, kind, at: new Map(), best: Infinity });
    const r = rows.get(label);
    if (!r.at.has(idx)) { r.at.set(idx, t); r.best = Math.min(r.best, t); }
  }
  return [...rows.values()];
}

/** Indices into R.kills of the latest kills up to t, newest first, leaving out livestock and attachments. */
export function killFeed(R, t, max) {
  const out = [];
  for (let i = idxAt(R.killT, t); i >= 0 && out.length < max; i--) {
    const v = R.byId.get(R.kills[i].victim);
    if (!v || v.cat === 'livestock' || v.cat === 'attachment') continue;
    out.push(i);
  }
  return out;
}

/**
 * The fight to jump to from t ([ / ] keys), for a viewer that shows a fight from `lead` seconds before its start.
 * Next: the first fight whose lead-in is still ahead (else the last). Previous: the last fight started more than 6 s
 * before t, so pressing it during a fight restarts that fight and pressing it again goes further back (else the first).
 */
export function jumpFight(fights, t, dir, lead) {
  if (!fights.length) return null;
  if (dir > 0) return fights.find((f) => f.start - lead > t + 0.5) ?? fights[fights.length - 1];
  return fights.findLast((f) => f.start < t - 6) ?? fights[0];
}
