// Pantalla pública de solo lectura (para proyectar o enseñar a los muchachos).
import { ROLE_NAMES, ROLE_ICON, esc, fmtDown, fmtClock, gameTime, serverNow, api } from './common.js';

const STEP = { anuncio: 'Anuncio', apuestas: 'Apuestas', debate: 'Debate', votacion: 'Votación', resultado: 'Resultado' };

export function startPantalla(root, code, p) {
  let vw = null;
  let etag = null;
  let error = null;
  let online = true;

  const gtNow = () => {
    if (!vw) return 0;
    let g = gameTime(vw.clock, serverNow());
    if (vw.final) g = Math.min(g, vw.final.endGt);
    return g;
  };
  const tname = (id) => esc(vw.teams.find((t) => t.id === id)?.name ?? '?');

  async function poll() {
    try {
      const r = await api(`/partidas/${code}/publica?p=${encodeURIComponent(p)}${etag ? `&since=${encodeURIComponent(etag)}` : ''}`);
      online = true;
      error = null;
      if (!r.unchanged) {
        vw = r.view;
        etag = r.etag;
        render();
      }
    } catch (e) {
      online = false;
      if (e.status === 403 || e.status === 404) {
        error = e.message;
        render();
      }
    }
    document.getElementById('sync')?.classList.toggle('off', !online);
  }

  function render() {
    if (error) {
      root.innerHTML = `<main class="wrap"><section class="card center"><h2>😕 ${esc(error)}</h2></section></main>`;
      return;
    }
    if (!vw) {
      root.innerHTML = '<main class="wrap"><section class="card center"><p class="big-text">Cargando…</p></section></main>';
      return;
    }
    const c = vw.config;
    const r = vw.round;
    let main = '';
    if (vw.phase === 'preparacion') {
      main = `<section class="card center"><h2>Preparando el juego…</h2><p>${vw.teams.length} equipos · ${vw.players.length} jugadores</p></section>`;
    } else {
      const roundBox =
        vw.phase === 'fin'
          ? '<span class="big sm">Terminado</span>'
          : r.stage === 'ronda'
            ? `<span class="big" data-timer data-end="${r.startGt + c.roundMs}" data-warn="${c.roundWarnMs}"></span>`
            : r.assembly.step === 'debate'
              ? `<span class="big" data-timer data-end="${r.assembly.debateStartGt + c.debateMs}"></span>`
              : `<span class="big sm">${STEP[r.assembly.step]}</span>`;
      main = `<section class="clocks card pub ${vw.paused ? 'paused' : ''}">
        <div class="clock"><span class="lbl">Juego</span><span class="big" data-timer data-end="${c.gameMs}" data-warn="${c.gameWarnMs}"></span></div>
        <div class="clock"><span class="lbl">${r.stage === 'ronda' ? `Ronda ${r.n}` : `Asamblea · ronda ${r.n}${r.assembly.step === 'debate' ? ' · debate' : ''}`}</span>${roundBox}</div>
        <div class="clock"><span class="lbl">Bote</span><span class="big">🪙 ${vw.pot}</span></div>
        ${vw.paused ? '<div class="paused-tag">⏸ EN PAUSA</div>' : ''}
      </section>`;
      if (vw.final) {
        const f = vw.final;
        main += `<section class="card final ${f.winner}"><h1>${f.winner === 'lobos' ? '🐺 Ganan los lobos' : '🏡 Ganan los aldeanos'}</h1><p>${esc(f.reason)}</p>
          <p class="big-text">🏆 Más fichas: <b>${f.topTeams.map(tname).join(' y ')}</b></p></section>`;
      } else if (r.stage === 'asamblea') {
        const a = r.assembly;
        main += `<section class="card assembly"><h2>📣 Asamblea</h2><blockquote class="announce">${esc(a.text)}</blockquote>
          ${a.bets.length ? `<p><b>Apuestas:</b> ${a.bets.map((b) => `${tname(b.teamId)} → ${esc(vw.players.find((x) => x.id === b.playerId)?.name)}`).join(' · ')}</p>` : ''}
          ${a.result ? `<p class="big-text">${a.result.tie ? '⚖️ Empate: nadie sale.' : `Expulsado: <b>${esc(vw.players.find((x) => x.id === a.result.expelledId)?.name)}</b> · era ${ROLE_ICON[a.result.role]} ${ROLE_NAMES[a.result.role]}`}</p>
            <p>${a.result.winners.length ? `Cobran ${a.result.winners.map(tname).join(', ')}: ${a.result.share} ficha(s) cada uno. Quedan ${a.result.potAfter} en el bote.` : `El bote (${a.result.potAfter}) se acumula.`}</p>` : ''}
        </section>`;
      }
    }
    const teams = [...vw.teams].sort((a, b) => b.chips - a.chips);
    const aliveP = vw.players.filter((x) => x.status === 'vivo');
    const deadP = vw.players.filter((x) => x.status !== 'vivo');
    root.innerHTML = `<header class="top pub"><div class="brand">🐺 Lobos en el parque</div><span id="sync" class="sync ${online ? 'on' : 'off'}"></span></header>
      <main class="wrap pubwrap">${main}
        <section class="card"><h3>🪙 Fichas</h3><div class="scoreboard">${teams
          .map((t) => `<div class="team-score"><span>${esc(t.name)}${t.expelled ? ' <small title="Tiene a alguien expulsado por votación">❌</small>' : ''}</span><b>${t.chips}</b></div>`)
          .join('')}</div></section>
        <div class="cols">
          <section class="card"><h3>🌲 Vivos (${aliveP.length})</h3><ul class="plain names">${aliveP.map((x) => `<li>${esc(x.name)} <span class="muted small">${tname(x.teamId)}</span>${x.role ? ` · ${ROLE_ICON[x.role]} ${ROLE_NAMES[x.role]}` : ''}</li>`).join('')}</ul></section>
          <section class="card"><h3>👻 Muertos (${deadP.length})</h3><ul class="plain names">${deadP.map((x) => `<li class="is-dead">${esc(x.name)} <span class="muted small">${tname(x.teamId)}</span> · ${ROLE_ICON[x.role]} ${ROLE_NAMES[x.role]} ${x.status === 'fuera' ? '<span class="st st-fuera">Fuera</span>' : '<span class="st st-fantasma">Fantasma</span>'}</li>`).join('')}</ul></section>
        </div>
        <section class="card"><h3>📜 Bitácora</h3><ul class="log">${[...vw.log].reverse().map((e) => `<li><div class="meta">${fmtClock(e.at)} · R${e.round}</div><div>${esc(e.text)}</div></li>`).join('')}</ul></section>
      </main>`;
    tick();
  }

  function tick() {
    const g = gtNow();
    root.querySelectorAll('[data-timer]').forEach((el) => {
      const rem = Number(el.dataset.end) - g;
      el.textContent = fmtDown(rem);
      el.classList.toggle('zero', rem <= 0);
      el.classList.toggle('low', rem > 0 && rem <= Number(el.dataset.warn ?? 60000));
    });
  }

  render();
  poll();
  setInterval(poll, 2000);
  setInterval(tick, 250);
}
