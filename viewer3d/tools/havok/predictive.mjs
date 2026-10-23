// Decoder for Havok 2018 `hkaPredictiveCompressedAnimation`, the only clip type in AoE4 `.rhka` files.
// Our own reimplementation, written from the observed behaviour of the game's scalar block decoder
// and validated on all 3,746 human/animal clips (block-overlap continuity 100%).
//
// Clip layout (fields of the tagfile object):
//   intData (Uint16) split by intArrayOffsets[0..8]:
//     0 BLOCK_OFFSETS             u32 (lo,hi) end offset of each block column in compressedData
//     1 FIRST_FLOAT_BLOCK_OFFSETS (unused by AoE4 clips)
//     2 IS_ANIMATED_BITMAP
//     3 IS_FIXED_RANGE_BITMAP     one bit per dynamic channel (never set in AoE4 clips)
//     4 DYNAMIC_BONE_TRACK_INDEX  channel index per dynamic channel
//     5 DYNAMIC_FLOAT_TRACK_INDEX (unused)
//     6 STATIC_BONE_TRACK_INDEX   channel index per static channel
//     7 STATIC_FLOAT_TRACK_INDEX  (unused)
//     8 RENORM_QUATERNION_INDEX   tracks whose rotation w is rebuilt (followed by 8 padding entries)
//   floatData split by floatArrayOffsets[0..2]: STATIC_VALUES, DYNAMIC_SCALES, DYNAMIC_OFFSETS.
//   Channel index = track*12 + {0..2 translation xyz, 4..6 rotation xyz, 7 rotation w, 8..10 scale xyz}.
//
// compressedData: columns of 16-frame blocks; column c covers frames 15c..15c+15 (one frame overlap),
// each column holds ceil(nDyn/16) blocks of 16 channels x 16 frames.
// Block: 16 header bytes (per channel: hi nibble + 1 = size of region A, lo nibble + 1 = size of region B),
// then per channel region A (frames 0-7) and region B (frames 8-15). A region is a bit stream read
// backwards from its last byte (LSB first) holding 4 groups of [4-bit width w][w-bit signed a][w-bit signed b].
// The 16 residuals are pre-scaled by 4, integrated three times with int16 wrap-around, then shifted right by 2.
// Dynamic value = q * DYNAMIC_SCALES[i] + DYNAMIC_OFFSETS[i].
// Rotations of RENORM tracks are Manhattan-normalised (|x|+|y|+|z|+|w| = 1, w >= 0): w = 1 - (|x|+|y|+|z|),
// then the quaternion is renormalised to unit length. Unlisted channels come from the clip skeleton's referencePose.

const EXTRA_ELEMS = 8; // Havok pads intData with 8 trailing dummy entries

function readRegion(buf, end, out, o) {
  let k = 0; // bit cursor, 0 = LSB of buf[end-1]
  const bit = (i) => { const idx = end - 1 - (i >> 3); return idx >= 0 ? (buf[idx] >> (i & 7)) & 1 : 0; };
  const field = (w) => { let v = 0; for (let i = 0; i < w; i++) v |= bit(k + i) << i; k += w; return v; };
  for (let g = 0; g < 4; g++) {
    const w = field(4);
    let a = field(w), b = field(w);
    if (w) { if (a & (1 << (w - 1))) a -= 1 << w; if (b & (1 << (w - 1))) b -= 1 << w; }
    out[o + 2 * g] = a; out[o + 2 * g + 1] = b;
  }
}

/** Decode one 16-channel x 16-frame block at byte offset p. Returns { end, data: Int16Array(256) as [channel*16+frame] }. */
export function decodeBlock(buf, p) {
  const data = new Int16Array(256);
  const r = new Int32Array(16);
  const v = new Int16Array(16);
  let q = p + 16;
  for (let c = 0; c < 16; c++) {
    const h = buf[p + c];
    const endA = q + (h >> 4) + 1, endB = endA + (h & 15) + 1;
    readRegion(buf, endA, r, 0);
    readRegion(buf, endB, r, 8);
    for (let i = 0; i < 16; i++) v[i] = r[i] * 4;
    for (let pass = 0; pass < 3; pass++) for (let i = 1; i < 16; i++) v[i] = v[i] + v[i - 1];
    for (let i = 0; i < 16; i++) data[c * 16 + i] = v[i] >> 2;
    q = endB;
  }
  return { end: q, data };
}

const section = (A, k) => A.intData.slice(A.intArrayOffsets[k], k + 1 < A.intArrayOffsets.length ? A.intArrayOffsets[k + 1] : A.intData.length - EXTRA_ELEMS);

/** Throw on codec features AoE4 clips never use (so a future file can't be silently mis-decoded). */
function assertSupported(A) {
  const nDyn = A.intArrayOffsets[5] - A.intArrayOffsets[4];
  const fixed = section(A, 3);
  for (let i = 0; i < nDyn; i++) if ((fixed[i >> 4] >> (i & 15)) & 1) throw new Error('fixed-range channels are not supported');
  if (section(A, 1).length || section(A, 5).length || section(A, 7).length) throw new Error('float tracks are not supported');
}

/** Decode all dynamic channels into q[frame] = Int16Array(nDyn). `blocks[column][row]` is kept for overlap checks. */
export function decodeClip(A) {
  assertSupported(A);
  const io = A.intArrayOffsets, cd = A.compressedData;
  const nDyn = io[5] - io[4], rows = Math.ceil(nDyn / 16), F = A.numFrames;
  const bo = section(A, 0);
  const q = Array.from({ length: F }, () => new Int16Array(nDyn));
  const blocks = [];
  let p = 0;
  for (let col = 0; col * 2 < bo.length; col++) {
    const end = bo[2 * col] | (bo[2 * col + 1] << 16);
    const colBlocks = [];
    for (let row = 0; row < rows; row++) { const b = decodeBlock(cd, p); colBlocks.push(b.data); p = b.end; }
    if (p !== end) throw new Error(`column ${col} ends at ${p}, expected ${end}`);
    blocks.push(colBlocks);
    for (let f = 0; f < 16; f++) {
      const frame = col * 15 + f; if (frame >= F) break;
      for (let row = 0; row < rows; row++) for (let j = 0; j < 16; j++) { const k = row * 16 + j; if (k < nDyn) q[frame][k] = colBlocks[row][j * 16 + f]; }
    }
  }
  return { q, blocks, nDyn, rows };
}

/**
 * Sample every frame of one HavokAnimSet entry ({ name, animationBinding, skeleton }) into local bone transforms.
 * Returns { frames, duration, bones: lower-case bone names, data: Float32Array(frames*bones*10) } where each
 * bone record is [tx,ty,tz, qx,qy,qz,qw, sx,sy,sz] in the parent bone's space (metres, Havok/GLB rig axes).
 */
export function sampleClip(entry) {
  const A = entry.animationBinding.animation, sk = entry.skeleton;
  const nB = A.numBones, frames = A.numFrames;
  const dynIdx = section(A, 4), stIdx = section(A, 6), renorm = new Set(section(A, 8));
  const fo = A.floatArrayOffsets, F = A.floatData;
  const statics = F.subarray(fo[0], fo[1]), scales = F.subarray(fo[1], fo[2]), offsets = F.subarray(fo[2]);
  const track2bone = entry.animationBinding.transformTrackToBoneIndices;
  const { q } = decodeClip(A);

  const base = new Float64Array(nB * 12); // per-track channel values before dynamic data
  for (let t = 0; t < nB; t++) {
    const rp = sk.referencePose[track2bone[t]];
    let [x, y, z, w] = rp.rotation;
    if (renorm.has(t)) {
      if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
      const m = Math.abs(x) + Math.abs(y) + Math.abs(z) + w;
      x /= m; y /= m; z /= m; w /= m;
    }
    base.set([rp.translation[0], rp.translation[1], rp.translation[2], 0, x, y, z, w, rp.scale[0], rp.scale[1], rp.scale[2], 0], t * 12);
  }
  stIdx.forEach((c, i) => { base[c] = statics[i]; });

  const data = new Float32Array(frames * nB * 10);
  const ch = new Float64Array(nB * 12);
  for (let f = 0; f < frames; f++) {
    ch.set(base);
    for (let i = 0; i < dynIdx.length; i++) ch[dynIdx[i]] = q[f][i] * scales[i] + offsets[i];
    for (let t = 0; t < nB; t++) {
      const o = t * 12;
      const x = ch[o + 4], y = ch[o + 5], z = ch[o + 6];
      const w = renorm.has(t) ? Math.max(0, 1 - (Math.abs(x) + Math.abs(y) + Math.abs(z))) : ch[o + 7];
      const n = Math.hypot(x, y, z, w) || 1;
      data.set([ch[o], ch[o + 1], ch[o + 2], x / n, y / n, z / n, w / n, ch[o + 8], ch[o + 9], ch[o + 10]], (f * nB + track2bone[t]) * 10);
    }
  }
  return { frames, duration: A.duration, bones: sk.bones.map((b) => b.name.toLowerCase()), data };
}
