// A minimal zip writer (no DOM, no dependencies). Entries are "stored" (uncompressed): that keeps this to a few dozen lines
// and the files here are small tables. Each entry gets a local header, the data, and a record in the central directory,
// followed by the end-of-central-directory record, all little-endian, with a correct CRC-32 and sizes. File names are UTF-8
// (general-purpose flag bit 11). No zip64, so it is limited to 4 GB and 65,535 entries, far beyond a results workbook.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const encoder = new TextEncoder();
const toBytes = (data) => (typeof data === "string" ? encoder.encode(data) : data);

// MS-DOS date and time (2-second resolution, years 1980 to 2107), in local time.
function dosDateTime(date) {
  const y = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

// entries: [{ name, data }] with data a string (UTF-8) or a Uint8Array. Returns a Uint8Array.
export function zip(entries, { date = new Date() } = {}) {
  const stamp = dosDateTime(date);
  const parts = [];
  const central = [];
  let offset = 0;
  const push = (bytes) => {
    parts.push(bytes);
    offset += bytes.length;
  };
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = toBytes(entry.data);
    const crc = crc32(data);
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true); // local file header signature
    header.setUint16(4, 20, true); // version needed to extract
    header.setUint16(6, 0x0800, true); // flags: UTF-8 names
    header.setUint16(8, 0, true); // method 0: stored
    header.setUint16(10, stamp.time, true);
    header.setUint16(12, stamp.date, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, data.length, true); // compressed size
    header.setUint32(22, data.length, true); // uncompressed size
    header.setUint16(26, name.length, true);
    header.setUint16(28, 0, true); // extra field length
    const localOffset = offset;
    push(new Uint8Array(header.buffer));
    push(name);
    push(data);

    const record = new DataView(new ArrayBuffer(46));
    record.setUint32(0, 0x02014b50, true); // central directory header signature
    record.setUint16(4, 20, true); // version made by
    record.setUint16(6, 20, true); // version needed
    record.setUint16(8, 0x0800, true);
    record.setUint16(10, 0, true);
    record.setUint16(12, stamp.time, true);
    record.setUint16(14, stamp.date, true);
    record.setUint32(16, crc, true);
    record.setUint32(20, data.length, true);
    record.setUint32(24, data.length, true);
    record.setUint16(28, name.length, true);
    // 30 extra length, 32 comment length, 34 disk number, 36 internal attributes, 38 external attributes: all 0
    record.setUint32(42, localOffset, true);
    central.push(new Uint8Array(record.buffer), name);
  }
  const centralStart = offset;
  central.forEach(push);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); // end of central directory signature
  end.setUint16(8, entries.length, true); // entries on this disk
  end.setUint16(10, entries.length, true); // entries in total
  end.setUint32(12, offset - centralStart, true); // size of the central directory
  end.setUint32(16, centralStart, true); // where it starts
  push(new Uint8Array(end.buffer));

  const out = new Uint8Array(offset);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
