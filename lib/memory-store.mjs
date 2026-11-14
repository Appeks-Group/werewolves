// lib/memory-store.mjs — Almacenamiento en memoria con la misma semántica de
// escrituras condicionales (ETag) que Netlify Blobs. Para desarrollo y pruebas.

export function createMemoryStore({ latencyMs = 0 } = {}) {
  const map = new Map(); // key -> { json, etag }
  let counter = 0;
  const delay = () => (latencyMs ? new Promise((r) => setTimeout(r, Math.random() * latencyMs)) : Promise.resolve());

  return {
    async get(key) {
      await delay();
      const e = map.get(key);
      return e ? { data: JSON.parse(e.json), etag: e.etag } : null;
    },
    async set(key, data, opts = {}) {
      await delay();
      const e = map.get(key);
      if (opts.onlyIfNew && e) return { modified: false };
      if (opts.onlyIfMatch && (!e || e.etag !== opts.onlyIfMatch)) return { modified: false };
      const etag = `"${++counter}"`;
      map.set(key, { json: JSON.stringify(data), etag });
      return { modified: true, etag };
    },
  };
}
