// A small zip reader and writer for the Play page (S-242): a sketch with several files is downloaded as one .zip, and
// Open file takes that .zip back. It does what a sketch needs and no more: each entry is stored or deflated, names are
// UTF-8, and there is no encryption, no zip64 and no multi-disk archive. The browser's own CompressionStream and
// DecompressionStream do the deflating, so there is no dependency.
//
//   const bytes = await makeZip([{ name: "ball/main.py", bytes: new TextEncoder().encode("print(1)\n") }]);
//   const entries = await readZip(bytes);       // [{ name: "ball/main.py", bytes: Uint8Array }]
//
// A zip that cannot be read throws a ZipError, whose message is a plain sentence for the learner.

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const STORED = 0;
const DEFLATED = 8;
const UTF8_NAMES = 0x0800;          // general-purpose flag bit 11
const ENCRYPTED = 0x0001;
const END_SIZE = 22;                // the end record without its comment
const MAX_COMMENT = 0xffff;

export class ZipError extends Error {}

// ---- the checksum every entry carries (CRC-32, the table made once)

const TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

// ---- the browser's deflate, on bytes

async function throughStream(bytes, stream) {
  const piped = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

// Inflates `data` into exactly `size` bytes (the size the zip says). It stops at the first byte past that, so an entry that
// claims to be small and unpacks into gigabytes cannot fill the memory.
async function inflate(data, size) {
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const out = new Uint8Array(size);
  let filled = 0;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    if (filled + chunk.value.length > size) {
      await reader.cancel();
      throw new Error("longer than its size");
    }
    out.set(chunk.value, filled);
    filled += chunk.value.length;
  }
  if (filled !== size) throw new Error("shorter than its size");
  return out;
}

// An entry is deflated only when that makes it smaller; a tiny file is stored as it is.
async function packed(bytes) {
  const deflated = await throughStream(bytes, new CompressionStream("deflate-raw"));
  return deflated.length < bytes.length ? { method: DEFLATED, data: deflated } : { method: STORED, data: bytes };
}

// MS-DOS date and time, which is what a zip holds (two-second steps, from 1980).
function dosStamp(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

// ---- writing

/**
 * @param {{name: string, bytes: Uint8Array}[]} entries  a name uses "/" for a folder: "ball/main.py"
 * @param {Date} [modified]  the time every entry shows
 * @returns {Promise<Uint8Array>}
 */
export async function makeZip(entries, modified = new Date()) {
  const { time, day } = dosStamp(modified);
  const encoder = new TextEncoder();
  const parts = [];
  const directory = [];
  let offset = 0;
  for (const { name, bytes } of entries) {
    const label = encoder.encode(name);
    const { method, data } = await packed(bytes);
    const crc = crc32(bytes);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, LOCAL, true);
    local.setUint16(4, 20, true);                 // needed to read it: version 2.0 (deflate)
    local.setUint16(6, UTF8_NAMES, true);
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, bytes.length, true);
    local.setUint16(26, label.length, true);
    parts.push(new Uint8Array(local.buffer), label, data);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, CENTRAL, true);
    central.setUint16(4, 20, true);               // made by
    central.setUint16(6, 20, true);               // needed to read it
    central.setUint16(8, UTF8_NAMES, true);
    central.setUint16(10, method, true);
    central.setUint16(12, time, true);
    central.setUint16(14, day, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, bytes.length, true);
    central.setUint16(28, label.length, true);
    central.setUint32(42, offset, true);          // where the entry starts
    directory.push(new Uint8Array(central.buffer), label);
    offset += 30 + label.length + data.length;
  }
  const directoryAt = offset;
  const directorySize = directory.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(END_SIZE));
  end.setUint32(0, END, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, directoryAt, true);
  return new Uint8Array(await new Blob([...parts, ...directory, end]).arrayBuffer());
}

// ---- reading

// The end record is the last 22 bytes unless the zip has a comment, so it is looked for from the back.
function findEnd(view) {
  const last = view.byteLength - END_SIZE;
  for (let at = last; at >= Math.max(0, last - MAX_COMMENT); at -= 1) {
    if (view.getUint32(at, true) === END) return at;
  }
  throw new ZipError("This is not a zip file.");
}

/**
 * @param {Uint8Array} bytes  a whole zip
 * @param {{maxSize?: number}} [options]  the most one entry may hold once unpacked (refused before it is unpacked)
 * @returns {Promise<{name: string, bytes: Uint8Array}[]>}  the files, not the folders, in the order of the zip
 */
export async function readZip(bytes, { maxSize = Infinity } = {}) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < END_SIZE) throw new ZipError("This is not a zip file.");
  const end = findEnd(view);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder("utf-8");
  const found = [];
  for (let entry = 0; entry < count; entry += 1) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== CENTRAL) throw new ZipError("This zip is damaged.");
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const packedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;             // a folder
    if (flags & ENCRYPTED) throw new ZipError(`"${name}" is locked with a password, which Play cannot open.`);
    if (method !== STORED && method !== DEFLATED) throw new ZipError(`"${name}" is packed in a way Play cannot open.`);
    if (packedSize === 0xffffffff || size === 0xffffffff) throw new ZipError("This zip is too big for Play.");
    if (size > maxSize) throw new ZipError(`"${name}" is bigger than Play opens.`);
    if (localAt + 30 > bytes.length || view.getUint32(localAt, true) !== LOCAL) throw new ZipError("This zip is damaged.");
    // The sizes of the name and the extra part are read again here: a local header may differ from the directory's.
    const dataAt = localAt + 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true);
    if (dataAt + packedSize > bytes.length) throw new ZipError("This zip is damaged.");
    const data = bytes.subarray(dataAt, dataAt + packedSize);
    let unpacked;
    try {
      unpacked = method === STORED ? data : await inflate(data, size);
    } catch {
      throw new ZipError(`"${name}" is damaged.`);
    }
    if (unpacked.length !== size || crc32(unpacked) !== crc) throw new ZipError(`"${name}" is damaged.`);
    found.push({ name, bytes: unpacked });
  }
  return found;
}
