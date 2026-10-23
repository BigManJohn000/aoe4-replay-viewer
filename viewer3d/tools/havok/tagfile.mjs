// Minimal Havok 2018 binary tagfile (TAG0) reader, used for AoE4 `.rhka` animation sets.
// Section/type layout follows HKLib (MIT, github.com/The12thAvenger/HKLib).
// Produces plain JS objects (field names without the `m_` prefix, plus `$type`);
// arrays of scalars come back as typed arrays.

const KIND = { VOID: 0, OPAQUE: 1, BOOL: 2, STRING: 3, INT: 4, FLOAT: 5, POINTER: 6, RECORD: 7, ARRAY: 8 };

function sections(buf, start, end) {
  const out = [];
  for (let p = start; p < end; ) {
    const len = buf.readUInt32BE(p) & 0x3fffffff;
    out.push({ tag: buf.toString('latin1', p + 4, p + 8), start: p + 8, end: p + len });
    p += len;
  }
  return out;
}

function varuint(buf, pos) {
  const b = buf[pos.p];
  const forms = [[0x80, 0x00, 1], [0xc0, 0x80, 2], [0xe0, 0xc0, 3], [0xf8, 0xe0, 4], [0xf8, 0xe8, 5], [0xff, 0xf8, 6], [0xf8, 0xf0, 8], [0xff, 0xf9, 9]];
  for (const [mask, prefix, n] of forms) {
    if ((b & mask) !== prefix) continue;
    let v = BigInt(b & ~mask & 0xff);
    for (let i = 1; i < n; i++) v = (v << 8n) | BigInt(buf[pos.p + i]);
    pos.p += n;
    return Number(v);
  }
  throw new Error(`bad varuint prefix 0x${b.toString(16)} at ${pos.p}`);
}

function strings(buf, s) {
  const out = [];
  for (let p = s.start; p < s.end; ) {
    let q = p;
    while (q < s.end && buf[q] !== 0) q++;
    out.push(buf.toString('latin1', p, q));
    p = q + 1;
  }
  return out;
}

/** Parse a TAG0 tagfile Buffer. `root()` returns the top-level object (for .rhka: a HavokAnimSet). */
export function readTagfile(buf) {
  const [tag0] = sections(buf, 0, buf.length);
  if (tag0.tag !== 'TAG0') throw new Error('not a TAG0 tagfile');
  const top = Object.fromEntries(sections(buf, tag0.start, tag0.end).map((s) => [s.tag, s]));
  const sdk = buf.toString('latin1', top.SDKV.start, top.SDKV.end);
  const typeSecs = Object.fromEntries(sections(buf, top.TYPE.start, top.TYPE.end).map((s) => [s.tag, s]));
  const tstr = strings(buf, typeSecs.TSTR ?? typeSecs.TST1);
  const fstr = strings(buf, typeSecs.FSTR ?? typeSecs.FST1);

  // TNA1: type names + template parameters
  const pos = { p: (typeSecs.TNA1 ?? typeSecs.TNAM).start };
  const nTypes = varuint(buf, pos);
  const types = [{ id: 0, name: 'NULL', params: [] }];
  for (let i = 1; i < nTypes; i++) types.push({ id: i, params: [] });
  for (let i = 1; i < nTypes; i++) {
    const t = types[i];
    t.name = tstr[varuint(buf, pos)];
    const np = varuint(buf, pos);
    for (let j = 0; j < np; j++) {
      const pn = tstr[varuint(buf, pos)], pv = varuint(buf, pos);
      t.params.push({ name: pn.slice(1), kind: pn[0], value: pn[0] === 't' ? types[pv] : pv });
    }
  }
  // TBDY: type bodies (parent, format, sub-type, size, fields)
  const body = typeSecs.TBDY ?? typeSecs.TBOD;
  pos.p = body.start;
  while (pos.p < body.end) {
    const ti = varuint(buf, pos);
    if (ti === 0) break;
    const t = types[ti];
    const parent = varuint(buf, pos);
    if (parent) t.parent = types[parent];
    const opt = varuint(buf, pos);
    if (opt & 1) t.format = varuint(buf, pos);
    if (opt & 2) t.sub = types[varuint(buf, pos)];
    if (opt & 4) t.version = varuint(buf, pos);
    if (opt & 8) { t.size = varuint(buf, pos); t.align = varuint(buf, pos); }
    if (opt & 16) t.flags = varuint(buf, pos);
    if (opt & 32) {
      const nm = varuint(buf, pos);
      t.fields = [];
      for (let j = 0; j < (nm & 0xffff); j++) {
        const name = fstr[varuint(buf, pos)], flags = varuint(buf, pos), offset = varuint(buf, pos), type = types[varuint(buf, pos)];
        t.fields.push({ name, flags, offset, type });
      }
    }
    if (opt & 64) {
      const n = varuint(buf, pos);
      for (let j = 0; j < n; j++) { varuint(buf, pos); varuint(buf, pos); }
    }
    if (opt & 128) throw new Error('type attributes not supported');
  }

  // INDX/ITEM: every object/array in DATA
  const indx = Object.fromEntries(sections(buf, top.INDX.start, top.INDX.end).map((s) => [s.tag, s]));
  const data0 = top.DATA.start;
  const items = [];
  for (let p = indx.ITEM.start; p < indx.ITEM.end; p += 12) {
    const tf = buf.readUInt32LE(p);
    items.push({ type: types[tf & 0xffffff], kind: tf >>> 28, offset: data0 + buf.readInt32LE(p + 4), count: buf.readInt32LE(p + 8), value: undefined });
  }

  // effective (inherited) type properties
  const inh = (t, key) => { for (let x = t; x; x = x.parent) if (x[key] !== undefined) return x[key]; return undefined; };
  const allFields = (t) => (t.parent ? allFields(t.parent) : []).concat(t.fields ?? []);
  const fieldCache = new Map();
  const fieldsOf = (t) => { let f = fieldCache.get(t); if (!f) fieldCache.set(t, (f = allFields(t))); return f; };

  function readScalarArray(t, offset, count) {
    const fmt = inh(t, 'format'), kind = fmt & 0xf, size = inh(t, 'size');
    if (kind === KIND.FLOAT && size === 4) return new Float32Array(buf.buffer.slice(buf.byteOffset + offset, buf.byteOffset + offset + 4 * count));
    if (kind === KIND.INT) {
      const signed = (fmt & 0x200) !== 0, bytes = (fmt >> 10) / 8;
      const C = { 1: signed ? Int8Array : Uint8Array, 2: signed ? Int16Array : Uint16Array, 4: signed ? Int32Array : Uint32Array }[bytes];
      if (C) return new C(buf.buffer.slice(buf.byteOffset + offset, buf.byteOffset + offset + bytes * count));
    }
    return null;
  }

  function item(index) {
    if (!index) return null;
    const it = items[index];
    if (it.value !== undefined) return it.value;
    if (it.kind === 2) {
      const scalar = readScalarArray(it.type, it.offset, it.count);
      if (scalar) return (it.value = scalar);
      const stride = inh(it.type, 'size');
      it.value = [];
      for (let i = 0; i < it.count; i++) it.value.push(read(it.type, it.offset + i * stride));
      if ((inh(it.type, 'format') & 0xf) === KIND.INT && it.type.name === 'char') it.value = String.fromCharCode(...it.value);
      return it.value;
    }
    it.value = {};
    return read(it.type, it.offset, it.value);
  }

  function read(t, offset, into) {
    const fmt = inh(t, 'format') ?? 0, kind = fmt & 0xf;
    switch (kind) {
      case KIND.VOID: case KIND.OPAQUE: return undefined;
      case KIND.BOOL: return buf[offset] !== 0;
      case KIND.STRING: {
        const p = Number(buf.readBigUInt64LE(offset));
        if (!p) return null;
        const it = items[p];
        let q = it.offset; while (buf[q] !== 0 && q < it.offset + it.count) q++;
        return buf.toString('latin1', it.offset, q);
      }
      case KIND.INT: {
        const signed = (fmt & 0x200) !== 0, bytes = (fmt >> 10) / 8;
        if (bytes === 1) return signed ? buf.readInt8(offset) : buf[offset];
        if (bytes === 2) return signed ? buf.readInt16LE(offset) : buf.readUInt16LE(offset);
        if (bytes === 4) return signed ? buf.readInt32LE(offset) : buf.readUInt32LE(offset);
        return Number(signed ? buf.readBigInt64LE(offset) : buf.readBigUInt64LE(offset));
      }
      case KIND.FLOAT: return inh(t, 'size') === 8 ? buf.readDoubleLE(offset) : buf.readFloatLE(offset);
      case KIND.POINTER: return item(Number(buf.readBigUInt64LE(offset)));
      case KIND.RECORD: {
        const o = into ?? {};
        o.$type = t.name;
        for (const f of fieldsOf(t)) o[f.name.replace(/^m_/, '')] = read(f.type, offset + f.offset);
        return o;
      }
      case KIND.ARRAY: {
        const name = t.name ?? inh(t, 'name');
        const sub = inh(t, 'sub');
        const n = fmt >> 8;
        if (n > 0) {
          const scalar = readScalarArray(sub, offset, n);
          if (scalar) return Array.from(scalar);
          const stride = inh(sub, 'size');
          return Array.from({ length: n }, (_, i) => read(sub, offset + i * stride));
        }
        if (name === 'hkRelArray') return item(buf.readUInt32LE(offset)) ?? [];
        return item(Number(buf.readBigUInt64LE(offset))) ?? [];
      }
      default: throw new Error(`unknown kind ${kind} for ${t.name}`);
    }
  }

  return { sdk, types, items, item, root: () => item(1) };
}
