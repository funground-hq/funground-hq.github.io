// Tests Play's own zip module (site_src/play/zip.js, S-242) in Node: no browser needed.
//
//   node tools/test_zip.mjs
//
// A zip is written and read back; a zip written by Python's zipfile is read (stored and deflated entries, folders, a
// comment); Python's zipfile reads a zip written here; damage, a password and a big entry are refused with a sentence.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PYTHON = "C:/Projects/playground/.venv/Scripts/python.exe";
const { makeZip, readZip, crc32, ZipError } = await import(pathToFileURL(path.join(HERE, "..", "site_src", "play", "zip.js")).href);

const text = (string) => new TextEncoder().encode(string);
const show = (bytes) => new TextDecoder().decode(bytes);
const scratch = mkdtempSync(path.join(tmpdir(), "funground-zip-test-"));
let failures = 0;

async function test(name, body) {
  try {
    await body();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name} - ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// What happens when `body` is called, as the error it throws (or null).
async function refusal(body) {
  try {
    await body();
  } catch (error) {
    return error;
  }
  return null;
}

const python = (code, ...args) => execFileSync(PYTHON, ["-I", "-c", code, ...args], { encoding: "utf8" });
const longText = "def draw():\n    f.circle(100, 100, 20)\n".repeat(200);

try {
  await test("the checksum is the standard CRC-32", () => {
    assert(crc32(text("123456789")) === 0xcbf43926, `crc32 is ${crc32(text("123456789")).toString(16)}`);
    assert(crc32(new Uint8Array()) === 0, "the empty checksum is not 0");
  });

  await test("a zip is read back as it was written: names, bytes, order, stored and deflated", async () => {
    const entries = [
      { name: "ball/main.py", bytes: text(longText) },                 // long and repeated: it deflates
      { name: "ball/helpers.py", bytes: text("X = 1\n") },              // tiny: it is stored
      { name: "ball/\u00e9t\u00e9.py", bytes: text("# \u00e9\n") },     // a name that is not ASCII
      { name: "ball/empty.py", bytes: new Uint8Array() },
      { name: "ball/photo.bin", bytes: Uint8Array.from({ length: 3000 }, (_, i) => (i * 7919) % 251) },
    ];
    const zip = await makeZip(entries);
    const back = await readZip(zip);
    assert(back.length === entries.length, `${back.length} entries came back`);
    entries.forEach((entry, i) => {
      assert(back[i].name === entry.name, `name ${i} is ${back[i].name}`);
      assert(back[i].bytes.length === entry.bytes.length && back[i].bytes.every((byte, k) => byte === entry.bytes[k]), `bytes of ${entry.name} differ`);
    });
    assert(zip.length < entries.reduce((sum, entry) => sum + entry.bytes.length, 0), "nothing was deflated");
  });

  await test("Python's zipfile reads a zip written here (so a desktop unzip does)", async () => {
    const zip = await makeZip([{ name: "ball/main.py", bytes: text(longText) }, { name: "ball/helpers.py", bytes: text("X = 1\n") }], new Date(2026, 10, 17, 9, 30, 4));
    const file = path.join(scratch, "ours.zip");
    writeFileSync(file, zip);
    const listing = python("import sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint('|'.join(f'{i.filename}:{i.file_size}:{i.date_time}' for i in z.infolist()))\nprint(z.read('ball/helpers.py').decode(), end='')", file);
    const [first, second] = listing.trim().split(/\r?\n/);       // Python on Windows ends a line with \r\n
    assert(first === `ball/main.py:${text(longText).length}:(2026, 11, 17, 9, 30, 4)|ball/helpers.py:6:(2026, 11, 17, 9, 30, 4)`, `Python lists ${first}`);
    assert(second === "X = 1", `Python reads ${second}`);
  });

  await test("a zip written by Python's zipfile is read: folders skipped, stored and deflated, a comment at the end", async () => {
    const file = path.join(scratch, "theirs.zip");
    python(
      "import sys, zipfile\n"
      + "with zipfile.ZipFile(sys.argv[1], 'w') as z:\n"
      + "    z.writestr(zipfile.ZipInfo('ball/'), '')\n"
      + "    z.writestr('ball/main.py', 'print(1)\\n' * 300, zipfile.ZIP_DEFLATED)\n"
      + "    z.writestr('ball/helpers.py', 'X = 1\\n', zipfile.ZIP_STORED)\n"
      + "    z.comment = b'made by Python'\n", file);
    const back = await readZip(new Uint8Array(readFileSync(file)));
    assert(back.map((entry) => entry.name).join() === "ball/main.py,ball/helpers.py", `entries ${back.map((entry) => entry.name)}`);
    assert(show(back[0].bytes) === "print(1)\n".repeat(300) && show(back[1].bytes) === "X = 1\n", "the contents differ");
  });

  await test("a file that is not a zip, a cut zip and a changed byte are refused with a sentence", async () => {
    const zip = await makeZip([{ name: "a/main.py", bytes: text(longText) }]);
    const notZip = await refusal(() => readZip(text("just some text, not a zip file at all")));
    assert(notZip instanceof ZipError && notZip.message === "This is not a zip file.", `not a zip: ${notZip?.message}`);
    const cut = await refusal(() => readZip(zip.slice(0, zip.length - 30)));
    assert(cut instanceof ZipError, `a cut zip: ${cut?.message}`);
    const changed = zip.slice();
    changed[30 + "a/main.py".length + 5] ^= 0xff;                           // a byte inside the packed data
    const damaged = await refusal(() => readZip(changed));
    assert(damaged instanceof ZipError && damaged.message === "\"a/main.py\" is damaged.", `a changed byte: ${damaged?.message}`);
  });

  await test("a password, an unknown packing and an entry over the limit are refused", async () => {
    const zip = await makeZip([{ name: "a/main.py", bytes: text("x = 1\n") }]);
    const locked = zip.slice();
    new DataView(locked.buffer).setUint16(zip.length - 22 - 46 - "a/main.py".length + 8, 1, true);      // the directory's flags: encrypted
    const lockedError = await refusal(() => readZip(locked));
    assert(lockedError?.message === "\"a/main.py\" is locked with a password, which Play cannot open.", `locked: ${lockedError?.message}`);
    const odd = zip.slice();
    new DataView(odd.buffer).setUint16(zip.length - 22 - 46 - "a/main.py".length + 10, 12, true);       // bzip2
    const oddError = await refusal(() => readZip(odd));
    assert(oddError?.message === "\"a/main.py\" is packed in a way Play cannot open.", `odd: ${oddError?.message}`);
    const big = await makeZip([{ name: "a/main.py", bytes: text(longText) }]);
    const bigError = await refusal(() => readZip(big, { maxSize: 1000 }));
    assert(bigError?.message === "\"a/main.py\" is bigger than Play opens.", `big: ${bigError?.message}`);
  });

  await test("an entry that unpacks to more than it says is stopped", async () => {
    const zip = await makeZip([{ name: "a/main.py", bytes: text(longText) }]);
    const lying = zip.slice();
    const view = new DataView(lying.buffer);
    const directory = zip.length - 22 - 46 - "a/main.py".length;
    view.setUint32(directory + 24, 100, true);                               // the directory says 100 bytes
    const error = await refusal(() => readZip(lying));
    assert(error instanceof ZipError && error.message === "\"a/main.py\" is damaged.", `lying: ${error?.message}`);
  });

  await test("an empty list makes a zip that reads back empty", async () => {
    assert((await readZip(await makeZip([]))).length === 0, "an entry came from nothing");
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
