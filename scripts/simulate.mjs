// scripts/simulate.mjs — Cientos de partidas aleatorias para comprobar que las reglas nunca se rompen.
// Uso: node scripts/simulate.mjs [partidas] [semilla]
import * as G from '../lib/game.mjs';

const GAMES = Number(process.argv[2] || 400);
const SEED = Number(process.argv[3] || 20261114);

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const chance = (p) => rng() < p;

let failures = 0;
const stats = { games: 0, actions: 0, rejected: 0, undos: 0, endings: {}, saves: 0, payouts: 0, martyr: 0 };

function assert(cond, msg, ctx) {
  if (cond) return;
  failures++;
  if (failures <= 15) console.error(`✗ ${msg}`, ctx ? JSON.stringify(ctx).slice(0, 400) : '');
}

function check(state, now, gameNo) {
  const v = G.deriveView(state, now);
  const ctx = { game: gameNo };
  const cfg = v.config;
  // Cazador: balas ≤ 2 y máximo una por ronda
  const shots = v.deaths.filter((d) => d.cause === 'cazador');
  assert(shots.length <= cfg.hunterBullets, 'El cazador usó más de 2 balas', ctx);
  assert(new Set(shots.map((d) => d.round)).size === shots.length, 'El cazador disparó dos veces en una ronda', ctx);
  // Bruja: pócimas de un solo uso, salvar solo dentro de la ventana
  const saved = v.deaths.filter((d) => d.status === 'salvada');
  assert(saved.length <= 1, 'La bruja salvó más de una vez', ctx);
  assert(v.deaths.filter((d) => d.cause === 'bruja').length <= 1, 'La bruja mató más de una vez', ctx);
  for (const d of saved) assert(d.savedGt - d.gt < cfg.witchMs, 'La bruja salvó fuera de la ventana', ctx);
  // Lobos: una eliminación por lobo por ronda; nunca a otro lobo
  const wk = v.deaths.filter((d) => d.cause === 'lobo');
  assert(new Set(wk.map((d) => `${d.byId}-${d.round}`)).size === wk.length, 'Un lobo eliminó dos veces en una ronda', ctx);
  for (const d of wk) assert(v.players.find((p) => p.id === d.victimId).role !== 'lobo', 'Un lobo eliminó a otro lobo', ctx);
  // Chismoso: una consulta por ronda
  assert(new Set(v.gossip.map((g) => g.round)).size === v.gossip.length, 'El chismoso consultó dos veces en una ronda', ctx);
  // Invocaciones: una por equipo por ronda, máximo una en curso
  const inv = v.invocations.filter((i) => i.status !== 'cancelada');
  assert(new Set(inv.map((i) => `${i.teamId}-${i.round}`)).size === inv.length, 'Un equipo invocó dos veces en una ronda', ctx);
  assert(v.invocations.filter((i) => i.status === 'en_curso').length <= 1, 'Dos invocaciones a la vez', ctx);
  for (const i of v.invocations) if (i.status !== 'cancelada') assert(v.players.find((p) => p.id === i.ghostId).role !== 'lobo', 'Se invocó a un lobo', ctx);
  // Muertos: nadie muere dos veces; lobos fuera, aldeanos fantasmas
  const victims = v.deaths.filter((d) => d.status === 'confirmada').map((d) => d.victimId);
  assert(new Set(victims).size === victims.length, 'Alguien murió dos veces', ctx);
  for (const p of v.players) {
    if (v.phase === 'preparacion') continue;
    const dead = victims.includes(p.id);
    if (dead) assert(p.status === (p.role === 'lobo' ? 'fuera' : 'fantasma'), 'Estado de muerto incorrecto', { ...ctx, p });
    else assert(p.status === 'vivo', 'Un vivo no está vivo', { ...ctx, p });
  }
  if (v.phase !== 'preparacion') {
    // Fichas: el bote nunca crea ni pierde fichas
    const T = v.teams.length;
    const base = v.teams.reduce((a, t) => a + t.ledger.inicial + t.ledger.apuestas + t.ledger.cobros, 0);
    assert(base + v.pot === T * cfg.startChips, 'El bote creó o perdió fichas', { ...ctx, base, pot: v.pot });
    assert(v.pot >= 0, 'Bote negativo', ctx);
    for (const t of v.teams) {
      assert(t.chips >= 0, 'Fichas negativas', ctx);
      assert(t.chips === Object.values(t.ledger).reduce((a, b) => a + b, 0), 'Total de fichas no cuadra', ctx);
    }
    for (const a of [...v.assemblies, v.round.assembly].filter(Boolean)) assert(new Set(a.bets.map((b) => b.teamId)).size === a.bets.length, 'Un equipo apostó dos veces', ctx);
    // Mártir: +3 solo si fue el primer muerto
    const martyrSum = v.teams.reduce((a, t) => a + t.ledger.martir, 0);
    const first = v.deaths.filter((d) => d.status === 'confirmada').sort((a, b) => (a.confirmedGt ?? a.gt) - (b.confirmedGt ?? b.gt))[0];
    const shouldPay = first && v.players.find((p) => p.id === first.victimId).role === 'martir';
    assert(martyrSum === (shouldPay ? cfg.bonusMartir : 0), 'Bono del mártir incorrecto', { ...ctx, martyrSum, first });
    if (shouldPay) stats.martyr++;
    // Fin del juego
    const wolves = v.players.filter((p) => p.status === 'vivo' && p.role === 'lobo').length;
    const vill = v.players.filter((p) => p.status === 'vivo' && p.role !== 'lobo').length;
    if (v.phase === 'juego') {
      assert(wolves > 0, 'No quedan lobos y el juego no terminó', ctx);
      assert(wolves < vill, 'Los lobos igualan a los aldeanos y el juego no terminó', { ...ctx, wolves, vill });
      assert(v.gt < cfg.gameMs, 'Se acabó el tiempo y el juego no terminó', ctx);
    } else {
      assert(v.final.winner === (wolves === 0 ? 'aldeanos' : 'lobos'), 'Ganador incorrecto', { ...ctx, wolves, final: v.final });
      assert(v.final.endGt <= cfg.gameMs, 'El juego terminó después del tiempo', ctx);
      for (const t of v.teams) {
        assert(t.ledger.integridad === (t.expelled.length ? 0 : cfg.bonusIntegridad), 'Bono de integridad incorrecto', ctx);
        const hasWolf = v.players.some((p) => p.teamId === t.id && p.role === 'lobo' && p.status === 'vivo');
        assert(t.ledger.lobos === (v.final.winner === 'lobos' && hasWolf ? cfg.bonusLobos : 0), 'Bono de lobos incorrecto', ctx);
      }
      const best = Math.max(...v.teams.map((t) => t.correctBets));
      for (const t of v.teams) assert(t.ledger.apostador === (best > 0 && t.correctBets === best ? cfg.bonusApostador : 0), 'Bono de mejor apostador incorrecto', ctx);
    }
  }
  // La pantalla pública no filtra secretos
  const pub = G.publicView(state, now);
  const pubJson = JSON.stringify(pub);
  for (const p of pub.players) {
    const real = v.players.find((x) => x.id === p.id);
    if (v.phase !== 'fin' && real.status === 'vivo') assert(p.role === null, 'La pantalla pública muestra el rol de un vivo', ctx);
  }
  for (const k of ['"gossip"', '"byId"', '"signs"', '"seenBy"', '"witchSave"', '"role":"', '"token"']) {
    if (k === '"role":"') continue;
    assert(!pubJson.includes(k), `La pantalla pública contiene ${k}`, ctx);
  }
  if (v.signs.lobo) assert(!pubJson.includes(v.signs.lobo), 'La pantalla pública muestra la seña', ctx);
  return v;
}

function makeTeamsAndPlayers() {
  for (;;) {
    const nTeams = 3 + Math.floor(rng() * 5);
    const teams = Array.from({ length: nTeams }, (_, i) => ({ id: `e${i + 1}`, name: `Equipo ${i + 1}` }));
    const players = [];
    let k = 0;
    for (const t of teams) {
      const size = chance(0.2) ? 2 : 2 + Math.floor(rng() * 6);
      for (let i = 0; i < size; i++) players.push({ id: `p${k}`, name: `Jugador ${++k}`, teamId: t.id });
    }
    if (players.length >= 8 && players.length <= 31) return { teams, players };
  }
}

function randomAction(v) {
  const alive = v.players.filter((p) => p.status === 'vivo');
  const anyP = () => pick(v.players).id;
  const aliveP = () => (alive.length ? pick(alive).id : anyP());
  if (v.phase === 'juego' && v.round.stage === 'ronda') {
    const r = rng();
    if (r < 0.22) {
      const wolves = alive.filter((p) => p.role === 'lobo');
      const target = chance(0.85) ? alive.filter((p) => p.role !== 'lobo') : alive;
      return { type: 'muerte', payload: { cause: 'lobo', byId: wolves.length && chance(0.9) ? pick(wolves).id : anyP(), victimId: target.length ? pick(target).id : anyP(), seen: chance(0.9) } };
    }
    if (r < 0.3) return { type: 'muerte', payload: { cause: 'cazador', victimId: aliveP(), seen: chance(0.9) } };
    if (r < 0.34) return { type: 'muerte', payload: { cause: 'bruja', victimId: aliveP() } };
    if (r < 0.42) {
      const pend = v.deaths.filter((d) => d.status === 'pendiente' || chance(0.1));
      return { type: 'salvar', payload: { deathId: pend.length ? pick(pend).id : 'nada' } };
    }
    if (r < 0.48) return { type: 'chismoso', payload: { targetId: aliveP() } };
    if (r < 0.56) {
      const ghosts = v.players.filter((p) => p.status !== 'vivo');
      return { type: 'invocar', payload: { teamId: pick(v.teams).id, ghostId: ghosts.length && chance(0.9) ? pick(ghosts).id : anyP() } };
    }
    if (r < 0.62) {
      const q = v.invocations.filter((i) => i.status === 'en_fila');
      return { type: 'invocacionIniciar', payload: { id: q.length ? (chance(0.8) ? q[0].id : pick(q).id) : 'x' } };
    }
    if (r < 0.64) {
      const q = v.invocations.filter((i) => i.status === 'en_curso' || i.status === 'en_fila');
      return { type: chance(0.5) ? 'invocacionTerminar' : 'invocacionQuitar', payload: { id: q.length ? pick(q).id : 'x' } };
    }
    if (r < 0.8) return { type: 'asamblea' };
    if (r < 0.84) return { type: v.paused ? 'reanudar' : 'pausa' };
    if (r < 0.85) return { type: 'nota', payload: { text: 'Nota de prueba' } };
    if (r < 0.852) return { type: 'tiempos', payload: { juego: pick([20, 45, 60, 90]), ronda: pick([3, 5, 8]), debate: pick([1, 5]), avisoJuego: pick([0, 1, 5]), avisoRonda: pick([0, 1, 2]) } };
    if (r < 0.853) return { type: 'terminar' };
    return { type: pick(['paso', 'apuesta', 'votacion', 'nuevaRonda', 'iniciar', 'setup']), payload: {} }; // inválidas a propósito
  }
  if (v.phase === 'juego') {
    const a = v.round.assembly;
    const r = rng();
    if (a.step === 'apuestas' && r < 0.6) return { type: 'apuesta', payload: { teamId: pick(v.teams).id, playerId: aliveP() } };
    if (a.step === 'apuestas' && r < 0.65) return { type: 'quitarApuesta', payload: { teamId: pick(v.teams).id } };
    if (a.step === 'votacion' && r < 0.7) {
      const wolves = alive.filter((p) => p.role === 'lobo');
      const bet = a.bets.length && chance(0.5) ? pick(a.bets).playerId : null;
      return { type: 'votacion', payload: { playerId: chance(0.15) ? null : bet || (wolves.length && chance(0.4) ? pick(wolves).id : aliveP()) } };
    }
    if (a.step === 'resultado' && r < 0.8) return { type: 'nuevaRonda' };
    if (r < 0.85) {
      const steps = G.ASSEMBLY_STEPS;
      return { type: 'paso', payload: { to: chance(0.9) ? steps[steps.indexOf(a.step) + 1] : pick(steps) } };
    }
    if (r < 0.9) return { type: 'muerte', payload: { cause: 'lobo', byId: anyP(), victimId: anyP(), seen: true } };
    if (r < 0.93) return { type: 'chismoso', payload: { targetId: aliveP() } };
    if (r < 0.95) return { type: v.paused ? 'reanudar' : 'pausa' };
    return { type: 'invocar', payload: { teamId: pick(v.teams).id, ghostId: anyP() } };
  }
  return { type: 'nota', payload: { text: 'fin' } };
}

for (let g = 0; g < GAMES; g++) {
  stats.games++;
  let actions = [];
  let state = G.newGame({ code: `SIM${g}` });
  let t = 1_000_000;
  const push = (type, payload = {}, by = pick(['Ana', 'Beto', 'Caro'])) => {
    const a = { seq: actions.length, type, payload, by, at: t };
    const next = structuredClone(state);
    try {
      a.payload = G.prepareAction(next, a, rng);
      a.text = G.applyAction(next, a);
    } catch (e) {
      if (!(e instanceof G.GameError)) {
        failures++;
        console.error(`✗ Error inesperado en ${type}:`, e);
      }
      stats.rejected++;
      return false;
    }
    state = next;
    actions.push(a);
    stats.actions++;
    return true;
  };
  const undo = () => {
    const target = [...actions].reverse().find((a) => !a.undone && a.type !== 'deshacer');
    if (!target) return;
    actions = actions.map((a) => (a.seq === target.seq ? { ...a, undone: true } : a));
    actions.push({ seq: actions.length, type: 'deshacer', payload: { target: target.seq }, by: 'Ana', at: t, text: `Deshizo: ${target.text}` });
    state = G.replay(actions, { code: `SIM${g}` });
    stats.undos++;
  };

  const { teams, players } = makeTeamsAndPlayers();
  push('setup', { teams, players });
  push('asignarRoles');
  const auto = G.autoAssignRoles(teams, players.map((p) => ({ ...p })), rng);
  // El reparto automático usa exactamente las cantidades globales de la tabla
  const rec = G.recommendedRoles(players.length);
  for (const r of G.ROLES) assert(Object.values(auto.roles).filter((x) => x === r).length === rec[r], `El reparto automático no respeta la tabla para ${r}`, { g });
  if (chance(0.3)) push('rol', { playerId: pick(players).id, role: pick(G.ROLES) });
  push('senas', { lobo: 'tocarse la oreja', cazador: 'pistola con la mano' });
  if (!push('iniciar')) {
    push('asignarRoles');
    if (!push('iniciar')) {
      assert(false, 'No se pudo iniciar la partida', { g });
      continue;
    }
  }
  check(state, t, g);

  for (let step = 0; step < 600 && state.phase !== 'fin'; step++) {
    const r = rng();
    t += r < 0.3 ? 0 : r < 0.75 ? Math.floor(rng() * 20_000) : r < 0.95 ? 30_000 + Math.floor(rng() * 60_000) : 120_000 + Math.floor(rng() * 180_000);
    if (chance(0.03)) undo();
    else {
      const view = G.deriveView(state, t);
      if (view.phase === 'fin') break;
      if (view.phase === 'preparacion') {
        // Un "deshacer" pudo regresar a la preparación: se vuelve a iniciar.
        if (!push('iniciar')) {
          push('asignarRoles');
          push('iniciar');
        }
        continue;
      }
      const { type, payload } = randomAction(view);
      push(type, payload);
    }
    const v = check(state, t, g);
    if (step % 25 === 0) {
      const again = G.deriveView(G.replay(actions, { code: `SIM${g}` }), t);
      assert(JSON.stringify(again) === JSON.stringify(v), 'Reproducir las acciones no da el mismo estado', { g, step });
    }
    if (v.phase === 'fin') break;
  }
  // Si no terminó, el tiempo lo termina (la pausa congela el reloj: primero se reanuda)
  if (state.phase === 'juego' && state.clock.pausedAt != null) {
    const before = G.deriveView(state, t + state.config.gameMs + 60_000);
    assert(before.phase === 'juego', 'El tiempo corrió durante la pausa', { g });
    push('reanudar');
  }
  const end = G.deriveView(state, t + state.config.gameMs + 60_000);
  assert(end.phase === 'fin', 'El juego no terminó al acabarse el tiempo', { g });
  check(state, t + state.config.gameMs + 60_000, g);
  const reason = end.final.reason.startsWith('Se acabaron') ? 'tiempo' : end.final.reason.includes('mano') ? 'manual' : end.final.winner;
  stats.endings[reason] = (stats.endings[reason] || 0) + 1;
  stats.saves += end.deaths.filter((d) => d.status === 'salvada').length;
  stats.payouts += [...end.assemblies, end.round.assembly].filter((a) => a?.result?.winners.length).length;
}

console.log(`Partidas: ${stats.games} · acciones aplicadas: ${stats.actions} · rechazadas (inválidas): ${stats.rejected} · deshacer: ${stats.undos}`);
console.log(`Finales: ${JSON.stringify(stats.endings)} · bruja salvó: ${stats.saves} · botes cobrados: ${stats.payouts}`);
if (failures) {
  console.error(`\n✗ ${failures} violaciones de reglas.`);
  process.exit(1);
}
console.log('✓ Simulación correcta: ninguna regla se rompió.');
