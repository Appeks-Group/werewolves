// lib/game.mjs — Reglas puras de "Lobos en el parque". Sin dependencias.
//
// El estado de una partida se reconstruye siempre a partir de su lista de
// acciones (event sourcing). Así "deshacer" es simplemente marcar la última
// acción como deshecha y volver a reproducir todo.
//
// Todos los tiempos internos están en "tiempo de juego" (gt): milisegundos
// transcurridos desde el inicio, sin contar las pausas. Así una pausa congela
// a la vez el juego total, la ronda, el debate, la ventana de la bruja y la
// invocación.

export class GameError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GameError';
  }
}
function fail(msg) {
  throw new GameError(msg);
}

export const ROLES = ['lobo', 'aldeano', 'cazador', 'chismoso', 'martir', 'bruja'];
export const SPECIAL_ROLES = ['cazador', 'chismoso', 'martir', 'bruja'];
export const ROLE_NAMES = {
  lobo: 'Lobo',
  aldeano: 'Aldeano',
  cazador: 'Cazador',
  chismoso: 'Chismoso',
  martir: 'Mártir',
  bruja: 'Bruja',
};
export const CAUSE_NAMES = { lobo: 'lobo', cazador: 'cazador', bruja: 'bruja', votacion: 'votación' };
export const ASSEMBLY_STEPS = ['anuncio', 'apuestas', 'debate', 'votacion', 'resultado'];

export const DEFAULT_CONFIG = Object.freeze({
  gameMs: 60 * 60 * 1000,
  roundMs: 8 * 60 * 1000,
  debateMs: 5 * 60 * 1000,
  invokeMs: 30 * 1000,
  witchMs: 60 * 1000,
  startChips: 6,
  hunterBullets: 2,
  bonusMartir: 3,
  bonusIntegridad: 3,
  bonusApostador: 3,
  bonusLobos: 4,
});

// ---------------------------------------------------------------- utilidades

export function gameTime(clock, now) {
  if (!clock || clock.startedAt == null) return 0;
  const end = clock.pausedAt != null ? clock.pausedAt : now;
  return Math.max(0, end - clock.startedAt - clock.pausedTotal);
}
function wallAt(clock, gt) {
  if (!clock || clock.startedAt == null) return 0;
  return clock.startedAt + clock.pausedTotal + gt;
}
export const chipsOf = (t) => (t && t.ledger ? Object.values(t.ledger).reduce((a, b) => a + b, 0) : 0);
const isAlive = (p) => p.status === 'vivo';
const P = (s, id) => s.players.find((p) => p.id === id);
const T = (s, id) => s.teams.find((t) => t.id === id);
const teamName = (s, id) => T(s, id)?.name ?? '?';
const pname = (s, p) => `${p.name} (${teamName(s, p.teamId)})`;
const roleHolder = (s, role) => s.players.find((p) => p.role === role);
const aliveWolves = (s) => s.players.filter((p) => isAlive(p) && p.role === 'lobo').length;
const aliveVillagers = (s) => s.players.filter((p) => isAlive(p) && p.role !== 'lobo').length;
const joinNames = (arr) => (arr.length <= 1 ? arr.join('') : `${arr.slice(0, -1).join(', ')} y ${arr[arr.length - 1]}`);

function cleanName(v) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
}
function checkId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,24}$/.test(id)) fail('Identificador inválido.');
  return id;
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// --------------------------------------------------------------------- roles

/** Reparto recomendado según la tabla del juego. */
export function recommendedRoles(n) {
  const r = { lobo: 0, cazador: 0, chismoso: 0, martir: 0, bruja: 0, aldeano: 0 };
  if (n <= 0) return r;
  r.lobo = Math.max(1, Math.floor(n / 5)); // 8-9:1, 10-14:2, 15-19:3, 20-24:4, 25-29:5, 30-31:6
  if (n >= 3) r.cazador = 1;
  if (n >= 4) r.chismoso = 1;
  if (n >= 5) r.bruja = 1;
  if (n >= 10) r.martir = 1;
  r.aldeano = Math.max(0, n - r.lobo - r.cazador - r.chismoso - r.martir - r.bruja);
  return r;
}

export function roleCounts(players) {
  const c = Object.fromEntries(ROLES.map((r) => [r, 0]));
  for (const p of players) if (p.role) c[p.role]++;
  return c;
}

/** Advertencias sobre el reparto actual (no bloquean, salvo las que valida "iniciar"). */
export function roleWarnings(teams, players) {
  const w = [];
  if (!players.length) return w;
  const missing = players.filter((p) => !p.role).length;
  if (missing) w.push(`${missing} jugador(es) todavía no tienen rol.`);
  const c = roleCounts(players);
  for (const r of SPECIAL_ROLES) if (c[r] > 1) w.push(`Hay ${c[r]} con el rol ${ROLE_NAMES[r]}; solo puede haber uno.`);
  if (!missing) {
    if (!c.lobo) w.push('No hay ningún lobo.');
    else if (c.lobo >= players.length - c.lobo) w.push('Los lobos igualan o superan a los aldeanos: el juego terminaría al empezar.');
  }
  return w;
}

/**
 * Reparto automático: la cantidad de cada rol es global para toda la partida
 * (según la tabla) y se reparte al azar entre todos los jugadores, sin límites por equipo.
 */
export function autoAssignRoles(teams, players, rng = Math.random) {
  const n = players.length;
  const rec = recommendedRoles(n);
  const warnings = [];
  if (n && (n < 8 || n > 31)) warnings.push(`La tabla de roles está pensada para 8 a 31 jugadores (hay ${n}).`);
  const cards = shuffle(ROLES.flatMap((r) => Array(rec[r]).fill(r)), rng);
  const roles = {};
  players.forEach((p, i) => (roles[p.id] = cards[i] || 'aldeano'));
  warnings.push(...roleWarnings(teams, players.map((p) => ({ ...p, role: roles[p.id] }))));
  return { roles, warnings };
}

// -------------------------------------------------------------------- estado

export function newGame(meta = {}) {
  return {
    code: meta.code || '',
    createdAt: meta.createdAt || 0,
    config: { ...DEFAULT_CONFIG },
    phase: 'preparacion', // preparacion | juego | fin
    teams: Array.from({ length: 5 }, (_, i) => ({ id: `e${i + 1}`, name: `Equipo ${i + 1}` })),
    players: [],
    signs: { lobo: '', cazador: '' },
    deck: null, // tarjetas de rol preparadas para el reparto manual (null = las de la tabla)
    clock: { startedAt: null, pausedAt: null, pausedTotal: 0 },
    round: null,
    deaths: [],
    assemblies: [],
    invocations: [],
    gossip: [],
    pot: 0,
    firstDeathId: null,
    martyrPaid: false,
    witchSave: null,
    witchKill: null,
    final: null,
    log: [],
    publicLog: [],
    sysCount: 0,
  };
}

function sys(s, gt, text, pub) {
  s.sysCount++;
  s.log.push({ seq: null, sys: true, at: wallAt(s.clock, gt), gt, round: s.round?.n ?? 0, by: 'App', type: 'sistema', text });
  if (pub) pubLog(s, gt, wallAt(s.clock, gt), pub);
}
function pubLog(s, gt, at, text) {
  s.publicLog.push({ at, gt, round: s.round?.n ?? 0, text });
}

// Avanza el estado hasta el tiempo de juego gt: cierra ventanas de la bruja,
// termina invocaciones y detecta el fin por tiempo. Determinista e idempotente.
function tick(s, gt) {
  if (s.phase !== 'juego') return;
  for (;;) {
    const c = [{ t: s.config.gameMs, k: 2 }];
    for (const d of s.deaths) if (d.status === 'pendiente') c.push({ t: d.gt + s.config.witchMs, k: 0, d });
    for (const i of s.invocations) if (i.status === 'en_curso') c.push({ t: i.startGt + s.config.invokeMs, k: 1, i });
    c.sort((a, b) => a.t - b.t || a.k - b.k);
    const e = c[0];
    if (e.t > gt) return;
    if (e.k === 0) {
      confirmDeath(s, e.d, e.t, true);
    } else if (e.k === 1) {
      e.i.status = 'terminada';
      e.i.endGt = e.t;
      sys(s, e.t, `Terminó la invocación de ${teamName(s, e.i.teamId)} con el fantasma ${P(s, e.i.ghostId)?.name}.`);
    } else {
      for (const d of s.deaths) if (d.status === 'pendiente') confirmDeath(s, d, e.t, false);
      const wolves = aliveWolves(s);
      endGame(
        s,
        wolves > 0 ? 'lobos' : 'aldeanos',
        wolves > 0 ? `Se acabaron los ${s.config.gameMs / 60000} minutos con lobos vivos.` : 'Se acabó el tiempo sin lobos vivos.',
        e.t,
      );
      return;
    }
    if (s.phase !== 'juego') return;
  }
}

function confirmDeath(s, d, gt, check) {
  d.status = 'confirmada';
  d.confirmedGt = gt;
  const p = P(s, d.victimId);
  p.pendingDeathId = null;
  sys(
    s,
    gt,
    `Se cerró la ventana de la bruja: ${pname(s, p)} queda muerto. Su rol era ${ROLE_NAMES[p.role]}.`,
    `${p.name} (${teamName(s, p.teamId)}) cayó. Su rol era ${ROLE_NAMES[p.role]}.`,
  );
  killPlayer(s, p, d, gt);
  if (check) checkEnd(s, gt);
}

function killPlayer(s, p, d, gt) {
  p.status = p.role === 'lobo' ? 'fuera' : 'fantasma';
  p.deathId = d.id;
  p.diedRound = d.round;
  if (!s.firstDeathId) {
    s.firstDeathId = d.id;
    if (p.role === 'martir') {
      T(s, p.teamId).ledger.martir += s.config.bonusMartir;
      s.martyrPaid = true;
      sys(
        s,
        gt,
        `El mártir ${p.name} fue el primer muerto del juego: +${s.config.bonusMartir} fichas para ${teamName(s, p.teamId)}.`,
        `${teamName(s, p.teamId)} gana +${s.config.bonusMartir} fichas: ${p.name} era el mártir y fue el primer muerto.`,
      );
    }
  }
}

function checkEnd(s, gt) {
  if (s.phase !== 'juego') return;
  const wolves = aliveWolves(s);
  if (wolves === 0) endGame(s, 'aldeanos', 'Ya no queda ningún lobo vivo.', gt);
  else if (wolves >= aliveVillagers(s)) endGame(s, 'lobos', 'Los lobos vivos igualan o superan a los aldeanos vivos.', gt);
}

function endGame(s, winner, reason, gt) {
  for (const d of s.deaths) if (d.status === 'pendiente') confirmDeath(s, d, gt, false);
  for (const i of s.invocations) {
    if (i.status === 'en_fila') i.status = 'perdida';
    if (i.status === 'en_curso') {
      i.status = 'terminada';
      i.endGt = gt;
    }
  }
  s.phase = 'fin';
  const cfg = s.config;
  for (const t of s.teams) if (!t.expelled.length) t.ledger.integridad += cfg.bonusIntegridad;
  const best = Math.max(0, ...s.teams.map((t) => t.correctBets));
  const bestTeams = best > 0 ? s.teams.filter((t) => t.correctBets === best) : [];
  for (const t of bestTeams) t.ledger.apostador += cfg.bonusApostador;
  const wolfTeams = [];
  if (winner === 'lobos') {
    for (const t of s.teams) {
      if (s.players.some((p) => p.teamId === t.id && p.role === 'lobo' && isAlive(p))) {
        t.ledger.lobos += cfg.bonusLobos;
        wolfTeams.push(t.id);
      }
    }
  }
  const max = Math.max(...s.teams.map(chipsOf));
  const topTeams = s.teams.filter((t) => chipsOf(t) === max).map((t) => t.id);
  s.final = { winner, reason, endGt: gt, potLeft: s.pot, topTeams, bestBettors: bestTeams.map((t) => t.id), wolfTeams };
  const w = winner === 'lobos' ? 'Ganan los lobos' : 'Ganan los aldeanos';
  const top = joinNames(topTeams.map((id) => teamName(s, id)));
  sys(s, gt, `Fin del juego. ${w}. ${reason} Más fichas: ${top} (${max}).`, `Fin del juego. ${w}. ${reason} Equipo con más fichas: ${top} (${max}).`);
}

// ------------------------------------------------------------------ acciones

function needPhase(s, phase) {
  if (s.phase === phase) return;
  if (s.phase === 'fin') fail('El juego ya terminó.');
  if (phase === 'preparacion') fail('El juego ya empezó; esto solo se puede cambiar en la preparación.');
  fail('El juego todavía no ha empezado.');
}
const needPlaying = (s) => needPhase(s, 'juego');
function needStage(s, stage, msg) {
  needPlaying(s);
  if (s.round.stage !== stage) fail(msg);
}
function needStep(s, step, msg) {
  needStage(s, 'asamblea', 'No hay ninguna asamblea en curso.');
  if (s.round.assembly.step !== step) fail(msg);
}

const HANDLERS = {
  // ---- preparación
  setup(s, p) {
    needPhase(s, 'preparacion');
    if (!Array.isArray(p.teams)) fail('Faltan los equipos.');
    if (p.teams.length < 2 || p.teams.length > 12) fail('Debe haber entre 2 y 12 equipos.');
    const tids = new Set();
    const teams = p.teams.map((t, i) => {
      const id = checkId(t.id);
      if (tids.has(id)) fail('Hay equipos repetidos.');
      tids.add(id);
      const name = cleanName(t.name);
      if (!name) fail(`El equipo ${i + 1} no tiene nombre.`);
      return { id, name };
    });
    const list = Array.isArray(p.players) ? p.players : [];
    if (list.length > 100) fail('Máximo 100 jugadores.');
    const pids = new Set();
    const old = new Map(s.players.map((x) => [x.id, x.role]));
    const players = list.map((x) => {
      const id = checkId(x.id);
      if (pids.has(id)) fail('Hay jugadores repetidos.');
      pids.add(id);
      const name = cleanName(x.name);
      if (!name) fail('Hay un jugador sin nombre.');
      if (!tids.has(x.teamId)) fail(`El equipo de ${name} no existe.`);
      return { id, name, teamId: x.teamId, role: old.get(id) ?? null };
    });
    s.teams = teams;
    s.players = players;
    return `Preparación guardada: ${teams.length} equipos y ${players.length} jugadores.`;
  },

  asignarRoles(s, p) {
    needPhase(s, 'preparacion');
    if (!s.players.length) fail('Primero captura a los jugadores.');
    const roles = p.roles || {};
    for (const pl of s.players) if (!ROLES.includes(roles[pl.id])) fail('El reparto de roles está incompleto.');
    for (const pl of s.players) pl.role = roles[pl.id];
    const c = roleCounts(s.players);
    return `Roles repartidos automáticamente: ${c.lobo} lobo(s), ${SPECIAL_ROLES.filter((r) => c[r]).map((r) => ROLE_NAMES[r].toLowerCase()).join(', ')} y ${c.aldeano} aldeano(s).`;
  },

  rol(s, p) {
    needPhase(s, 'preparacion');
    const pl = P(s, p.playerId);
    if (!pl) fail('Jugador no encontrado.');
    if (p.role == null || p.role === '') {
      pl.role = null;
      return `Se quitó el rol de ${pname(s, pl)}.`;
    }
    if (!ROLES.includes(p.role)) fail('Rol inválido.');
    pl.role = p.role;
    return `Rol de ${pname(s, pl)}: ${ROLE_NAMES[p.role]}.`;
  },

  mazo(s, p) {
    needPhase(s, 'preparacion');
    if (p.counts == null) {
      s.deck = null;
      return 'Tarjetas de rol: se usan las de la tabla.';
    }
    const deck = {};
    for (const r of ROLES) {
      const n = p.counts[r] ?? 0;
      if (!Number.isInteger(n) || n < 0 || n > 100) fail('Cantidad de tarjetas inválida.');
      deck[r] = n;
    }
    for (const r of SPECIAL_ROLES) if (deck[r] > 1) fail(`Solo puede haber una tarjeta de ${ROLE_NAMES[r]}.`);
    s.deck = deck;
    return `Tarjetas de rol: ${ROLES.filter((r) => deck[r]).map((r) => `${deck[r]} ${ROLE_NAMES[r]}`).join(', ')}.`;
  },

  senas(s, p) {
    if (s.phase === 'fin') fail('El juego ya terminó.');
    const clean = (v) => (typeof v === 'string' ? v.trim().slice(0, 200) : '');
    s.signs = { lobo: clean(p.lobo), cazador: clean(p.cazador) };
    return 'Señas de lobo y cazador actualizadas.';
  },

  iniciar(s, p, c) {
    needPhase(s, 'preparacion');
    const n = s.players.length;
    if (n < 3) fail('Se necesitan al menos 3 jugadores.');
    if (s.players.some((x) => !ROLES.includes(x.role))) fail('Todos los jugadores necesitan un rol. Reparte los roles primero.');
    for (const t of s.teams) if (!s.players.some((x) => x.teamId === t.id)) fail(`${t.name} no tiene jugadores; agrega jugadores o quita el equipo.`);
    const cnt = roleCounts(s.players);
    for (const r of SPECIAL_ROLES) if (cnt[r] > 1) fail(`Solo puede haber un ${ROLE_NAMES[r]}.`);
    if (!cnt.lobo) fail('Debe haber al menos un lobo.');
    if (cnt.lobo >= n - cnt.lobo) fail('Hay demasiados lobos: deben ser menos que los aldeanos.');
    s.phase = 'juego';
    s.clock = { startedAt: c.at, pausedAt: null, pausedTotal: 0 };
    for (const t of s.teams) {
      t.ledger = { inicial: s.config.startChips, apuestas: 0, cobros: 0, martir: 0, integridad: 0, apostador: 0, lobos: 0 };
      t.correctBets = 0;
      t.betsMade = 0;
      t.expelled = [];
    }
    for (const x of s.players) Object.assign(x, { status: 'vivo', pendingDeathId: null, deathId: null, diedRound: null });
    s.round = { n: 1, startGt: 0, stage: 'ronda', assembly: null };
    pubLog(s, 0, c.at, 'Comienza el juego. Arranca la ronda 1.');
    return 'Comenzó el juego. Arranca la ronda 1.';
  },

  // ---- tiempo
  pausa(s, p, c) {
    needPlaying(s);
    if (s.clock.pausedAt != null) fail('El juego ya está en pausa.');
    s.clock.pausedAt = c.at;
    pubLog(s, c.gt, c.at, 'Juego en pausa.');
    return 'Pausó el juego.';
  },
  reanudar(s, p, c) {
    needPlaying(s);
    if (s.clock.pausedAt == null) fail('El juego no está en pausa.');
    s.clock.pausedTotal += c.at - s.clock.pausedAt;
    s.clock.pausedAt = null;
    pubLog(s, c.gt, c.at, 'Se reanuda el juego.');
    return 'Reanudó el juego.';
  },

  // ---- muertes y bruja
  muerte(s, p, c) {
    needStage(s, 'ronda', 'Durante la asamblea no se registran muertes.');
    const cause = p.cause;
    if (!['lobo', 'cazador', 'bruja'].includes(cause)) fail('Elige la causa: lobo, cazador o bruja. Las expulsiones se registran en la votación de la asamblea.');
    const v = P(s, p.victimId);
    if (!v) fail('Elige a la víctima.');
    if (!isAlive(v)) fail(`${v.name} ya está muerto.`);
    if (v.pendingDeathId) fail(`${v.name} ya tiene una muerte en la ventana de la bruja.`);
    const n = s.round.n;
    let by;
    if (cause === 'lobo') {
      by = P(s, p.byId);
      if (!by || by.role !== 'lobo') fail('Elige qué lobo hizo la seña.');
      if (!isAlive(by)) fail(`${by.name} ya no está en juego.`);
      if (v.role === 'lobo') fail('Un lobo no puede eliminar a otro lobo.');
      if (s.deaths.some((d) => d.cause === 'lobo' && d.byId === by.id && d.round === n)) fail(`${by.name} ya eliminó a alguien en esta ronda.`);
    } else if (cause === 'cazador') {
      by = roleHolder(s, 'cazador');
      if (!by) fail('No hay cazador en esta partida.');
      if (!isAlive(by)) fail('El cazador ya no está en juego.');
      if (by.id === v.id) fail('El cazador no puede dispararse a sí mismo.');
      const shots = s.deaths.filter((d) => d.cause === 'cazador');
      if (shots.length >= s.config.hunterBullets) fail(`El cazador ya usó sus ${s.config.hunterBullets} balas.`);
      if (shots.some((d) => d.round === n)) fail('El cazador ya disparó en esta ronda (máximo una bala por ronda).');
    } else {
      by = roleHolder(s, 'bruja');
      if (!by) fail('No hay bruja en esta partida.');
      if (!isAlive(by)) fail('La bruja ya no está en juego.');
      if (by.id === v.id) fail('La bruja no puede usar la pócima de matar sobre sí misma.');
      if (s.witchKill) fail('La bruja ya usó su pócima de matar.');
    }
    if (cause !== 'bruja' && p.seen !== true) fail('Las muertes por seña solo cuentan si un jefe las vio. Marca "Yo lo vi".');
    const d = { id: `m${c.seq}`, round: n, gt: c.gt, at: c.at, victimId: v.id, cause, byId: by.id, seenBy: c.by, status: 'pendiente', window: true };
    s.deaths.push(d);
    v.pendingDeathId = d.id;
    if (cause === 'bruja') s.witchKill = d.id;
    const who = cause === 'bruja' ? `la bruja ${by.name}; lo informó ${c.by}` : `${by.name}; la vio ${c.by}`;
    return `Muerte por ${CAUSE_NAMES[cause]}: ${pname(s, v)}. La causó ${who}. Se abre la ventana de la bruja (1 min).`;
  },

  salvar(s, p, c) {
    needPlaying(s);
    const d = s.deaths.find((x) => x.id === p.deathId);
    if (!d) fail('No hay ninguna muerte en la ventana de la bruja.');
    if (d.status === 'salvada') fail('Esa víctima ya fue salvada.');
    if (d.status !== 'pendiente') fail('La ventana de la bruja ya se cerró para esa muerte.');
    const w = roleHolder(s, 'bruja');
    if (!w) fail('No hay bruja en esta partida.');
    if (!isAlive(w)) fail('La bruja ya no está en juego.');
    if (s.witchSave) fail('La bruja ya usó su pócima de salvar.');
    d.status = 'salvada';
    d.savedGt = c.gt;
    d.savedBy = c.by;
    s.witchSave = d.id;
    const v = P(s, d.victimId);
    v.pendingDeathId = null;
    return `La bruja salvó a ${pname(s, v)}. La muerte se anula.`;
  },

  // ---- chismoso
  chismoso(s, p, c) {
    needPlaying(s);
    const ch = roleHolder(s, 'chismoso');
    if (!ch) fail('No hay chismoso en esta partida.');
    if (!isAlive(ch)) fail('El chismoso ya no está en juego.');
    if (s.gossip.some((g) => g.round === s.round.n)) fail('El chismoso ya hizo su consulta en esta ronda.');
    const t = P(s, p.targetId);
    if (!t) fail('Elige a la persona por la que pregunta.');
    if (t.id === ch.id) fail('El chismoso no puede preguntar por sí mismo.');
    if (!isAlive(t)) fail(`${t.name} ya está muerto; su rol ya se reveló.`);
    s.gossip.push({ id: `c${c.seq}`, round: s.round.n, gt: c.gt, targetId: t.id, role: t.role, by: c.by });
    return `El chismoso (${ch.name}) preguntó por ${pname(s, t)}: se le dijo "${ROLE_NAMES[t.role]}".`;
  },

  // ---- invocación
  invocar(s, p, c) {
    needStage(s, 'ronda', 'Las invocaciones se hacen durante la ronda.');
    const t = T(s, p.teamId);
    if (!t) fail('Elige el equipo.');
    if (!s.players.some((x) => x.teamId === t.id && isAlive(x))) fail(`${t.name} no tiene jugadores vivos.`);
    if (s.invocations.some((i) => i.teamId === t.id && i.round === s.round.n && i.status !== 'cancelada')) fail(`${t.name} ya usó su invocación en esta ronda.`);
    const g = P(s, p.ghostId);
    if (!g || g.status !== 'fantasma') fail('Elige a un fantasma (aldeano muerto). Los lobos expulsados no son fantasmas.');
    s.invocations.push({ id: `i${c.seq}`, round: s.round.n, teamId: t.id, ghostId: g.id, status: 'en_fila', queuedGt: c.gt, queuedBy: c.by });
    return `${t.name} se formó en la fila para invocar al fantasma ${g.name}.`;
  },
  invocacionIniciar(s, p, c) {
    needStage(s, 'ronda', 'Las invocaciones se hacen durante la ronda.');
    const i = s.invocations.find((x) => x.id === p.id);
    if (!i || i.status !== 'en_fila') fail('Esa invocación ya no está en la fila.');
    if (s.invocations.some((x) => x.status === 'en_curso')) fail('Ya hay una invocación en curso.');
    const first = s.invocations.find((x) => x.status === 'en_fila');
    if (first.id !== i.id) fail(`Respeta el orden de llegada: primero va ${teamName(s, first.teamId)}.`);
    i.status = 'en_curso';
    i.startGt = c.gt;
    i.startedBy = c.by;
    return `Empieza la invocación de ${teamName(s, i.teamId)} con el fantasma ${P(s, i.ghostId).name} (30 s).`;
  },
  invocacionTerminar(s, p, c) {
    needPlaying(s);
    const i = s.invocations.find((x) => x.id === p.id);
    if (!i || i.status !== 'en_curso') fail('Esa invocación no está en curso.');
    i.status = 'terminada';
    i.endGt = c.gt;
    return `Terminó antes de tiempo la invocación de ${teamName(s, i.teamId)}.`;
  },
  invocacionQuitar(s, p) {
    needPlaying(s);
    const i = s.invocations.find((x) => x.id === p.id);
    if (!i || i.status !== 'en_fila') fail('Esa invocación ya no está en la fila.');
    i.status = 'cancelada';
    return `${teamName(s, i.teamId)} salió de la fila de invocación (puede volver a formarse).`;
  },

  // ---- asamblea
  asamblea(s, p, c) {
    needStage(s, 'ronda', 'Ya hay una asamblea en curso.');
    if (s.deaths.some((d) => d.status === 'pendiente')) fail('Espera a que se cierre la ventana de la bruja.');
    const n = s.round.n;
    let lost = 0;
    for (const i of s.invocations) {
      if (i.round !== n) continue;
      if (i.status === 'en_fila') {
        i.status = 'perdida';
        lost++;
      } else if (i.status === 'en_curso') {
        i.status = 'terminada';
        i.endGt = c.gt;
      }
    }
    const fallen = s.deaths.filter((d) => d.round === n && d.status === 'confirmada' && d.cause !== 'votacion').map((d) => P(s, d.victimId));
    let text;
    if (!fallen.length) text = 'Esta ronda nadie murió.';
    else if (fallen.length === 1) text = `Esta ronda cayó ${fallen[0].name}. Su rol era ${ROLE_NAMES[fallen[0].role]}.`;
    else text = `Esta ronda cayeron ${joinNames(fallen.map((f) => `${f.name} (su rol era ${ROLE_NAMES[f.role]})`))}.`;
    s.round.stage = 'asamblea';
    s.round.endGt = c.gt;
    s.round.assembly = { round: n, step: 'anuncio', startGt: c.gt, text, fallen: fallen.map((f) => f.id), bets: [], debateStartGt: null, vote: null, result: null };
    pubLog(s, c.gt, c.at, `Asamblea de la ronda ${n}. ${text}`);
    return `Comenzó la asamblea de la ronda ${n}.${lost ? ` ${lost} equipo(s) seguían en la fila y perdieron su invocación.` : ''}`;
  },

  paso(s, p, c) {
    needStage(s, 'asamblea', 'No hay ninguna asamblea en curso.');
    const a = s.round.assembly;
    if (p.to === 'resultado') fail('El resultado se obtiene al registrar la votación.');
    if (ASSEMBLY_STEPS.indexOf(p.to) !== ASSEMBLY_STEPS.indexOf(a.step) + 1) fail('Sigue los pasos de la asamblea en orden.');
    a.step = p.to;
    if (p.to === 'debate') a.debateStartGt = c.gt;
    return { apuestas: 'Asamblea: se abren las apuestas.', debate: 'Asamblea: empieza el debate (5 min).', votacion: 'Asamblea: votación.' }[p.to];
  },

  apuesta(s, p, c) {
    needStep(s, 'apuestas', 'Las apuestas se hacen en el paso de apuestas de la asamblea.');
    const a = s.round.assembly;
    const t = T(s, p.teamId);
    if (!t) fail('Elige el equipo.');
    if (a.bets.some((b) => b.teamId === t.id)) fail(`${t.name} ya apostó en esta asamblea (máximo 1 ficha).`);
    if (chipsOf(t) < 1) fail(`${t.name} no tiene fichas para apostar.`);
    const target = P(s, p.playerId);
    if (!target || !isAlive(target)) fail('Solo se puede apostar por un jugador vivo.');
    t.ledger.apuestas -= 1;
    t.betsMade++;
    s.pot += 1;
    a.bets.push({ teamId: t.id, playerId: target.id });
    pubLog(s, c.gt, c.at, `${t.name} apostó 1 ficha por ${target.name}.`);
    return `${t.name} apostó 1 ficha por ${pname(s, target)}. Bote: ${s.pot}.`;
  },
  quitarApuesta(s, p, c) {
    needStep(s, 'apuestas', 'Las apuestas solo se pueden cambiar en el paso de apuestas.');
    const a = s.round.assembly;
    const idx = a.bets.findIndex((b) => b.teamId === p.teamId);
    if (idx < 0) fail('Ese equipo no ha apostado.');
    const t = T(s, p.teamId);
    a.bets.splice(idx, 1);
    t.ledger.apuestas += 1;
    t.betsMade--;
    s.pot -= 1;
    pubLog(s, c.gt, c.at, `${t.name} retiró su apuesta.`);
    return `${t.name} retiró su apuesta. Bote: ${s.pot}.`;
  },

  votacion(s, p, c) {
    needStep(s, 'votacion', 'Primero pasa al paso de votación.');
    const a = s.round.assembly;
    const potBefore = s.pot;
    if (p.playerId == null) {
      a.vote = { tie: true, playerId: null };
      a.result = { potBefore, expelledId: null, role: null, winners: [], share: 0, potAfter: s.pot, tie: true };
      a.step = 'resultado';
      pubLog(s, c.gt, c.at, `Votación: empate, nadie sale. El bote (${s.pot}) se acumula.`);
      return `Votación: empate, nadie sale. El bote de ${s.pot} se acumula.`;
    }
    const v = P(s, p.playerId);
    if (!v || !isAlive(v)) fail('Elige a un jugador vivo.');
    const d = { id: `m${c.seq}`, round: s.round.n, gt: c.gt, at: c.at, victimId: v.id, cause: 'votacion', byId: null, seenBy: c.by, status: 'confirmada', confirmedGt: c.gt, window: false };
    s.deaths.push(d);
    T(s, v.teamId).expelled.push(v.id);
    let winners = [];
    let share = 0;
    if (v.role === 'lobo') {
      winners = a.bets.filter((b) => b.playerId === v.id).map((b) => b.teamId);
      if (winners.length) {
        share = Math.floor(s.pot / winners.length);
        for (const id of winners) {
          T(s, id).ledger.cobros += share;
          T(s, id).correctBets++;
        }
        s.pot -= share * winners.length;
      }
    }
    a.vote = { tie: false, playerId: v.id };
    a.result = { potBefore, expelledId: v.id, role: v.role, winners, share, potAfter: s.pot, tie: false };
    a.step = 'resultado';
    const potText = winners.length
      ? `El bote de ${potBefore} se reparte: ${joinNames(winners.map((id) => teamName(s, id)))} ${winners.length === 1 ? 'cobra' : 'cobran'} ${share} ficha${share === 1 ? '' : 's'}${winners.length === 1 ? '' : ' cada uno'}; ${s.pot === 1 ? 'queda 1' : `quedan ${s.pot}`} en el bote.`
      : `El bote (${s.pot}) se acumula para la siguiente asamblea.`;
    pubLog(s, c.gt, c.at, `Votación: ${v.name} (${teamName(s, v.teamId)}) fue expulsado. Su rol era ${ROLE_NAMES[v.role]}. ${potText}`);
    killPlayer(s, v, d, c.gt);
    checkEnd(s, c.gt);
    return `Votación: expulsado ${pname(s, v)}, era ${ROLE_NAMES[v.role]}. ${potText}`;
  },

  nuevaRonda(s, p, c) {
    needStep(s, 'resultado', 'Primero registra la votación.');
    s.assemblies.push(s.round.assembly);
    const n = s.round.n + 1;
    s.round = { n, startGt: c.gt, stage: 'ronda', assembly: null };
    pubLog(s, c.gt, c.at, `Comienza la ronda ${n}.`);
    return `Comienza la ronda ${n} (8 min).`;
  },

  // ---- varios
  nota(s, p) {
    const text = typeof p.text === 'string' ? p.text.trim().slice(0, 300) : '';
    if (!text) fail('Escribe la nota.');
    return `Nota: ${text}`;
  },
  terminar(s, p, c) {
    needPlaying(s);
    // Al terminar ya no hay bruja que salve: las muertes en la ventana se confirman antes de decidir el ganador.
    for (const d of s.deaths) if (d.status === 'pendiente') confirmDeath(s, d, c.gt, false);
    const wolves = aliveWolves(s);
    endGame(s, wolves > 0 ? 'lobos' : 'aldeanos', `El juego se terminó a mano (lo registró ${c.by}).`, c.gt);
    return 'Terminó el juego a mano.';
  },
};

export const ACTION_TYPES = Object.keys(HANDLERS);

/** Completa las partes aleatorias de una acción antes de guardarla (para que la reproducción sea determinista). */
export function prepareAction(s, action, rng = Math.random) {
  if (action.type === 'asignarRoles') {
    needPhase(s, 'preparacion');
    const { roles, warnings } = autoAssignRoles(s.teams, s.players, rng);
    return { roles, warnings };
  }
  return action.payload || {};
}

/** Aplica una acción al estado (lo modifica). Lanza GameError si no es válida. */
export function applyAction(s, a) {
  const gt0 = gameTime(s.clock, a.at);
  tick(s, gt0);
  const h = HANDLERS[a.type];
  if (!h) fail('Acción desconocida.');
  const gt = s.final ? Math.min(gt0, s.final.endGt) : gt0;
  const round = s.round?.n ?? 0;
  const idx = s.log.length;
  const by = a.by || 'Jefe';
  const text = h(s, a.payload || {}, { gt, at: a.at, by, seq: a.seq });
  s.log.splice(idx, 0, { seq: a.seq, at: a.at, gt, round, by, type: a.type, text });
  return text;
}

/** Reconstruye el estado a partir de la lista completa de acciones (incluye las deshechas en la bitácora). */
export function replay(actions, meta = {}) {
  const s = newGame(meta);
  for (const a of actions) {
    if (a.type === 'deshacer' || a.undone) {
      tick(s, gameTime(s.clock, a.at));
      s.log.push({ seq: a.seq, at: a.at, gt: null, round: s.round?.n ?? 0, by: a.by, type: a.type, text: a.text || a.type, undone: !!a.undone, isUndo: a.type === 'deshacer' });
      continue;
    }
    try {
      applyAction(s, a);
    } catch (e) {
      s.log.push({ seq: a.seq, at: a.at, gt: null, round: s.round?.n ?? 0, by: a.by, type: a.type, text: `(No se pudo reproducir: ${e.message})`, error: true });
    }
  }
  return s;
}

function deckWarnings(s) {
  if (s.phase !== 'preparacion' || !s.deck || !s.players.length) return [];
  const total = Object.values(s.deck).reduce((a, b) => a + b, 0);
  return total === s.players.length ? [] : [`Hay ${total} tarjetas de rol y ${s.players.length} jugadores.`];
}

/** Vista completa para jefes en el instante `now`. */
export function deriveView(state, now) {
  const s = structuredClone(state);
  tick(s, gameTime(s.clock, now));
  let gt = gameTime(s.clock, now);
  if (s.final) gt = Math.min(gt, s.final.endGt);
  for (const t of s.teams) if (t.ledger) t.chips = chipsOf(t);
  return {
    ...s,
    now,
    gt,
    paused: s.clock.pausedAt != null,
    warnings: deckWarnings(s).concat(roleWarnings(s.teams, s.players)),
    recommended: recommendedRoles(s.players.length),
    deck: s.deck || recommendedRoles(s.players.length),
    deckCustom: !!s.deck,
    counts: roleCounts(s.players),
  };
}

/** Vista de solo lectura para la pantalla pública: sin roles secretos, sin autores de muertes, sin consultas del chismoso. */
export function publicView(state, now) {
  const v = deriveView(state, now);
  const ended = v.phase === 'fin';
  const a = v.round?.assembly;
  return {
    code: v.code,
    phase: v.phase,
    now,
    gt: v.gt,
    paused: v.paused,
    sysCount: v.sysCount,
    config: { gameMs: v.config.gameMs, roundMs: v.config.roundMs, debateMs: v.config.debateMs, startChips: v.config.startChips },
    clock: v.clock,
    round: v.round && {
      n: v.round.n,
      startGt: v.round.startGt,
      stage: v.round.stage,
      assembly: a && {
        step: a.step,
        text: a.text,
        bets: a.bets.map((b) => ({ teamId: b.teamId, playerId: b.playerId })),
        debateStartGt: a.debateStartGt,
        result: a.result && { ...a.result },
      },
    },
    pot: v.pot,
    teams: v.teams.map((t) => ({
      id: t.id,
      name: t.name,
      chips: t.ledger ? t.chips : v.config.startChips,
      expelled: !!t.expelled?.length,
      ledger: ended ? { ...t.ledger } : undefined,
    })),
    players: v.players.map((p) => {
      const dead = p.status === 'fantasma' || p.status === 'fuera';
      return { id: p.id, name: p.name, teamId: p.teamId, status: dead ? p.status : 'vivo', role: dead || ended ? p.role : null };
    }),
    log: v.publicLog.map((e) => ({ ...e })),
    final: v.final && { winner: v.final.winner, reason: v.final.reason, endGt: v.final.endGt, potLeft: v.final.potLeft, topTeams: v.final.topTeams },
  };
}
