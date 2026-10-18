// My files (S-221): the files a learner keeps for their sketches, in this browser only (IndexedDB; D-108).
//
// One database, one store. A record is { name, bytes, type, added }, keyed by name (a path such as "take.gif" or
// "frames/0001.png"; keeping a name again replaces the record). Every function returns a promise and rejects if the browser
// will not store (a private window, no room): the caller says so in plain words.

const DATABASE = "funground-play";
const STORE = "files";

let opened = null;

function database() {
  opened ??= new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("no IndexedDB"));
      return;
    }
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "name" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("the database is blocked"));
  });
  opened.catch(() => { opened = null; });        // try again next time
  return opened;
}

// Runs one request (or a cursor walk) in a transaction and resolves when the transaction has finished.
async function inStore(mode, work) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    let result;
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("aborted"));
    work(transaction.objectStore(STORE), (value) => { result = value; });
  });
}

// True if the browser can keep files at all.
export const canKeep = () => database().then(() => true, () => false);

// The kept files without their bytes, in name order: [{ name, size, type, added }].
export function list() {
  return inStore("readonly", (store, done) => {
    const found = [];
    store.openCursor().onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        const { name, bytes, type, added } = cursor.value;
        found.push({ name, size: bytes.byteLength, type, added });
        cursor.continue();
      } else {
        done(found);
      }
    };
  });
}

// One whole record (with its bytes), or undefined.
export const read = (name) => inStore("readonly", (store, done) => {
  store.get(name).onsuccess = (event) => done(event.target.result);
});

// Keeps a file (bytes: an ArrayBuffer), replacing one of the same name.
export const keep = (name, bytes, type) => inStore("readwrite", (store) => {
  store.put({ name, bytes, type, added: Date.now() });
});

// Puts a record back as it was (Undo after a delete).
export const restore = (record) => inStore("readwrite", (store) => { store.put(record); });

export const remove = (name) => inStore("readwrite", (store) => { store.delete(name); });

// Every kept file as { name: Uint8Array }, for a run.
export function allBytes() {
  return inStore("readonly", (store, done) => {
    store.getAll().onsuccess = (event) => {
      done(Object.fromEntries(event.target.result.map((record) => [record.name, new Uint8Array(record.bytes)])));
    };
  });
}
