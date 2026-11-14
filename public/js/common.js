// Utilidades compartidas del navegador.

export const ROLE_NAMES = { lobo: 'Lobo', aldeano: 'Aldeano', cazador: 'Cazador', chismoso: 'Chismoso', martir: 'Mártir', bruja: 'Bruja' };
export const ROLE_ICON = { lobo: '🐺', aldeano: '🏡', cazador: '🏹', chismoso: '👂', martir: '🕯️', bruja: '🧪' };
export const ROLE_HELP = {
  lobo: 'Elimina con la seña de lobo a una persona por ronda. Conoce a los demás lobos.',
  aldeano: 'Sin poder especial. Descubre a los lobos y apuesta bien.',
  cazador: 'Tiene 2 balas en todo el juego, máximo una por ronda. Dispara con la seña de cazador.',
  chismoso: 'Cada ronda puede preguntarle a un jefe el rol de una persona.',
  martir: 'Si es el primer muerto del juego, su equipo gana +3 fichas.',
  bruja: 'Una pócima para salvar (1 min después de una muerte) y una para matar. Cada una de un solo uso.',
};
export const SPECIAL_ROLES = ['cazador', 'chismoso', 'martir', 'bruja'];
export const ROLES = ['lobo', 'aldeano', ...SPECIAL_ROLES];
export const STATUS_NAMES = { vivo: 'Vivo', fantasma: 'Fantasma', fuera: 'Fuera' };
export const CAUSE_NAMES = { lobo: 'Lobo', cazador: 'Cazador', bruja: 'Bruja', votacion: 'Votación' };

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Formatea una cuenta regresiva (redondea hacia arriba). */
export function fmtDown(ms) {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}
export function fmtUp(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}
export const fmtClock = (at) => (at ? new Date(at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');

export function gameTime(clock, now) {
  if (!clock || clock.startedAt == null) return 0;
  const end = clock.pausedAt != null ? clock.pausedAt : now;
  return Math.max(0, end - clock.startedAt - clock.pausedTotal);
}

// ---- reloj del servidor: compensamos la diferencia de hora de cada teléfono
const samples = [];
let offset = 0;
function sampleClock(serverNow, t0, t1) {
  samples.push({ rtt: t1 - t0, off: serverNow - (t0 + t1) / 2 });
  if (samples.length > 10) samples.shift();
  offset = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a)).off;
}
export const serverNow = () => Date.now() + offset;

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const t0 = Date.now();
  const res = await fetch(`/api${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const t1 = Date.now();
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* sin cuerpo */
  }
  if (data.now) sampleClock(data.now, t0, t1);
  if (!res.ok) {
    const err = new Error(data.error || `Error del servidor (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const newId = (prefix) => prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3);

export function lsGet(k, def = null) {
  try {
    const v = localStorage.getItem(k);
    return v == null ? def : v;
  } catch {
    return def;
  }
}
export function lsSet(k, v) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* almacenamiento no disponible */
  }
}

export function rememberGame(code, token) {
  let list = [];
  try {
    list = JSON.parse(lsGet('lobos-partidas', '[]')) || [];
  } catch {
    list = [];
  }
  list = [{ code, token, at: Date.now() }, ...list.filter((g) => g.code !== code)].slice(0, 8);
  lsSet('lobos-partidas', JSON.stringify(list));
}
export function recentGames() {
  try {
    return JSON.parse(lsGet('lobos-partidas', '[]')) || [];
  } catch {
    return [];
  }
}

// ---- avisos
let audioCtx = null;
export function beep(times = 3) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < times; i++) {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'square';
      o.frequency.value = 880;
      const t = audioCtx.currentTime + i * 0.35;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      o.connect(g).connect(audioCtx.destination);
      o.start(t);
      o.stop(t + 0.3);
    }
  } catch {
    /* sin audio */
  }
}
export function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch {
    /* sin audio */
  }
}
export function vibrate(pattern) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch {
    /* sin vibración */
  }
}

let toastTimer;
export function toast(msg, kind = 'ok') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), kind === 'error' ? 5000 : 2500);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Enlace copiado.');
  } catch {
    window.prompt('Copia este enlace:', text);
  }
}
export const waLink = (text) => `https://wa.me/?text=${encodeURIComponent(text)}`;

export function renderQr(el, text) {
  if (!el) return;
  el.innerHTML = '';
  if (!window.QRCode) {
    el.textContent = 'No se pudo cargar el generador de QR (sin internet).';
    return;
  }
  new window.QRCode(el, { text, width: 220, height: 220, correctLevel: window.QRCode.CorrectLevel.M });
}

export function download(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 500);
}

export const jefeLink = (code, token) => `${location.origin}/?g=${code}&t=${token}`;
export const publicLink = (code, p) => `${location.origin}/?g=${code}&p=${p}`;

/** Bloque para compartir un enlace: copiar, WhatsApp y QR. */
export function shareBlock({ id, title, desc, url, waText, openLabel }) {
  return `<section class="card share">
    <h3>${esc(title)}</h3>
    <p class="muted">${esc(desc)}</p>
    <div class="linkbox" data-select>${esc(url)}</div>
    <div class="btnrow">
      <button class="btn" data-act="copy" data-url="${esc(url)}">📋 Copiar</button>
      <a class="btn wa" href="${esc(waLink(waText))}" target="_blank" rel="noopener">WhatsApp</a>
      <button class="btn" data-act="qr" data-target="qr-${id}" data-url="${esc(url)}">QR</button>
      ${openLabel ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">${esc(openLabel)}</a>` : ''}
    </div>
    <div class="qr" id="qr-${id}"></div>
  </section>`;
}
