// lib/api.mjs — Manejador HTTP independiente del hosting.
//
// Usa objetos estándar Request/Response. Recibe un "store" con dos métodos:
//   get(key)                       -> { data, etag } | null
//   set(key, data, { onlyIfMatch } | { onlyIfNew }) -> { modified: boolean }
//
// Rutas:
//   POST /api/partidas                      crear partida
//   GET  /api/partidas/:code?since=ETAG     vista de jefes   (cabecera x-token)
//   GET  /api/partidas/:code/publica?since= vista pública    (cabecera x-public o ?p=)
//   GET  /api/partidas/:code/exportar       exportar JSON    (cabecera x-token)
//   POST /api/partidas/:code/acciones       registrar acción (cabecera x-token)

import * as G from './game.mjs';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_RETRIES = 12;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function randomString(len, chars) {
  const bytes = new Uint8Array(len);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}
const TOKEN_CHARS = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

const keyOf = (code) => `partida-${code}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createApi({ store, now = () => Date.now(), random = Math.random }) {
  async function load(code) {
    const cur = await store.get(keyOf(code));
    if (!cur || !cur.data) throw new HttpError(404, 'No existe esa partida. Revisa el enlace.');
    return cur;
  }
  function checkToken(doc, req, url) {
    const t = req.headers.get('x-token') || url.searchParams.get('t');
    if (!t || t !== doc.token) throw new HttpError(403, 'Enlace de jefes inválido.');
  }
  const stateOf = (doc) => G.replay(doc.actions, { code: doc.code, createdAt: doc.createdAt });
  const etagOf = (doc, view) => `${doc.version}.${view.sysCount}`;

  function jefeResponse(doc, state, since) {
    const t = now();
    const view = G.deriveView(state, t);
    const etag = etagOf(doc, view);
    if (since && since === etag) return json({ unchanged: true, etag, now: t });
    view.publicToken = doc.publicToken;
    return json({ etag, now: t, view });
  }

  async function create() {
    for (let i = 0; i < 10; i++) {
      const code = randomString(6, CODE_CHARS);
      const doc = {
        code,
        token: randomString(28, TOKEN_CHARS),
        publicToken: randomString(16, TOKEN_CHARS),
        createdAt: now(),
        version: 0,
        actions: [],
      };
      const r = await store.set(keyOf(code), doc, { onlyIfNew: true });
      if (r.modified) return json({ code, token: doc.token, publicToken: doc.publicToken }, 201);
    }
    throw new HttpError(500, 'No se pudo crear la partida. Intenta de nuevo.');
  }

  async function postAction(code, req, url) {
    let body;
    try {
      body = await req.json();
    } catch {
      throw new HttpError(400, 'Solicitud inválida.');
    }
    const type = body?.type;
    const by = typeof body?.by === 'string' ? body.by.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
    if (!by) throw new HttpError(400, 'Escribe tu nombre de jefe antes de registrar acciones.');
    if (type !== 'deshacer' && !G.ACTION_TYPES.includes(type)) throw new HttpError(400, 'Acción desconocida.');
    const opId = typeof body.opId === 'string' ? body.opId.slice(0, 40) : null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const cur = await load(code);
      const doc = cur.data;
      checkToken(doc, req, url);
      // Idempotencia: si el cliente reintenta la misma operación, no se duplica.
      if (opId && doc.actions.some((a) => a.opId === opId)) return jefeResponse(doc, stateOf(doc));

      const last = doc.actions[doc.actions.length - 1];
      const at = Math.max(now(), last ? last.at : 0);
      const action = { seq: doc.actions.length, type, payload: {}, by, at, opId };
      let actions;
      if (type === 'deshacer') {
        const target = [...doc.actions].reverse().find((a) => !a.undone && a.type !== 'deshacer');
        if (!target) throw new G.GameError('No hay nada que deshacer.');
        action.payload = { target: target.seq };
        action.text = `Deshizo: ${target.text}`;
        actions = doc.actions.map((a) => (a.seq === target.seq ? { ...a, undone: true, undoneBy: by } : a));
        actions.push(action);
      } else {
        const state = stateOf(doc);
        action.payload = G.prepareAction(state, { type, payload: body.payload || {} }, random);
        action.text = G.applyAction(state, action);
        actions = [...doc.actions, action];
      }
      const next = { ...doc, version: doc.version + 1, actions };
      const r = await store.set(keyOf(code), next, { onlyIfMatch: cur.etag });
      if (r.modified) return jefeResponse(next, stateOf(next));
      await sleep(20 + Math.floor(random() * 80 * (attempt + 1)));
    }
    throw new HttpError(409, 'Hubo demasiados cambios al mismo tiempo. Intenta de nuevo.');
  }

  async function handle(req) {
    const url = new URL(req.url);
    const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    try {
      if (parts[0] !== 'partidas') throw new HttpError(404, 'Ruta no encontrada.');
      if (parts.length === 1) {
        if (req.method === 'POST') return await create();
        throw new HttpError(405, 'Método no permitido.');
      }
      const code = parts[1].toUpperCase();
      if (!/^[A-Z0-9]{4,10}$/.test(code)) throw new HttpError(404, 'No existe esa partida. Revisa el enlace.');
      const sub = parts[2] || '';
      if (req.method === 'GET' && sub === '') {
        const { data: doc } = await load(code);
        checkToken(doc, req, url);
        return jefeResponse(doc, stateOf(doc), url.searchParams.get('since'));
      }
      if (req.method === 'GET' && sub === 'publica') {
        const { data: doc } = await load(code);
        const p = req.headers.get('x-public') || url.searchParams.get('p');
        if (!p || p !== doc.publicToken) throw new HttpError(403, 'Enlace de pantalla pública inválido.');
        const t = now();
        const view = G.publicView(stateOf(doc), t);
        const etag = etagOf(doc, view);
        if (url.searchParams.get('since') === etag) return json({ unchanged: true, etag, now: t });
        delete view.sysCount;
        return json({ etag, now: t, view });
      }
      if (req.method === 'GET' && sub === 'exportar') {
        const { data: doc } = await load(code);
        checkToken(doc, req, url);
        const t = now();
        const view = G.deriveView(stateOf(doc), t);
        const actions = doc.actions.map(({ opId, ...a }) => a);
        return json({ exportadoEn: new Date(t).toISOString(), code: doc.code, createdAt: doc.createdAt, version: doc.version, actions, estado: view });
      }
      if (req.method === 'POST' && sub === 'acciones') return await postAction(code, req, url);
      throw new HttpError(404, 'Ruta no encontrada.');
    } catch (e) {
      if (e instanceof G.GameError) return json({ error: e.message }, 400);
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Error interno del servidor.' }, 500);
    }
  }

  return { handle };
}
