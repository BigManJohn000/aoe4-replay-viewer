/**
 * toolchain.mjs — where the model-extraction toolchain lives, shared by build-assets.mjs, havok/bake-anims.mjs and
 * havok/extract-clips.mjs.
 *
 * One root setting, AOE4_REBUILD (default: the project's toolchain/ folder, beside viewer3d/), holds
 *   tools/dotnet/dotnet.exe, tools/essence/AOEMods.Essence.CLI.dll and content-local/extracted/ (the unpacked archives).
 * Each of those can still be set by itself: ESSENCE_DOTNET, ESSENCE_CLI, AOE4_EXTRACTED.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'toolchain');
const root = path.resolve(process.env.AOE4_REBUILD ?? DEFAULT_ROOT);
export const TOOLCHAIN = {
  root,
  extracted: process.env.AOE4_EXTRACTED ?? path.join(root, 'content-local', 'extracted'),
  dotnet: process.env.ESSENCE_DOTNET ?? path.join(root, 'tools', 'dotnet', 'dotnet.exe'),
  essence: process.env.ESSENCE_CLI ?? path.join(root, 'tools', 'essence', 'AOEMods.Essence.CLI.dll'),
};

/** Prints one message naming AOE4_REBUILD and exits 1 unless the .NET runtime and Essence CLI exist ({ extracted: true }
 *  also requires the unpacked archives folder). */
export function requireToolchain({ extracted = false } = {}) {
  const need = [['.NET runtime', TOOLCHAIN.dotnet], ['Essence CLI', TOOLCHAIN.essence]];
  if (extracted) need.push(['extracted archives', TOOLCHAIN.extracted]);
  const missing = need.filter(([, p]) => !fs.existsSync(p)).map(([what, p]) => `${what} (${p})`);
  if (!missing.length) return;
  console.error(`The AoE4 extraction toolchain was not found: missing ${missing.join(', ')}. Put it in the project's `
    + `toolchain/ folder or set AOE4_REBUILD to the folder holding tools/dotnet, tools/essence and `
    + `content-local/extracted (currently ${TOOLCHAIN.root}).`);
  process.exit(1);
}
