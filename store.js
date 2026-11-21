// Almacenamiento local: ajustes en localStorage y datos pesados (cola de envío, miniaturas,
// documentos, conversaciones) en IndexedDB. Si IndexedDB no está, se trabaja en memoria.

let NS = 'taller.';
let DB_NAME = 'taller-ia';

export function useDemoStore() { NS = 'taller.demo.'; DB_NAME = 'taller-ia-demo'; }

export const ls = {
  get(k, d) { try { const v = localStorage.getItem(NS + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch { /* lleno o bloqueado */ } },
  del(k) { try { localStorage.removeItem(NS + k); } catch { /* nada */ } },
};

const STORES = { outbox: 'lid', media: 'key', docs: 'id', cases: 'id' };
const mem = { outbox: new Map(), media: new Map(), docs: new Map(), cases: new Map() };
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => { for (const s in STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: STORES[s] }); };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbp;
}

function run(store, mode, fn) {
  return open().then((db) => {
    if (!db) return fn(null);
    return new Promise((resolve, reject) => {
      let out;
      const tx = db.transaction(store, mode);
      const rq = fn(tx.objectStore(store));
      if (rq) rq.onsuccess = () => { out = rq.result; };
      tx.oncomplete = () => resolve(out);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('idb'));
    });
  });
}

export const idb = {
  put(store, v) { return run(store, 'readwrite', (s) => (s ? s.put(v) : void mem[store].set(v[STORES[store]], v))); },
  get(store, k) { return run(store, 'readonly', (s) => (s ? s.get(k) : mem[store].get(k))); },
  del(store, k) { return run(store, 'readwrite', (s) => (s ? s.delete(k) : void mem[store].delete(k))); },
  all(store) { return run(store, 'readonly', (s) => (s ? s.getAll() : [...mem[store].values()])).then((v) => v || []); },
};
