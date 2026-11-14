// netlify/functions/api.mjs — Adaptador para Netlify Functions (v2) con Netlify Blobs.
import { getStore } from '@netlify/blobs';
import { createApi } from '../../lib/api.mjs';

function blobStore() {
  const store = getStore({ name: 'partidas', consistency: 'strong' });
  return {
    async get(key) {
      const r = await store.getWithMetadata(key, { type: 'json' });
      return r ? { data: r.data, etag: r.etag } : null;
    },
    async set(key, data, opts) {
      const r = await store.setJSON(key, data, opts);
      return { modified: r ? r.modified !== false : true };
    },
  };
}

export default async (req) => createApi({ store: blobStore() }).handle(req);

export const config = { path: '/api/*' };
