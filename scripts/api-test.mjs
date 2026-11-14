// scripts/api-test.mjs — Prueba de la API por HTTP: escrituras simultáneas de varios jefes
// sin perder datos y que la pantalla pública no filtre información secreta.
// Uso: node scripts/api-test.mjs            (levanta un servidor local en memoria)
//      BASE_URL=https://tu-sitio.netlify.app node scripts/api-test.mjs   (contra un despliegue)
import { startServer } from './dev-server.mjs';
import { createMemoryStore } from '../lib/memory-store.mjs';

let failures = 0;
let passes = 0;
function ok(cond, msg) {
  if (cond) {
    passes++;
    console.log(`  ✓ ${msg}`);
  } else {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
}

let server = null;
let BASE = process.env.BASE_URL;
let skew = 0; // reloj controlable del servidor local (para no esperar el minuto real de la bruja)
if (!BASE) {
  // Latencia artificial para que las carreras entre escrituras sean reales.
  server = await startServer({ port: 0, store: createMemoryStore({ latencyMs: 25 }), quiet: true, now: () => Date.now() + skew });
  BASE = `http://localhost:${server.port}`;
}
console.log(`API en ${BASE}`);

async function req(method, path, { body, token, pub } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (token) headers['x-token'] = token;
  if (pub) headers['x-public'] = pub;
  const r = await fetch(`${BASE}/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
let G;
const act = (type, payload = {}, by = 'Jefe Ana', opId) => req('POST', `/partidas/${G.code}/acciones`, { token: G.token, body: { type, payload, by, opId } });
const view = async () => (await req('GET', `/partidas/${G.code}`, { token: G.token })).data.view;

console.log('\n1. Crear partida y acceso');
const c = await req('POST', '/partidas');
ok(c.status === 201 && /^[A-Z0-9]{6}$/.test(c.data.code) && c.data.token && c.data.publicToken, 'Se crea la partida con código y dos tokens');
G = c.data;
ok((await req('GET', `/partidas/${G.code}`, { token: 'malo' })).status === 403, 'Token de jefe incorrecto → 403');
ok((await req('GET', `/partidas/${G.code}/publica`, { pub: 'malo' })).status === 403, 'Token público incorrecto → 403');
ok((await req('GET', `/partidas/${G.code}/publica`, { pub: G.token })).status === 403, 'El token de jefes no abre la vista pública por error');
ok((await req('GET', '/partidas/ZZZZZZ', { token: G.token })).status === 404, 'Partida inexistente → 404');
const nob = await req('POST', `/partidas/${G.code}/acciones`, { token: G.token, body: { type: 'nota', payload: { text: 'x' } } });
ok(nob.status === 400 && /nombre/.test(nob.data.error), 'Sin nombre de jefe → error en español');

console.log('\n2. Preparación');
const teams = ['Halcones', 'Zorros', 'Osos', 'Búhos', 'Linces'].map((name, i) => ({ id: `e${i + 1}`, name }));
const players = [];
teams.forEach((t, i) => {
  const size = i === 4 ? 2 : 3;
  for (let k = 0; k < size; k++) players.push({ id: `p${i}${k}`, name: `${t.name.slice(0, 3)}-${k + 1}`, teamId: t.id });
});
ok((await act('setup', { teams, players })).status === 200, 'Guardar equipos y 14 jugadores');
const bad = await act('mazo', { counts: { lobo: 2, cazador: 2, chismoso: 1, martir: 1, bruja: 1, aldeano: 7 } });
ok(bad.status === 400 && /una tarjeta/.test(bad.data.error), 'Mazo: no permite 2 tarjetas de cazador');
const mz = await act('mazo', { counts: { lobo: 3, cazador: 1, chismoso: 1, martir: 1, bruja: 1, aldeano: 6 } });
ok(mz.status === 200 && mz.data.view.deck.lobo === 3 && mz.data.view.deckCustom, 'Mazo personalizado de tarjetas');
const m1 = await act('rol', { playerId: 'p00', role: 'lobo' });
ok(m1.status === 200 && m1.data.view.players.find((p) => p.id === 'p00').role === 'lobo', 'Registrar a mano la tarjeta de un jugador');
const m2 = await act('rol', { playerId: 'p00', role: null });
ok(m2.status === 200 && m2.data.view.players.find((p) => p.id === 'p00').role === null, 'Quitar el rol de un jugador');
ok((await act('mazo', { counts: null })).data.view.deckCustom === false, 'Volver a las tarjetas de la tabla');
const ar = await act('asignarRoles');
ok(ar.status === 200, 'Reparto automático de roles');
const roles = Object.fromEntries(ar.data.view.players.map((p) => [p.id, p.role]));
const count = (r) => Object.values(roles).filter((x) => x === r).length;
ok(count('lobo') === 2 && count('cazador') === 1 && count('chismoso') === 1 && count('martir') === 1 && count('bruja') === 1, 'Reparto según la tabla (14 jugadores: 2 lobos + 4 especiales)');
ok(ar.data.view.warnings.length === 0, 'El reparto no tiene advertencias');
await act('senas', { lobo: 'SENA-LOBO-SECRETA', cazador: 'SENA-CAZADOR-SECRETA' });
const tBad = await act('tiempos', { juego: 45, ronda: 6, debate: 3, avisoJuego: 50, avisoRonda: 1 });
ok(tBad.status === 400 && /aviso/.test(tBad.data.error), 'Tiempos: el aviso no puede ser mayor que la duración');
const tOk = await act('tiempos', { juego: 45, ronda: 6, debate: 3, avisoJuego: 5, avisoRonda: 0.5 });
const cfg = tOk.data.view?.config;
ok(tOk.status === 200 && cfg.gameMs === 45 * 60000 && cfg.roundMs === 6 * 60000 && cfg.debateMs === 3 * 60000 && cfg.gameWarnMs === 5 * 60000 && cfg.roundWarnMs === 30000, 'Tiempos personalizados (45 min, rondas de 6, debate de 3, avisos de 5 min y 30 s)');
const pc = (await req('GET', `/partidas/${G.code}/publica`, { pub: G.publicToken })).data.view.config;
ok(pc.gameMs === 45 * 60000 && pc.roundWarnMs === 30000, 'La pantalla pública usa los mismos tiempos');
ok((await act('iniciar')).status === 200, 'Iniciar juego');

console.log('\n3. Escrituras simultáneas');
const jefes = ['Ana', 'Beto', 'Caro', 'Dani', 'Eli', 'Fer', 'Gabo', 'Hugo'];
const N = 40;
const notes = await Promise.all(Array.from({ length: N }, (_, i) => act('nota', { text: `nota-${i}` }, `Jefe ${jefes[i % jefes.length]}`)));
ok(notes.every((r) => r.status === 200), `${N} notas simultáneas de ${jefes.length} jefes aceptadas`);
let v = await view();
const found = v.log.filter((e) => e.type === 'nota').map((e) => e.text);
ok(Array.from({ length: N }, (_, i) => `Nota: nota-${i}`).every((t) => found.includes(t)), `Las ${N} notas están en la bitácora (no se perdió ninguna)`);
ok(new Set(v.log.filter((e) => e.seq != null).map((e) => e.seq)).size === v.log.filter((e) => e.seq != null).length, 'Ninguna acción duplicada');
const byJefe = new Set(v.log.filter((e) => e.type === 'nota').map((e) => e.by));
ok(byJefe.size === jefes.length, 'Cada nota quedó firmada por su jefe');

const wolves = v.players.filter((p) => p.role === 'lobo');
const villagers = v.players.filter((p) => p.role === 'aldeano');
const same = await Promise.all(jefes.slice(0, 6).map((j) => act('muerte', { cause: 'lobo', byId: wolves[0].id, victimId: villagers[0].id, seen: true }, `Jefe ${j}`)));
ok(same.filter((r) => r.status === 200).length === 1, '6 jefes registran la misma muerte a la vez → solo cuenta una');
ok(same.filter((r) => r.status === 400).every((r) => /ya/.test(r.data.error)), 'Los demás reciben un error claro en español');

const two = await Promise.all([
  act('muerte', { cause: 'lobo', byId: wolves[1].id, victimId: villagers[1].id, seen: true }, 'Jefe Ana'),
  act('chismoso', { targetId: villagers[2].id }, 'Jefe Beto'),
]);
ok(two.every((r) => r.status === 200), 'Dos acciones distintas simultáneas se guardan las dos');
v = await view();
ok(v.deaths.filter((d) => d.status === 'pendiente').length === 2 && v.gossip.length === 1, 'Ambas aparecen en el estado');

const op = 'op-fijo-123';
await Promise.all([act('nota', { text: 'reintento' }, 'Jefe Ana', op), act('nota', { text: 'reintento' }, 'Jefe Ana', op)]);
v = await view();
ok(v.log.filter((e) => e.text === 'Nota: reintento').length === 1, 'Reintento con el mismo opId no duplica la acción');

console.log('\n4. Sondeo con ?since=');
const g1 = await req('GET', `/partidas/${G.code}`, { token: G.token });
const g2 = await req('GET', `/partidas/${G.code}?since=${encodeURIComponent(g1.data.etag)}`, { token: G.token });
ok(g2.data.unchanged === true && !g2.data.view, 'Sin cambios → {unchanged:true}');
await act('nota', { text: 'cambio' });
const g3 = await req('GET', `/partidas/${G.code}?since=${encodeURIComponent(g1.data.etag)}`, { token: G.token });
ok(!g3.data.unchanged && g3.data.view, 'Con cambios → vista nueva');

console.log('\n5. Pantalla pública sin secretos');
const pub = (await req('GET', `/partidas/${G.code}/publica`, { pub: G.publicToken })).data;
const pj = JSON.stringify(pub);
ok(pub.view && pub.view.players.length === 14, 'La pantalla pública carga');
ok(pub.view.players.every((p) => p.role === null), 'No muestra ningún rol de jugadores vivos (ni de los que están en la ventana de la bruja)');
ok(!pj.includes('SENA-LOBO-SECRETA') && !pj.includes('SENA-CAZADOR-SECRETA'), 'No muestra las señas');
ok(!pj.includes(G.token), 'No incluye el token de jefes');
for (const k of ['gossip', 'byId', 'seenBy', 'witchSave', 'witchKill', 'signs', 'pendingDeathId', 'deaths', 'invocations']) ok(!pj.includes(`"${k}"`), `No incluye el campo "${k}"`);
ok(!pj.includes('Jefe Ana') && !pj.includes('Jefe Beto'), 'No muestra qué jefe registró cada cosa');
ok(pub.view.log.every((e) => !wolves.some((w) => e.text.includes(w.name))), 'No dice quién mató a quién (los lobos no aparecen en la bitácora pública)');

console.log('\n6. Bruja, deshacer, asamblea y apuestas simultáneas');
const pend = v.deaths.filter((d) => d.status === 'pendiente');
ok((await act('salvar', { deathId: pend[0].id })).status === 200, 'La bruja salva a una víctima');
const again = await act('salvar', { deathId: pend[1].id });
ok(again.status === 400 && /ya usó/.test(again.data.error), 'No puede salvar dos veces');
ok((await act('asamblea')).status === 400, 'No se puede iniciar asamblea con la ventana de la bruja abierta');
ok((await act('deshacer')).status === 200, 'Deshacer la última acción (salvar)');
v = await view();
ok(v.log.some((e) => e.undone && e.type === 'salvar') && v.deaths.find((d) => d.id === pend[0].id).status === 'pendiente', 'La acción deshecha queda marcada y la víctima vuelve a estar en la ventana');
ok((await act('salvar', { deathId: pend[0].id })).status === 200, 'La bruja vuelve a salvarla');

if (server) {
  skew += 61_000; // pasa el minuto de la bruja
  v = await view();
  ok(v.deaths.find((d) => d.id === pend[1].id).status === 'confirmada', 'Al cerrar la ventana la muerte se confirma sola');
  const pubAfter = (await req('GET', `/partidas/${G.code}/publica`, { pub: G.publicToken })).data.view;
  const victim = pubAfter.players.find((p) => p.id === pend[1].victimId);
  const saved = pubAfter.players.find((p) => p.id === pend[0].victimId);
  ok(victim.role === 'aldeano' && saved.role === null, 'La pantalla pública revela solo el rol del muerto confirmado');
  ok((await act('asamblea')).status === 200, 'Iniciar asamblea');
  await act('paso', { to: 'apuestas' });
  const target = v.players.find((p) => p.role === 'lobo' && p.status === 'vivo');
  const bets = await Promise.all(teams.map((t, i) => act('apuesta', { teamId: t.id, playerId: i < 2 ? target.id : villagers[3].id }, `Jefe ${jefes[i]}`)));
  ok(bets.every((r) => r.status === 200), '5 equipos apuestan al mismo tiempo');
  const dup = await Promise.all([act('apuesta', { teamId: 'e1', playerId: target.id }), act('apuesta', { teamId: 'e1', playerId: target.id })]);
  ok(dup.every((r) => r.status === 400), 'Un equipo no puede apostar dos veces');
  v = await view();
  ok(v.pot === 5 && v.teams.every((t) => t.chips === 5), 'Bote = 5 y cada equipo tiene 5 fichas');
  await act('paso', { to: 'debate' });
  await act('paso', { to: 'votacion' });
  const vote = await act('votacion', { playerId: target.id });
  const res = vote.data.view.round.assembly.result;
  ok(res.winners.length === 2 && res.share === 2 && res.potAfter === 1, 'Expulsan al lobo: 2 equipos cobran 2 cada uno y queda 1 en el bote (residuo)');
  const tv = vote.data.view.teams;
  ok(tv.find((t) => t.id === 'e1').chips === 7 && tv.find((t) => t.id === 'e3').chips === 5, 'Fichas correctas después del reparto');
  ok(tv.find((t) => t.id === target.teamId).expelled.length === 1, 'El equipo del expulsado queda marcado (pierde integridad)');
}

const exp = await req('GET', `/partidas/${G.code}/exportar`, { token: G.token });
ok(exp.status === 200 && Array.isArray(exp.data.actions) && !JSON.stringify(exp.data).includes(G.token), 'Exportar JSON (sin el token)');

if (server) await server.close();
console.log(`\n${passes} comprobaciones correctas, ${failures} fallidas.`);
process.exit(failures ? 1 : 0);
