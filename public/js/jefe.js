// Vista de jefes: preparación, juego en vivo y resultado final.
import {
  ROLE_NAMES, ROLE_ICON, ROLE_HELP, ROLES, SPECIAL_ROLES, STATUS_NAMES, CAUSE_NAMES,
  esc, fmtDown, fmtUp, fmtClock, gameTime, serverNow, api, newId, lsGet, lsSet, rememberGame,
  beep, unlockAudio, vibrate, toast, copyText, renderQr, download, jefeLink, publicLink, shareBlock,
} from './common.js';

const STEPS = ['Equipos', 'Jugadores', 'Roles', 'Reparto', 'Señas', 'Iniciar'];
const ASSEMBLY_STEPS = { anuncio: 'Anuncio', apuestas: 'Apuestas', debate: 'Debate', votacion: 'Votación', resultado: 'Resultado' };
const NAME_KEY = 'lobos-jefe-nombre';

export function startJefe(root, code, token) {
  const S = {
    code,
    token,
    name: lsGet(NAME_KEY, ''),
    view: null,
    etag: null,
    screen: 'panel',
    setupStep: Number(lsGet(`lobos-paso-${code}`, '0')) || 0,
    draft: null,
    dirty: false,
    hidden: false,
    revealed: new Set(),
    revealAll: false,
    dealIdx: 0,
    dealShown: false,
    deathCause: 'lobo',
    lastGossip: null,
    online: true,
    busy: false,
    polling: false,
    fatal: null,
    alerts: [],
    sawPlaying: false,
    fired: new Set(JSON.parse(lsGet(`lobos-avisos-${code}`, '[]') || '[]')),
  };
  rememberGame(code, token);

  const overlayRoot = document.createElement('div');
  document.body.appendChild(overlayRoot);

  // ------------------------------------------------------------ helpers
  const v = () => S.view;
  const P = (id) => S.view.players.find((p) => p.id === id);
  const T = (id) => S.view.teams.find((t) => t.id === id);
  const tname = (id) => esc(T(id)?.name ?? '?');
  const holder = (role) => S.view.players.find((p) => p.role === role);
  const alive = (p) => p.status === 'vivo';
  const dead = (p) => p.status === 'fantasma' || p.status === 'fuera';
  const roleChip = (role) => (role ? `<span class="role r-${role}">${ROLE_ICON[role]} ${ROLE_NAMES[role]}</span>` : '<span class="role r-none">Sin rol</span>');
  const statusChip = (p) => (p.pendingDeathId ? '<span class="st st-pend">Ventana bruja</span>' : `<span class="st st-${p.status}">${STATUS_NAMES[p.status] || ''}</span>`);
  function gtNow() {
    const view = S.view;
    if (!view) return 0;
    let g = gameTime(view.clock, serverNow());
    if (view.final) g = Math.min(g, view.final.endGt);
    return g;
  }
  function playerOptions(filter, { placeholder = 'Elige…', exclude = [] } = {}) {
    const view = S.view;
    let html = `<option value="">${esc(placeholder)}</option>`;
    for (const t of view.teams) {
      const ps = view.players.filter((p) => p.teamId === t.id && filter(p) && !exclude.includes(p.id));
      if (!ps.length) continue;
      html += `<optgroup label="${esc(t.name)}">${ps.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</optgroup>`;
    }
    return html;
  }
  const back = (label = 'Volver al panel') => `<button class="btn ghost back" data-act="go" data-screen="panel">← ${label}</button>`;

  // ------------------------------------------------------------ red
  async function poll() {
    if (S.polling || S.fatal) return;
    S.polling = true;
    try {
      const q = S.etag ? `?since=${encodeURIComponent(S.etag)}` : '';
      const r = await api(`/partidas/${S.code}${q}`, { headers: { 'x-token': S.token } });
      S.online = true;
      if (r.unchanged) updateSync();
      else applyView(r);
    } catch (e) {
      S.online = false;
      if (e.status === 403 || e.status === 404) {
        S.fatal = e.message;
        render();
      }
      updateSync();
    } finally {
      S.polling = false;
    }
  }

  async function act(type, payload = {}, { okMsg } = {}) {
    if (S.busy) {
      toast('Espera: se está guardando la acción anterior.', 'error');
      return null;
    }
    if (!S.name) {
      toast('Escribe tu nombre primero.', 'error');
      return null;
    }
    S.busy = true;
    document.body.classList.add('busy');
    const opId = newId('op');
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await api(`/partidas/${S.code}/acciones`, {
            method: 'POST',
            headers: { 'x-token': S.token },
            body: { type, payload, by: S.name, opId },
          });
          S.online = true;
          applyView(r);
          if (okMsg) toast(okMsg);
          return r;
        } catch (e) {
          // Error de red: reintentamos con el mismo opId (el servidor no duplica).
          if (!e.status && attempt < 3) {
            await new Promise((res) => setTimeout(res, 700 * (attempt + 1)));
            continue;
          }
          throw e;
        }
      }
    } catch (e) {
      toast(e.status ? e.message : 'Sin conexión. Revisa tu señal e intenta de nuevo.', 'error');
      return null;
    } finally {
      S.busy = false;
      document.body.classList.remove('busy');
    }
  }

  function applyView(r) {
    S.view = r.view;
    S.etag = r.etag;
    if (S.view.phase === 'juego') S.sawPlaying = true;
    if (S.view.phase === 'preparacion') syncDraft();
    render();
  }

  function updateSync() {
    const el = document.getElementById('sync');
    if (el) {
      el.className = `sync ${S.online ? 'on' : 'off'}`;
      el.title = S.online ? 'Sincronizado' : 'Sin conexión';
    }
  }

  // ------------------------------------------------------------ borrador de la preparación
  function syncDraft() {
    if (S.dirty && S.draft) return;
    const view = S.view;
    S.draft = {
      teams: view.teams.map((t) => ({ id: t.id, name: t.name })),
      players: Object.fromEntries(view.teams.map((t) => [t.id, view.players.filter((p) => p.teamId === t.id).map((p) => p.name).join('\n')])),
      signs: { ...view.signs },
    };
  }
  async function saveSetup() {
    const d = S.draft;
    const view = S.view;
    const used = new Set();
    const players = [];
    for (const t of d.teams) {
      const names = (d.players[t.id] || '').split('\n').map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
      for (const name of names) {
        const ex =
          view.players.find((p) => p.teamId === t.id && p.name === name && !used.has(p.id)) ||
          view.players.find((p) => p.name === name && !used.has(p.id));
        const id = ex ? ex.id : newId('j');
        used.add(id);
        players.push({ id, name, teamId: t.id });
      }
    }
    const r = await act('setup', { teams: d.teams.map((t) => ({ id: t.id, name: t.name.trim() })), players });
    if (r) {
      S.dirty = false;
      syncDraft();
      render();
    }
    return r;
  }
  function setStep(n) {
    S.setupStep = Math.max(0, Math.min(STEPS.length - 1, n));
    lsSet(`lobos-paso-${S.code}`, String(S.setupStep));
    window.scrollTo(0, 0);
    render();
  }

  // ------------------------------------------------------------ render
  function render() {
    // Conserva lo que el jefe está escribiendo aunque llegue una actualización.
    const keep = {};
    root.querySelectorAll('input[id],select[id],textarea[id]').forEach((el) => {
      if (el.dataset.fresh !== undefined) return;
      keep[el.id] = el.type === 'checkbox' || el.type === 'radio' ? { c: el.checked } : { v: el.value };
    });
    const active = document.activeElement;
    const focusId = active && root.contains(active) ? active.id : null;
    let selS = null;
    let selE = null;
    try {
      selS = active.selectionStart;
      selE = active.selectionEnd;
    } catch {
      /* sin selección */
    }
    const y = window.scrollY;
    root.innerHTML = view();
    for (const [id, k] of Object.entries(keep)) {
      const el = document.getElementById(id);
      if (!el || el.dataset.fresh !== undefined) continue;
      if ('c' in k) el.checked = k.c;
      else if (el.tagName === 'SELECT') {
        if ([...el.options].some((o) => o.value === k.v)) el.value = k.v;
      } else el.value = k.v;
    }
    if (focusId) {
      const el = document.getElementById(focusId);
      if (el) {
        el.focus({ preventScroll: true });
        try {
          if (selS != null) el.setSelectionRange(selS, selE);
        } catch {
          /* no aplica */
        }
      }
    }
    window.scrollTo(0, y);
    renderOverlays();
    tickUI();
  }

  function view() {
    if (S.fatal) return `<main class="wrap"><section class="card center"><h2>😕 ${esc(S.fatal)}</h2><p><a class="btn" href="/">Ir a la portada</a></p></section></main>`;
    if (!S.name) return nameScreen();
    if (!S.view) return `<main class="wrap"><section class="card center"><p class="big-text">Cargando partida ${esc(S.code)}…</p></section></main>`;
    const vw = S.view;
    let body;
    if (S.screen === 'compartir') body = screenCompartir();
    else if (S.screen === 'nombre') body = nameScreen(true);
    else if (vw.phase === 'preparacion') body = screenSetup();
    else body = (SCREENS[S.screen] || SCREENS.panel)();
    const nav = vw.phase === 'preparacion' || S.screen === 'imprimir' ? '' : navBar();
    return `${header()}<main class="wrap ${nav ? 'has-nav' : ''}">${body}</main>${nav}`;
  }

  function header() {
    return `<header class="top">
      <div class="brand">🐺 <b>${esc(S.code)}</b></div>
      <button class="who" data-act="go" data-screen="nombre" title="Cambiar nombre">👤 ${esc(S.name)}</button>
      <span id="sync" class="sync ${S.online ? 'on' : 'off'}" title="${S.online ? 'Sincronizado' : 'Sin conexión'}"></span>
      <button class="btn sm" data-act="go" data-screen="compartir">Enlaces</button>
      <button class="btn sm dark" data-act="hide">🙈 Ocultar</button>
    </header>`;
  }

  function navBar() {
    const items = [
      ['panel', '🏠', 'Panel'],
      ['jugadores', '👥', 'Jugadores'],
      ['recursos', '🎒', 'Recursos'],
      ['fichas', '🪙', 'Fichas'],
      ['bitacora', '📜', 'Bitácora'],
      ['mas', '⋯', 'Más'],
    ];
    const cur = ['muerte', 'chismoso', 'invocacion'].includes(S.screen) ? 'panel' : S.screen;
    return `<nav class="tabs">${items
      .map(([k, i, l]) => `<button class="${cur === k ? 'on' : ''}" data-act="go" data-screen="${k}"><span>${i}</span>${l}</button>`)
      .join('')}</nav>`;
  }

  function nameScreen(change = false) {
    return `<main class="wrap"><section class="card">
      <h2>${change ? 'Cambiar mi nombre' : '¿Cómo te llamas?'}</h2>
      <p class="muted">Todo lo que registres quedará firmado con tu nombre en la bitácora de la partida <b>${esc(S.code)}</b>.</p>
      <form data-form="name">
        <input id="name-input" class="input xl" maxlength="40" autocomplete="name" placeholder="Ej. Jefe Ana" value="${esc(S.name)}" required>
        <button class="btn primary xl" type="submit">Entrar</button>
      </form>
      ${change ? back('Volver') : ''}
    </section></main>`;
  }

  function renderOverlays() {
    let html = '';
    if (S.hidden) {
      html += `<div class="hider"><div><p>🌲</p><p>Pantalla oculta</p><button class="btn xl" data-act="unhide">Mostrar</button></div></div>`;
    } else if (S.alerts.length) {
      const a = S.alerts[0];
      html += `<div class="alert-ov ${a.strong ? 'strong' : ''}" role="alertdialog"><div class="alert-box">
        <h2>${esc(a.title)}</h2>${a.body ? `<p>${esc(a.body)}</p>` : ''}
        <button class="btn xl" data-act="alertOk">Entendido${S.alerts.length > 1 ? ` (${S.alerts.length - 1} más)` : ''}</button>
      </div></div>`;
    }
    overlayRoot.innerHTML = html;
  }

  // ------------------------------------------------------------ preparación
  function screenSetup() {
    const vw = S.view;
    const d = S.draft;
    const stepper = `<ol class="stepper">${STEPS.map((s, i) => `<li><button class="${i === S.setupStep ? 'on' : ''} ${i < S.setupStep ? 'done' : ''}" data-act="setStep" data-n="${i}">${i + 1}<small>${s}</small></button></li>`).join('')}</ol>`;
    let body = '';
    const n = vw.players.length;
    if (S.setupStep === 0) {
      body = `<section class="card"><h2>1. Equipos</h2>
        <p class="muted">Cada equipo empieza con ${vw.config.startChips} fichas. Puedes cambiar los nombres.</p>
        ${d.teams
          .map(
            (t, i) => `<div class="row-input"><input id="tn-${t.id}" class="input" data-bind="team" data-id="${t.id}" maxlength="40" value="${esc(t.name)}" placeholder="Equipo ${i + 1}">
          <button class="btn ghost" data-act="removeTeam" data-id="${t.id}" ${d.teams.length <= 2 ? 'disabled' : ''} title="Quitar equipo">✕</button></div>`,
          )
          .join('')}
        <button class="btn" data-act="addTeam" ${d.teams.length >= 12 ? 'disabled' : ''}>＋ Agregar equipo</button>
      </section>
      <div class="actions"><button class="btn primary xl" data-act="saveNext">Guardar y seguir →</button></div>`;
    } else if (S.setupStep === 1) {
      const total = d.teams.reduce((a, t) => a + (d.players[t.id] || '').split('\n').filter((x) => x.trim()).length, 0);
      body = `<section class="card"><h2>2. Jugadores</h2>
        <p class="muted">Escribe un nombre por renglón. Algunos equipos pueden tener solo 2 personas. Total: <b id="pcount">${total}</b>.</p>
        ${d.teams
          .map((t) => {
            const c = (d.players[t.id] || '').split('\n').filter((x) => x.trim()).length;
            return `<label class="lbl">${esc(t.name)} <span class="muted">(${c})</span></label>
            <textarea id="pl-${t.id}" class="input" rows="${Math.max(3, c + 1)}" data-bind="players" data-id="${t.id}" placeholder="Nombre\nNombre\n…">${esc(d.players[t.id] || '')}</textarea>`;
          })
          .join('')}
      </section>
      <div class="actions"><button class="btn" data-act="setStep" data-n="0">← Atrás</button><button class="btn primary xl" data-act="saveNext">Guardar y seguir →</button></div>`;
    } else if (S.setupStep === 2) {
      const rec = vw.recommended;
      const cnt = vw.counts;
      const hasRoles = vw.players.some((p) => p.role);
      body = `<section class="card"><h2>3. Roles</h2>
        ${S.dirty ? '<p class="banner warn">Tienes cambios sin guardar en equipos o jugadores. Vuelve a esos pasos y guarda.</p>' : ''}
        <p>${n} jugadores. Reparto recomendado por la tabla:</p>
        <table class="tbl"><tr><th>Rol</th><th>Tabla</th><th>Actual</th></tr>
        ${ROLES.map((r) => `<tr class="${hasRoles && rec[r] !== cnt[r] ? 'diff' : ''}"><td>${ROLE_ICON[r]} ${ROLE_NAMES[r]}</td><td>${rec[r]}</td><td>${cnt[r]}</td></tr>`).join('')}
        </table>
        <button class="btn primary xl" data-act="autoRoles" ${n ? '' : 'disabled'}>🎲 ${hasRoles ? 'Volver a repartir' : 'Repartir automáticamente'}</button>
        ${vw.warnings.length ? `<div class="banner warn"><b>Advertencias:</b><ul>${vw.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : hasRoles ? '<p class="ok-text">✓ El reparto cumple todas las restricciones.</p>' : ''}
      </section>
      ${hasRoles ? `<section class="card"><h3>Ajuste manual</h3><p class="muted">Cambia el rol de cualquier jugador.</p>
        ${vw.teams
          .map(
            (t) => `<h4>${esc(t.name)}</h4>${vw.players
              .filter((p) => p.teamId === t.id)
              .map(
                (p) => `<div class="row-input"><span class="pname">${esc(p.name)}</span>
              <select id="rs-${p.id}" class="input" data-fresh data-change="role" data-id="${p.id}">${ROLES.map((r) => `<option value="${r}" ${p.role === r ? 'selected' : ''}>${ROLE_ICON[r]} ${ROLE_NAMES[r]}</option>`).join('')}${p.role ? '' : '<option value="" selected>—</option>'}</select></div>`,
              )
              .join('')}`,
          )
          .join('')}</section>` : ''}
      <div class="actions"><button class="btn" data-act="setStep" data-n="1">← Atrás</button><button class="btn primary xl" data-act="setStep" data-n="3" ${hasRoles ? '' : 'disabled'}>Seguir →</button></div>`;
    } else if (S.setupStep === 3) {
      const list = vw.teams.flatMap((t) => vw.players.filter((p) => p.teamId === t.id));
      if (!list.length) body = '<section class="card"><p>Primero captura a los jugadores.</p></section>';
      else {
        S.dealIdx = Math.min(S.dealIdx, list.length - 1);
        const p = list[S.dealIdx];
        const wolves = vw.players.filter((x) => x.role === 'lobo' && x.id !== p.id);
        let extra = '';
        if (p.role === 'lobo') extra = `<p>Los otros lobos: <b>${wolves.map((w) => `${esc(w.name)} (${tname(w.teamId)})`).join(', ') || 'ninguno'}</b></p>${vw.signs.lobo ? `<p>Seña de lobo: <b>${esc(vw.signs.lobo)}</b></p>` : ''}`;
        if (p.role === 'cazador' && vw.signs.cazador) extra = `<p>Seña de cazador: <b>${esc(vw.signs.cazador)}</b></p>`;
        body = `<section class="card deal">
          <h2>4. Reparto (tienda de roles)</h2>
          <p class="muted">Jugador ${S.dealIdx + 1} de ${list.length}. Enséñale el teléfono solo a esta persona.</p>
          <p class="deal-name">${esc(p.name)}</p><p class="muted">${tname(p.teamId)}</p>
          ${
            S.dealShown
              ? `<div class="deal-role r-${p.role}"><div class="ic">${ROLE_ICON[p.role] || '❔'}</div><div class="nm">${ROLE_NAMES[p.role] || 'Sin rol'}</div><p>${esc(ROLE_HELP[p.role] || '')}</p>${extra}</div>
                 <button class="btn primary xl" data-act="dealNext">${S.dealIdx + 1 < list.length ? 'Ocultar y siguiente →' : 'Ocultar y terminar'}</button>`
              : `<button class="btn primary xl" data-act="dealShow">👁 Mostrar rol</button>`
          }
          <div class="btnrow"><button class="btn ghost" data-act="dealPrev" ${S.dealIdx === 0 ? 'disabled' : ''}>← Anterior</button></div>
        </section>
        <div class="actions"><button class="btn" data-act="setStep" data-n="2">← Roles</button><button class="btn primary" data-act="setStep" data-n="4">Seguir a señas →</button></div>`;
      }
    } else if (S.setupStep === 4) {
      body = `<section class="card"><h2>5. Señas</h2><p class="muted">Solo las ven los jefes (y se muestran en el reparto a lobos y cazador).</p>
        <label class="lbl" for="sg-lobo">🐺 Seña de lobo</label><input id="sg-lobo" class="input" data-bind="sign" data-k="lobo" maxlength="200" value="${esc(d.signs.lobo)}" placeholder="Ej. tocarse la oreja y señalar">
        <label class="lbl" for="sg-cazador">🏹 Seña de cazador</label><input id="sg-cazador" class="input" data-bind="sign" data-k="cazador" maxlength="200" value="${esc(d.signs.cazador)}" placeholder="Ej. formar una pistola con la mano">
      </section>
      <div class="actions"><button class="btn" data-act="setStep" data-n="3">← Atrás</button><button class="btn primary xl" data-act="saveSigns">Guardar y seguir →</button></div>`;
    } else {
      const errs = [];
      if (S.dirty) errs.push('Hay cambios sin guardar en equipos o jugadores.');
      if (vw.players.length < 3) errs.push('Se necesitan al menos 3 jugadores.');
      if (vw.players.some((p) => !p.role)) errs.push('Faltan roles por asignar.');
      body = `<section class="card"><h2>6. Iniciar juego</h2>
        <ul class="summary">
          <li>${vw.teams.length} equipos, ${vw.players.length} jugadores</li>
          <li>${ROLES.filter((r) => vw.counts[r]).map((r) => `${vw.counts[r]} ${ROLE_NAMES[r]}`).join(' · ')}</li>
          <li>Seña de lobo: ${vw.signs.lobo ? esc(vw.signs.lobo) : '<i>sin definir</i>'}</li>
          <li>Seña de cazador: ${vw.signs.cazador ? esc(vw.signs.cazador) : '<i>sin definir</i>'}</li>
          <li>Juego ${vw.config.gameMs / 60000} min · ronda máx. ${vw.config.roundMs / 60000} min · debate ${vw.config.debateMs / 60000} min</li>
        </ul>
        ${errs.length ? `<div class="banner bad">${errs.map(esc).join('<br>')}</div>` : ''}
        ${vw.warnings.length ? `<div class="banner warn"><ul>${vw.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
        <button class="btn primary xxl" data-act="start" ${errs.length ? 'disabled' : ''}>▶ Iniciar juego</button>
      </section>
      <div class="actions"><button class="btn" data-act="setStep" data-n="4">← Atrás</button></div>`;
    }
    return `<h1 class="title">Preparación</h1>${stepper}${body}`;
  }

  // ------------------------------------------------------------ panel
  function clocks() {
    const vw = S.view;
    const r = vw.round;
    const c = vw.config;
    const roundClock =
      r.stage === 'ronda'
        ? `<span class="big" data-timer data-end="${r.startGt + c.roundMs}" data-over="roundOver"></span>`
        : `<span class="big sm">${ASSEMBLY_STEPS[r.assembly.step]}</span>`;
    return `<section class="clocks card ${vw.paused ? 'paused' : ''}">
      <div class="clock"><span class="lbl">Juego</span><span class="big" data-timer data-end="${c.gameMs}"></span></div>
      <div class="clock"><span class="lbl">${r.stage === 'ronda' ? `Ronda ${r.n}` : `Asamblea R${r.n}`}</span>${roundClock}</div>
      <div class="clock"><span class="lbl">Bote</span><span class="big">🪙 ${vw.pot}</span></div>
      ${vw.paused ? '<div class="paused-tag">⏸ EN PAUSA</div>' : ''}
    </section>`;
  }

  function canSave() {
    const vw = S.view;
    const w = holder('bruja');
    if (!w) return 'No hay bruja en esta partida.';
    if (vw.witchSave) return 'La pócima de salvar ya se usó.';
    if (!alive(w)) return 'La bruja ya no está en juego.';
    return null;
  }

  function witchBanners() {
    const vw = S.view;
    return vw.deaths
      .filter((d) => d.status === 'pendiente')
      .map((d) => {
        const vic = P(d.victimId);
        const why = canSave();
        return `<section class="banner witch">
          <div class="row"><b>🧪 Ventana de la bruja</b><span class="big" data-timer data-refresh data-end="${d.gt + vw.config.witchMs}"></span></div>
          <p>Víctima: <b>${esc(vic.name)}</b> (${tname(vic.teamId)}) · causa: ${CAUSE_NAMES[d.cause]}</p>
          <button class="btn xl light" data-act="save" data-id="${d.id}" ${why ? 'disabled' : ''}>La bruja salvó a la víctima</button>
          ${why ? `<small>${esc(why)}</small>` : ''}
        </section>`;
      })
      .join('');
  }

  function whistleBanner() {
    const vw = S.view;
    const r = vw.round;
    if (r.stage !== 'ronda') return '';
    if (vw.deaths.some((d) => d.status === 'pendiente')) return '';
    const ds = vw.deaths.filter((d) => d.round === r.n && d.window);
    if (!ds.length) return '';
    const saved = ds.filter((d) => d.status === 'salvada').length;
    return `<section class="banner whistle"><b>📣 Toquen el silbato: asamblea</b>
      <p>${ds.length - saved} muerte(s) confirmada(s)${saved ? `, ${saved} salvada(s) por la bruja` : ''}.</p>
      <button class="btn xl" data-act="startAssembly">Iniciar asamblea</button></section>`;
  }

  function invocationStatus() {
    const vw = S.view;
    const act = vw.invocations.find((i) => i.status === 'en_curso');
    const queue = vw.invocations.filter((i) => i.status === 'en_fila');
    if (!act && !queue.length) return '';
    return `<section class="banner inv">
      ${act ? `<div class="row"><b>👻 ${tname(act.teamId)} invoca a ${esc(P(act.ghostId).name)}</b><span class="big" data-timer data-refresh data-end="${act.startGt + vw.config.invokeMs}"></span></div>` : ''}
      ${queue.length ? `<p>En fila: ${queue.map((i) => tname(i.teamId)).join(' → ')}</p>` : ''}
      <button class="btn" data-act="go" data-screen="invocacion">Ver invocaciones</button>
    </section>`;
  }

  function assemblyCard() {
    const vw = S.view;
    const r = vw.round;
    const a = r.assembly;
    const order = Object.keys(ASSEMBLY_STEPS);
    const idx = order.indexOf(a.step);
    const stepper = `<ol class="astep">${order.map((k, i) => `<li class="${i === idx ? 'on' : i < idx ? 'done' : ''}">${ASSEMBLY_STEPS[k]}</li>`).join('')}</ol>`;
    let body = '';
    if (a.step === 'anuncio') {
      body = `<p class="muted">Lean en voz alta:</p><blockquote class="announce">${esc(a.text)}</blockquote>
        <button class="btn primary xl" data-act="step" data-to="apuestas">Siguiente: apuestas →</button>`;
    } else if (a.step === 'apuestas') {
      body = `<p>Cada equipo puede apostar <b>1 ficha</b> por un jugador vivo. Bote: <b>🪙 ${vw.pot}</b></p>
        ${vw.teams
          .map((t) => {
            const b = a.bets.find((x) => x.teamId === t.id);
            if (b)
              return `<div class="bet done"><div><b>${esc(t.name)}</b> <span class="muted">🪙 ${t.chips}</span><br>apostó por <b>${esc(P(b.playerId).name)}</b></div>
                <button class="btn ghost" data-act="unbet" data-team="${t.id}">Quitar</button></div>`;
            if (t.chips < 1) return `<div class="bet off"><div><b>${esc(t.name)}</b> <span class="muted">🪙 0</span><br>Sin fichas: no puede apostar</div></div>`;
            return `<div class="bet"><div class="bet-h"><b>${esc(t.name)}</b> <span class="muted">🪙 ${t.chips}</span></div>
              <div class="row-input"><select id="bet-${t.id}" class="input">${playerOptions(alive, { placeholder: '¿Por quién apuesta?' })}</select>
              <button class="btn primary" data-act="bet" data-team="${t.id}">Apostar</button></div></div>`;
          })
          .join('')}
        <button class="btn primary xl" data-act="step" data-to="debate">Iniciar debate (${vw.config.debateMs / 60000} min) →</button>`;
    } else if (a.step === 'debate') {
      body = `<div class="center"><p class="lbl">Debate</p><p class="huge" data-timer data-end="${a.debateStartGt + vw.config.debateMs}"></p></div>
        <button class="btn primary xl" data-act="step" data-to="votacion">Pasar a votación →</button>`;
    } else if (a.step === 'votacion') {
      body = `<label class="lbl" for="vote-player">¿A quién expulsaron?</label>
        <select id="vote-player" class="input xl">${playerOptions(alive, { placeholder: 'Elige al expulsado…' })}<option value="__empate">⚖️ Empate: nadie sale</option></select>
        <button class="btn danger xl" data-act="vote">Registrar votación</button>`;
    } else if (a.step === 'resultado') {
      const res = a.result;
      const ex = res.expelledId && P(res.expelledId);
      body = `<div class="result">
        ${res.tie ? '<p class="big-text">⚖️ Empate: nadie sale.</p>' : `<p class="big-text">Expulsado: <b>${esc(ex.name)}</b> (${tname(ex.teamId)})</p><p>Su rol era ${roleChip(res.role)}</p>`}
        <h4>Bote</h4>
        <p>Había <b>🪙 ${res.potBefore}</b> en el bote.</p>
        ${
          res.winners.length
            ? `<p>Cobran: <b>${res.winners.map(tname).join(', ')}</b> — ${res.share} ficha(s) cada uno.</p><p>Quedan <b>🪙 ${res.potAfter}</b> en el bote.</p>`
            : `<p>Nadie cobró: el bote (<b>🪙 ${res.potAfter}</b>) se acumula para la siguiente asamblea.</p>`
        }
        </div>
        ${vw.phase === 'juego' ? `<button class="btn primary xxl" data-act="newRound">▶ Empezar ronda ${r.n + 1}</button>` : ''}`;
    }
    return `<section class="card assembly"><h2>📣 Asamblea · ronda ${r.n}</h2>${stepper}${body}</section>`;
  }

  function screenPanel() {
    const vw = S.view;
    if (vw.phase === 'fin') return screenFinal();
    const r = vw.round;
    const inRound = r.stage === 'ronda';
    return `${clocks()}
      ${witchBanners()}
      ${whistleBanner()}
      <div id="roundOver" class="banner warn hidden"><b>⏰ Asamblea obligatoria:</b> la ronda llegó a ${vw.config.roundMs / 60000} minutos.</div>
      ${invocationStatus()}
      ${r.stage === 'asamblea' ? assemblyCard() : ''}
      <div class="grid4">
        <button class="big-btn red" data-act="go" data-screen="muerte" ${inRound ? '' : 'disabled'}><i>☠️</i>Registrar muerte</button>
        <button class="big-btn amber" data-act="startAssembly" ${inRound ? '' : 'disabled'}><i>📣</i>${inRound ? 'Asamblea' : 'Asamblea en curso'}</button>
        <button class="big-btn blue" data-act="go" data-screen="chismoso"><i>👂</i>Chismoso</button>
        <button class="big-btn purple" data-act="go" data-screen="invocacion"><i>👻</i>Invocación</button>
      </div>
      <button class="btn xl ${vw.paused ? 'primary' : ''}" data-act="${vw.paused ? 'resume' : 'pause'}">${vw.paused ? '▶ Reanudar juego' : '⏸ Pausar (lluvia / emergencia)'}</button>`;
  }

  // ------------------------------------------------------------ muerte
  function screenMuerte() {
    const vw = S.view;
    const r = vw.round;
    if (vw.phase !== 'juego' || r.stage !== 'ronda') return `${back()}<section class="card"><p>Durante la asamblea no se registran muertes. Las expulsiones se registran en la votación.</p></section>`;
    const cause = S.deathCause;
    let who = '';
    if (cause === 'lobo') {
      const wolves = vw.players.filter((p) => p.role === 'lobo' && alive(p));
      who = `<label class="lbl" for="m-by">¿Qué lobo hizo la seña?</label>
        <select id="m-by" class="input xl"><option value="">Elige al lobo…</option>${wolves
          .map((w) => {
            const used = vw.deaths.some((d) => d.cause === 'lobo' && d.byId === w.id && d.round === r.n);
            return `<option value="${w.id}" ${used ? 'disabled' : ''}>${esc(w.name)} (${tname(w.teamId)})${used ? ' — ya eliminó esta ronda' : ''}</option>`;
          })
          .join('')}</select>`;
    } else if (cause === 'cazador') {
      const h = holder('cazador');
      const shots = vw.deaths.filter((d) => d.cause === 'cazador');
      const thisRound = shots.some((d) => d.round === r.n);
      who = h
        ? `<div class="info">🏹 Cazador: <b>${esc(h.name)}</b> (${tname(h.teamId)}) · balas restantes: <b>${vw.config.hunterBullets - shots.length}</b> de ${vw.config.hunterBullets}
          ${!alive(h) ? '<br><b class="bad-text">El cazador ya no está en juego.</b>' : ''}
          ${shots.length >= vw.config.hunterBullets ? '<br><b class="bad-text">Ya no tiene balas.</b>' : thisRound ? '<br><b class="bad-text">Ya disparó en esta ronda.</b>' : ''}</div>`
        : '<div class="info bad-text">No hay cazador en esta partida.</div>';
    } else {
      const w = holder('bruja');
      who = w
        ? `<div class="info">🧪 Bruja: <b>${esc(w.name)}</b> (${tname(w.teamId)}) · pócima de matar: <b>${vw.witchKill ? 'ya usada' : 'disponible'}</b>${!alive(w) ? '<br><b class="bad-text">La bruja ya no está en juego.</b>' : ''}</div>
          <p class="muted">Registra el nombre que te dio la bruja.</p>`
        : '<div class="info bad-text">No hay bruja en esta partida.</div>';
    }
    const victimFilter = (p) => alive(p) && !p.pendingDeathId;
    return `${back()}<section class="card"><h2>☠️ Registrar muerte</h2>
      <label class="lbl">Causa</label>
      <div class="seg">${['lobo', 'cazador', 'bruja'].map((c) => `<button class="${cause === c ? 'on' : ''}" data-act="cause" data-cause="${c}">${ROLE_ICON[c]} ${CAUSE_NAMES[c]}</button>`).join('')}</div>
      <label class="lbl" for="m-victim">Víctima</label>
      <select id="m-victim" class="input xl">${playerOptions(victimFilter, { placeholder: 'Elige a la víctima…' })}</select>
      ${who}
      ${
        cause !== 'bruja'
          ? `<label class="check"><input type="checkbox" id="m-seen"> <span>Yo lo vi (${esc(S.name)})</span></label>
             <p class="muted small">Las muertes por seña solo cuentan si un jefe las vio.</p>`
          : ''
      }
      <button class="btn danger xxl" data-act="submitDeath">Registrar muerte</button>
      <p class="muted small">Al registrarla se abre la ventana de 1 minuto de la bruja en todos los teléfonos.</p>
    </section>`;
  }

  // ------------------------------------------------------------ chismoso
  function screenChismoso() {
    const vw = S.view;
    const ch = holder('chismoso');
    if (!ch) return `${back()}<section class="card"><p>No hay chismoso en esta partida.</p></section>`;
    const r = vw.round;
    const done = vw.gossip.find((g) => g.round === r?.n);
    let res = '';
    const lg = S.lastGossip && vw.gossip.find((g) => g.id === S.lastGossip);
    if (lg) {
      res = `<section class="card gossip-res"><p class="muted">Dile al chismoso:</p>
        <p class="big-text"><b>${esc(P(lg.targetId).name)}</b> es</p><div class="deal-role r-${lg.role}"><div class="ic">${ROLE_ICON[lg.role]}</div><div class="nm">${ROLE_NAMES[lg.role]}</div></div>
        <button class="btn xl" data-act="gossipDone">Listo (ocultar)</button></section>`;
    }
    let form;
    if (vw.phase !== 'juego') form = '<p>El juego no está en curso.</p>';
    else if (!alive(ch)) form = '<p class="bad-text">El chismoso ya no está en juego.</p>';
    else if (done) form = `<p class="ok-text">✓ Ya hizo su consulta de la ronda ${r.n} (preguntó por ${esc(P(done.targetId).name)}). Podrá preguntar de nuevo en la siguiente ronda.</p>`;
    else
      form = `<label class="lbl" for="g-target">¿Por quién pregunta?</label>
        <select id="g-target" class="input xl">${playerOptions(alive, { placeholder: 'Elige a la persona…', exclude: [ch.id] })}</select>
        <button class="btn primary xxl" data-act="gossip">Consultar rol</button>`;
    return `${back()}${res}<section class="card"><h2>👂 Chismoso</h2>
      <p>Chismoso: <b>${esc(ch.name)}</b> (${tname(ch.teamId)}) ${statusChip(ch)}</p>${form}</section>
      ${vw.gossip.length ? `<section class="card"><h3>Consultas</h3><ul class="plain">${vw.gossip.map((g) => `<li>Ronda ${g.round}: ${esc(P(g.targetId).name)} → ${roleChip(g.role)} <span class="muted">(${esc(g.by)})</span></li>`).join('')}</ul></section>` : ''}`;
  }

  // ------------------------------------------------------------ invocación
  function screenInvocacion() {
    const vw = S.view;
    const r = vw.round;
    const inRound = vw.phase === 'juego' && r.stage === 'ronda';
    const act = vw.invocations.find((i) => i.status === 'en_curso');
    const queue = vw.invocations.filter((i) => i.status === 'en_fila');
    const ghosts = vw.players.filter((p) => p.status === 'fantasma');
    const used = new Set(vw.invocations.filter((i) => i.round === r?.n && i.status !== 'cancelada').map((i) => i.teamId));
    const teams = vw.teams.filter((t) => !used.has(t.id) && vw.players.some((p) => p.teamId === t.id && alive(p)));
    const thisRound = vw.invocations.filter((i) => i.round === r?.n && ['terminada', 'perdida'].includes(i.status));
    const ST = { terminada: 'Terminada', perdida: 'Perdida (se acabó la ronda)' };
    let add;
    if (!inRound) add = '<p>Las invocaciones se hacen durante la ronda.</p>';
    else if (!ghosts.length) add = '<p class="muted">Todavía no hay fantasmas (aldeanos muertos).</p>';
    else if (!teams.length) add = '<p class="muted">Todos los equipos ya usaron su invocación de esta ronda.</p>';
    else
      add = `<label class="lbl" for="inv-team">Equipo</label><select id="inv-team" class="input xl"><option value="">Elige el equipo…</option>${teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>
        <label class="lbl" for="inv-ghost">Fantasma</label><select id="inv-ghost" class="input xl"><option value="">Elige al fantasma…</option>${ghosts.map((g) => `<option value="${g.id}">${esc(g.name)} (${tname(g.teamId)})</option>`).join('')}</select>
        <button class="btn primary xl" data-act="invAdd">＋ Agregar a la fila</button>`;
    return `${back()}
      ${act ? `<section class="banner inv"><div class="row"><b>👻 En curso: ${tname(act.teamId)} con ${esc(P(act.ghostId).name)}</b><span class="big" data-timer data-refresh data-end="${act.startGt + vw.config.invokeMs}"></span></div>
        <button class="btn" data-act="invEnd" data-id="${act.id}">Terminar ya</button></section>` : ''}
      <section class="card"><h2>👻 Fila de invocación · ronda ${r?.n ?? ''}</h2>
        <p class="muted">Una invocación gratis por equipo por ronda, por orden de llegada. Al terminar la ronda, quien siga en la fila la pierde.</p>
        ${
          queue.length
            ? `<ol class="queue">${queue
                .map(
                  (i, k) => `<li><div><b>${tname(i.teamId)}</b> invoca a <b>${esc(P(i.ghostId).name)}</b></div><div class="btnrow">
              ${k === 0 ? `<button class="btn primary" data-act="invStart" data-id="${i.id}" ${act || !inRound ? 'disabled' : ''}>▶ Iniciar (${vw.config.invokeMs / 1000} s)</button>` : ''}
              <button class="btn ghost" data-act="invRemove" data-id="${i.id}">Quitar</button></div></li>`,
                )
                .join('')}</ol>`
            : '<p class="muted">La fila está vacía.</p>'
        }
      </section>
      <section class="card"><h3>Agregar a la fila</h3>${add}</section>
      ${thisRound.length ? `<section class="card"><h3>Esta ronda</h3><ul class="plain">${thisRound.map((i) => `<li>${tname(i.teamId)} → ${esc(P(i.ghostId).name)}: ${ST[i.status]}</li>`).join('')}</ul></section>` : ''}`;
  }

  // ------------------------------------------------------------ jugadores
  function screenJugadores() {
    const vw = S.view;
    const ended = vw.phase === 'fin';
    return `<section class="card"><div class="row"><h2>👥 Jugadores</h2>
      <button class="btn sm" data-act="revealAll">${S.revealAll ? '🙈 Ocultar roles' : '👁 Ver todos'}</button></div>
      <p class="muted small">Toca un rol oculto para verlo.</p></section>
      ${vw.teams
        .map((t) => {
          const ps = vw.players.filter((p) => p.teamId === t.id);
          const nAlive = ps.filter(alive).length;
          return `<section class="card"><div class="row"><h3>${esc(t.name)}</h3><span class="muted">${nAlive}/${ps.length} vivos · 🪙 ${t.chips}</span></div>
          <ul class="players">${ps
            .map((p) => {
              const show = ended || dead(p) || S.revealAll || S.revealed.has(p.id);
              return `<li class="${dead(p) ? 'is-dead' : ''}"><span class="pname">${esc(p.name)}</span>${statusChip(p)}
              ${show ? `<button class="rolebtn" data-act="reveal" data-id="${p.id}">${roleChip(p.role)}</button>` : `<button class="rolebtn hidden-role" data-act="reveal" data-id="${p.id}">•••• toca</button>`}</li>`;
            })
            .join('')}</ul></section>`;
        })
        .join('')}`;
  }

  // ------------------------------------------------------------ recursos
  function screenRecursos() {
    const vw = S.view;
    const r = vw.round;
    const line = (p) => (p ? `<b>${esc(p.name)}</b> (${tname(p.teamId)}) ${statusChip(p)}` : '<i>No hay</i>');
    const h = holder('cazador');
    const shots = vw.deaths.filter((d) => d.cause === 'cazador');
    const w = holder('bruja');
    const ch = holder('chismoso');
    const m = holder('martir');
    const first = vw.firstDeathId && vw.deaths.find((d) => d.id === vw.firstDeathId);
    const wolves = vw.players.filter((p) => p.role === 'lobo');
    const deathOf = (id) => {
      const d = vw.deaths.find((x) => x.id === id);
      return d ? esc(P(d.victimId).name) : '';
    };
    let martyr;
    if (!m) martyr = 'No hay mártir en esta partida.';
    else if (vw.martyrPaid) martyr = `✅ Ya cobró: +${vw.config.bonusMartir} fichas para ${tname(m.teamId)}.`;
    else if (first) martyr = `❌ Ya no puede cobrar: el primer muerto fue ${esc(P(first.victimId).name)}.`;
    else martyr = '⏳ Todavía puede cobrar (nadie ha muerto).';
    const dots = (n, used) => Array.from({ length: n }, (_, i) => `<span class="dot ${i < used ? 'used' : ''}"></span>`).join('');
    return `<section class="card"><h3>🏹 Cazador</h3><p>${line(h)}</p>
        <p>Balas: ${dots(vw.config.hunterBullets, shots.length)} ${vw.config.hunterBullets - shots.length} de ${vw.config.hunterBullets} restantes</p>
        ${shots.length ? `<p class="muted small">Disparos: ${shots.map((d) => `R${d.round} → ${esc(P(d.victimId).name)}${d.status === 'salvada' ? ' (salvado)' : ''}`).join(', ')}</p>` : ''}
        ${r && shots.some((d) => d.round === r.n) ? '<p class="bad-text">Ya disparó en esta ronda.</p>' : ''}</section>
      <section class="card"><h3>🧪 Bruja</h3><p>${line(w)}</p>
        <p>Pócima de salvar: ${vw.witchSave ? `<b class="bad-text">usada</b> (salvó a ${deathOf(vw.witchSave)})` : '<b class="ok-text">disponible</b>'}</p>
        <p>Pócima de matar: ${vw.witchKill ? `<b class="bad-text">usada</b> (contra ${deathOf(vw.witchKill)})` : '<b class="ok-text">disponible</b>'}</p></section>
      <section class="card"><h3>👂 Chismoso</h3><p>${line(ch)}</p>
        <p>Consulta de esta ronda: ${r && vw.gossip.some((g) => g.round === r.n) ? '<b class="bad-text">ya la hizo</b>' : '<b class="ok-text">disponible</b>'}</p>
        ${vw.gossip.length ? `<ul class="plain small">${vw.gossip.map((g) => `<li>R${g.round}: ${esc(P(g.targetId).name)} → ${ROLE_NAMES[g.role]}</li>`).join('')}</ul>` : ''}</section>
      <section class="card"><h3>🕯️ Mártir</h3><p>${line(m)}</p><p>${martyr}</p></section>
      <section class="card"><h3>🐺 Lobos</h3><ul class="plain">${wolves
        .map((x) => {
          const k = r && vw.deaths.some((d) => d.cause === 'lobo' && d.byId === x.id && d.round === r.n);
          return `<li>${line(x)}${k ? ' <span class="muted small">ya eliminó esta ronda</span>' : ''}</li>`;
        })
        .join('')}</ul></section>
      <section class="card"><h3>🤫 Señas</h3><p>🐺 Lobo: <b>${esc(vw.signs.lobo) || '<i>sin definir</i>'}</b></p><p>🏹 Cazador: <b>${esc(vw.signs.cazador) || '<i>sin definir</i>'}</b></p></section>`;
  }

  // ------------------------------------------------------------ fichas
  function screenFichas() {
    const vw = S.view;
    const ended = vw.phase === 'fin';
    return `<section class="card"><h2>🪙 Marcador</h2>
      <p class="big-text">Bote acumulado: <b>🪙 ${vw.pot}</b></p>
      <table class="tbl score"><tr><th>Equipo</th><th>Fichas</th><th>Aciertos</th><th>Integridad</th></tr>
      ${[...vw.teams]
        .sort((a, b) => b.chips - a.chips)
        .map(
          (t) => `<tr><td><b>${esc(t.name)}</b></td><td class="num">${t.chips}</td><td class="num">${t.correctBets}</td>
        <td>${t.expelled.length ? `<span class="bad-text">❌ ${t.expelled.map((id) => esc(P(id).name)).join(', ')}</span>` : '✅'}</td></tr>`,
        )
        .join('')}</table>
      <p class="muted small">❌ = el equipo tiene a alguien expulsado por votación y pierde el bono de integridad (+${vw.config.bonusIntegridad}).</p>
      ${ended ? '' : '<p class="muted small">Los bonos de integridad, mejor apostador y lobos se suman al terminar el juego.</p>'}</section>
      ${ledgerTable()}`;
  }

  function ledgerTable() {
    const vw = S.view;
    const cols = [
      ['inicial', 'Inicial'],
      ['apuestas', 'Apuestas'],
      ['cobros', 'Cobros del bote'],
      ['martir', 'Mártir'],
      ['integridad', 'Integridad'],
      ['apostador', 'Mejor apostador'],
      ['lobos', 'Lobos'],
    ];
    const sign = (n) => (n > 0 ? `+${n}` : String(n));
    return `<section class="card scroll-x"><h3>Desglose</h3><table class="tbl ledger"><tr><th>Equipo</th>${cols.map(([, l]) => `<th>${l}</th>`).join('')}<th>Total</th></tr>
      ${vw.teams.map((t) => `<tr><td><b>${esc(t.name)}</b></td>${cols.map(([k]) => `<td class="num">${t.ledger[k] ? sign(t.ledger[k]) : '·'}</td>`).join('')}<td class="num"><b>${t.chips}</b></td></tr>`).join('')}
      </table></section>`;
  }

  // ------------------------------------------------------------ bitácora
  function logList(entries) {
    return `<ul class="log">${entries
      .map(
        (e) => `<li class="${e.undone ? 'undone' : ''} ${e.sys ? 'sys' : ''} ${e.isUndo ? 'undo' : ''}">
        <div class="meta">${fmtClock(e.at)} · R${e.round} · ${esc(e.by)}${e.undone ? ' · <b>deshecho</b>' : ''}</div><div>${esc(e.text)}</div></li>`,
      )
      .join('')}</ul>`;
  }
  function screenBitacora() {
    const vw = S.view;
    return `<section class="card"><h2>📜 Bitácora</h2><p class="muted small">Lo más reciente arriba. Solo la ven los jefes.</p>${logList([...vw.log].reverse())}</section>`;
  }

  // ------------------------------------------------------------ más
  function lastUndoable() {
    return [...S.view.log].reverse().find((e) => e.seq != null && !e.undone && !e.isUndo && !e.error);
  }
  function screenMas() {
    const vw = S.view;
    const last = lastUndoable();
    return `<section class="card"><h2>⏸ Pausa</h2>
        ${vw.phase === 'juego' ? `<button class="btn xl ${vw.paused ? 'primary' : ''}" data-act="${vw.paused ? 'resume' : 'pause'}">${vw.paused ? '▶ Reanudar juego' : '⏸ Pausar juego'}</button>` : '<p class="muted">El juego no está en curso.</p>'}</section>
      <section class="card"><h2>↩️ Deshacer</h2>
        ${last ? `<p>Última acción: <b>${esc(last.text)}</b> <span class="muted">(${esc(last.by)})</span></p><button class="btn danger xl" data-act="undo">Deshacer la última acción</button>` : '<p class="muted">No hay nada que deshacer.</p>'}
        <p class="muted small">Se deshace en orden, de la más reciente hacia atrás, y queda registrado en la bitácora.</p></section>
      <section class="card"><h2>📝 Nota en la bitácora</h2><textarea id="note" class="input" rows="2" maxlength="300" placeholder="Ej. Se lastimó un tobillo, sale a la enfermería"></textarea><button class="btn" data-act="note">Agregar nota</button></section>
      <section class="card"><h2>📤 Exportar</h2><div class="btnrow"><button class="btn" data-act="export">Descargar JSON</button><button class="btn" data-act="go" data-screen="imprimir">Resumen imprimible</button></div></section>
      ${vw.phase === 'juego' ? `<section class="card"><h2>🏁 Terminar juego</h2><p class="muted small">Termina ahora. Si quedan lobos vivos, ganan los lobos (como si se acabara el tiempo).</p><button class="btn danger" data-act="end">Terminar juego ahora</button></section>` : ''}
      <section class="card"><button class="btn" data-act="go" data-screen="compartir">🔗 Enlaces para compartir</button> <button class="btn" data-act="go" data-screen="nombre">👤 Cambiar mi nombre</button></section>`;
  }

  function screenCompartir() {
    const vw = S.view;
    const jl = jefeLink(S.code, S.token);
    const pl = vw?.publicToken ? publicLink(S.code, vw.publicToken) : null;
    return `${back('Volver')}
      ${shareBlock({ id: 'jefes', title: '🔑 Enlace de jefes', desc: 'Quien lo tenga puede ver todo y registrar acciones. Compártelo solo con jefes.', url: jl, waText: `Lobos en el parque · enlace de JEFES (no lo compartas con los muchachos): ${jl}` })}
      ${pl ? shareBlock({ id: 'publica', title: '📺 Pantalla pública', desc: 'Solo lectura: cronómetro, fichas, bote, vivos y muertos con roles revelados y bitácora pública. Para proyectar o enseñar a los muchachos.', url: pl, waText: `Lobos en el parque · pantalla pública: ${pl}`, openLabel: 'Abrir' }) : ''}`;
  }

  // ------------------------------------------------------------ final
  function screenFinal() {
    const vw = S.view;
    const f = vw.final;
    const top = f.topTeams.map(tname).join(' y ');
    const topChips = T(f.topTeams[0])?.chips;
    return `<section class="card final ${f.winner}"><p class="lbl">Fin del juego</p>
        <h1>${f.winner === 'lobos' ? '🐺 Ganan los lobos' : '🏡 Ganan los aldeanos'}</h1><p>${esc(f.reason)}</p>
        <p class="big-text">🏆 Equipo con más fichas: <b>${top}</b> (${topChips})</p>
        ${f.potLeft ? `<p class="muted">Bote sin reclamar que se queda en el banco: 🪙 ${f.potLeft}</p>` : ''}</section>
      ${ledgerTable()}
      <section class="card"><h3>Todos los roles</h3>${vw.teams
        .map(
          (t) => `<h4>${esc(t.name)}</h4><ul class="players">${vw.players
            .filter((p) => p.teamId === t.id)
            .map((p) => `<li class="${dead(p) ? 'is-dead' : ''}"><span class="pname">${esc(p.name)}</span>${statusChip(p)}${roleChip(p.role)}</li>`)
            .join('')}</ul>`,
        )
        .join('')}</section>
      <section class="card"><h3>Línea de tiempo</h3>${timeline()}</section>
      <section class="card"><div class="btnrow"><button class="btn" data-act="export">Descargar JSON</button><button class="btn" data-act="go" data-screen="imprimir">Resumen imprimible</button></div></section>`;
  }
  function timeline() {
    const vw = S.view;
    const items = vw.log.filter((e) => !e.undone && !e.isUndo && e.gt != null && !['senas', 'rol', 'setup', 'asignarRoles', 'paso'].includes(e.type));
    return `<ul class="timeline">${items.map((e) => `<li><span class="t">${fmtUp(e.gt)}</span><span>${esc(e.text)}</span></li>`).join('')}</ul>`;
  }

  function screenImprimir() {
    const vw = S.view;
    const f = vw.final;
    return `<div class="noprint btnrow">${back('Volver')}<button class="btn primary" data-act="doPrint">🖨 Imprimir</button></div>
      <article class="print">
        <h1>Lobos en el parque · partida ${esc(S.code)}</h1>
        <p>${f ? `<b>${f.winner === 'lobos' ? 'Ganaron los lobos' : 'Ganaron los aldeanos'}</b>. ${esc(f.reason)} Equipo con más fichas: <b>${f.topTeams.map(tname).join(' y ')}</b>.` : `Juego ${vw.phase === 'juego' ? 'en curso' : 'en preparación'}.`}</p>
        ${vw.phase !== 'preparacion' ? ledgerTable() : ''}
        <h2>Roles</h2>
        <table class="tbl"><tr><th>Equipo</th><th>Jugador</th><th>Rol</th><th>Estado</th></tr>
        ${vw.teams.flatMap((t) => vw.players.filter((p) => p.teamId === t.id).map((p) => `<tr><td>${esc(t.name)}</td><td>${esc(p.name)}</td><td>${p.role ? ROLE_NAMES[p.role] : '—'}</td><td>${STATUS_NAMES[p.status] || '—'}${p.diedRound ? ` (R${p.diedRound})` : ''}</td></tr>`)).join('')}
        </table>
        <h2>Línea de tiempo</h2>${timeline()}
      </article>`;
  }

  const SCREENS = {
    panel: screenPanel,
    muerte: screenMuerte,
    chismoso: screenChismoso,
    invocacion: screenInvocacion,
    jugadores: screenJugadores,
    recursos: screenRecursos,
    fichas: screenFichas,
    bitacora: screenBitacora,
    mas: screenMas,
    imprimir: screenImprimir,
  };

  // ------------------------------------------------------------ cronómetros y avisos
  function tickUI() {
    if (!S.view) return;
    const g = gtNow();
    let needPoll = false;
    root.querySelectorAll('[data-timer]').forEach((el) => {
      const rem = Number(el.dataset.end) - g;
      const txt = fmtDown(rem);
      if (el.textContent !== txt) el.textContent = txt;
      el.classList.toggle('zero', rem <= 0);
      el.classList.toggle('low', rem > 0 && rem <= 60000);
      if (el.dataset.over) document.getElementById(el.dataset.over)?.classList.toggle('hidden', rem > 0);
      if (rem <= 0 && el.dataset.refresh !== undefined && !el.dataset.polled) {
        el.dataset.polled = '1';
        needPoll = true;
      }
    });
    if (needPoll) setTimeout(poll, 400);
    checkAlerts(g);
  }

  function alertDefs(g) {
    const vw = S.view;
    const out = [];
    if (vw.phase === 'juego') {
      const r = vw.round;
      const c = vw.config;
      if (r.stage === 'ronda') {
        const anyPending = vw.deaths.some((d) => d.status === 'pendiente' && d.gt + c.witchMs > g);
        for (const d of vw.deaths) if (d.window && d.round === r.n && !anyPending) out.push({
            key: `silbato-${d.id}`,
            at: d.status === 'salvada' ? d.savedGt : d.gt + c.witchMs,
            title: '📣 Toquen el silbato: asamblea',
            body: d.status === 'salvada' ? 'La bruja salvó a la víctima. Se cerró la ventana.' : 'Se cerró la ventana de la bruja.',
            strong: true,
          });
        out.push({ key: `ronda1-${r.n}`, at: r.startGt + c.roundMs - 60000, title: '⏳ Queda 1 minuto de ronda' });
        out.push({ key: `ronda8-${r.n}`, at: r.startGt + c.roundMs, title: '⏰ Asamblea obligatoria', body: `La ronda llegó a ${c.roundMs / 60000} minutos. Toquen el silbato.`, strong: true });
      }
      if (r.stage === 'asamblea' && r.assembly.step === 'debate') out.push({ key: `debate-${r.n}`, at: r.assembly.debateStartGt + c.debateMs, title: '🗳️ Terminó el debate', body: 'Pasen a la votación.' });
      for (const i of vw.invocations) if (i.status === 'en_curso') out.push({ key: `inv-${i.id}`, at: i.startGt + c.invokeMs, title: '👻 Terminó la invocación', soft: true });
      out.push({ key: 'juego1', at: c.gameMs - 60000, title: '⏳ Queda 1 minuto de juego', strong: true });
    } else if (vw.phase === 'fin' && S.sawPlaying) {
      out.push({ key: 'fin', at: -1, title: vw.final.winner === 'lobos' ? '🏁 Fin del juego: ganan los lobos' : '🏁 Fin del juego: ganan los aldeanos', body: vw.final.reason, strong: true });
    }
    return out.filter((a) => g >= a.at);
  }

  function checkAlerts(g) {
    let changed = false;
    for (const a of alertDefs(g)) {
      if (S.fired.has(a.key)) continue;
      S.fired.add(a.key);
      changed = true;
      if (a.at >= 0 && g - a.at > 20000) continue; // aviso viejo (teléfono dormido o recién abierto): no sonar
      S.alerts.push(a);
      vibrate(a.strong ? [400, 150, 400, 150, 800] : [250]);
      beep(a.strong ? 3 : 1);
      renderOverlays();
    }
    if (changed) lsSet(`lobos-avisos-${S.code}`, JSON.stringify([...S.fired].slice(-200)));
  }

  // ------------------------------------------------------------ eventos
  const val = (id) => document.getElementById(id)?.value || '';
  const confirmAsk = (msg) => window.confirm(msg);

  const ACTIONS = {
    go(el) {
      S.screen = el.dataset.screen;
      window.scrollTo(0, 0);
      render();
    },
    hide() {
      S.hidden = true;
      renderOverlays();
    },
    unhide() {
      S.hidden = false;
      renderOverlays();
    },
    alertOk() {
      S.alerts.shift();
      renderOverlays();
    },
    copy(el) {
      copyText(el.dataset.url);
    },
    qr(el) {
      const box = document.getElementById(el.dataset.target);
      if (box.innerHTML) box.innerHTML = '';
      else renderQr(box, el.dataset.url);
    },
    // preparación
    setStep(el) {
      setStep(Number(el.dataset.n));
    },
    addTeam() {
      const n = S.draft.teams.length + 1;
      S.draft.teams.push({ id: newId('e').slice(0, 12), name: `Equipo ${n}` });
      S.dirty = true;
      render();
    },
    removeTeam(el) {
      const id = el.dataset.id;
      const has = (S.draft.players[id] || '').trim();
      if (has && !confirmAsk('Ese equipo tiene jugadores capturados. ¿Quitarlo de todos modos?')) return;
      S.draft.teams = S.draft.teams.filter((t) => t.id !== id);
      delete S.draft.players[id];
      S.dirty = true;
      render();
    },
    async saveNext() {
      if (S.draft.teams.some((t) => !t.name.trim())) return toast('Todos los equipos necesitan nombre.', 'error');
      if (await saveSetup()) setStep(S.setupStep + 1);
    },
    async autoRoles() {
      if (S.view.players.some((p) => p.role) && !confirmAsk('¿Volver a repartir? Se reemplazan todos los roles actuales.')) return;
      if (await act('asignarRoles', {}, { okMsg: 'Roles repartidos.' })) S.dealIdx = 0;
    },
    dealShow() {
      S.dealShown = true;
      render();
    },
    dealNext() {
      const total = S.view.players.length;
      S.dealShown = false;
      if (S.dealIdx + 1 < total) S.dealIdx++;
      else {
        toast('Reparto terminado.');
        setStep(4);
        return;
      }
      render();
    },
    dealPrev() {
      S.dealShown = false;
      S.dealIdx = Math.max(0, S.dealIdx - 1);
      render();
    },
    async saveSigns() {
      const r = await act('senas', { lobo: val('sg-lobo'), cazador: val('sg-cazador') });
      if (r) setStep(5);
    },
    async start() {
      if (!confirmAsk('¿Iniciar el juego? Arranca el cronómetro de 60 minutos en todos los teléfonos.')) return;
      if (await act('iniciar', {}, { okMsg: '¡Comenzó el juego!' })) {
        S.screen = 'panel';
        render();
      }
    },
    // juego
    cause(el) {
      S.deathCause = el.dataset.cause;
      render();
    },
    async submitDeath() {
      const payload = { victimId: val('m-victim'), cause: S.deathCause };
      if (!payload.victimId) return toast('Elige a la víctima.', 'error');
      if (S.deathCause === 'lobo') {
        payload.byId = val('m-by');
        if (!payload.byId) return toast('Elige qué lobo hizo la seña.', 'error');
      }
      if (S.deathCause !== 'bruja') {
        payload.seen = !!document.getElementById('m-seen')?.checked;
        if (!payload.seen) return toast('Solo cuenta si un jefe la vio: marca "Yo lo vi".', 'error');
      }
      if (await act('muerte', payload, { okMsg: 'Muerte registrada. Corre la ventana de la bruja.' })) {
        S.screen = 'panel';
        render();
      }
    },
    async save(el) {
      if (!confirmAsk('¿La bruja salvó a la víctima? Se usa su pócima de salvar y la muerte se anula.')) return;
      await act('salvar', { deathId: el.dataset.id }, { okMsg: 'La bruja salvó a la víctima.' });
    },
    async startAssembly() {
      if (!confirmAsk('¿Iniciar la asamblea? Termina la ronda y quien siga en la fila de invocación la pierde.')) return;
      if (await act('asamblea')) {
        S.screen = 'panel';
        window.scrollTo(0, 0);
        render();
      }
    },
    step(el) {
      act('paso', { to: el.dataset.to });
    },
    bet(el) {
      const t = el.dataset.team;
      const playerId = val(`bet-${t}`);
      if (!playerId) return toast('Elige por quién apuesta.', 'error');
      act('apuesta', { teamId: t, playerId });
    },
    unbet(el) {
      act('quitarApuesta', { teamId: el.dataset.team });
    },
    async vote() {
      const v0 = val('vote-player');
      if (!v0) return toast('Elige al expulsado o "Empate".', 'error');
      const name = v0 === '__empate' ? 'empate (nadie sale)' : P(v0).name;
      if (!confirmAsk(`¿Registrar votación: ${name}?`)) return;
      act('votacion', { playerId: v0 === '__empate' ? null : v0 });
    },
    newRound() {
      act('nuevaRonda', {}, { okMsg: 'Nueva ronda: 8 minutos.' });
    },
    async gossip() {
      const targetId = val('g-target');
      if (!targetId) return toast('Elige a la persona.', 'error');
      const r = await act('chismoso', { targetId });
      if (r) {
        const g = r.view.gossip[r.view.gossip.length - 1];
        S.lastGossip = g?.id;
        window.scrollTo(0, 0);
        render();
      }
    },
    gossipDone() {
      S.lastGossip = null;
      render();
    },
    invAdd() {
      const teamId = val('inv-team');
      const ghostId = val('inv-ghost');
      if (!teamId || !ghostId) return toast('Elige el equipo y el fantasma.', 'error');
      act('invocar', { teamId, ghostId }, { okMsg: 'Agregado a la fila.' });
    },
    invStart(el) {
      act('invocacionIniciar', { id: el.dataset.id });
    },
    invEnd(el) {
      act('invocacionTerminar', { id: el.dataset.id });
    },
    invRemove(el) {
      if (confirmAsk('¿Quitar de la fila? El equipo podrá volver a formarse.')) act('invocacionQuitar', { id: el.dataset.id });
    },
    reveal(el) {
      const id = el.dataset.id;
      if (S.revealed.has(id)) S.revealed.delete(id);
      else S.revealed.add(id);
      render();
    },
    revealAll() {
      S.revealAll = !S.revealAll;
      S.revealed.clear();
      render();
    },
    pause() {
      act('pausa', {}, { okMsg: 'Juego en pausa.' });
    },
    resume() {
      act('reanudar', {}, { okMsg: 'Se reanuda el juego.' });
    },
    async undo() {
      const last = lastUndoable();
      if (!last) return;
      if (!confirmAsk(`¿Deshacer esta acción?\n\n${last.text}`)) return;
      await act('deshacer', {}, { okMsg: 'Acción deshecha.' });
    },
    async note() {
      const text = val('note').trim();
      if (!text) return toast('Escribe la nota.', 'error');
      if (await act('nota', { text }, { okMsg: 'Nota agregada.' })) {
        document.getElementById('note').value = '';
      }
    },
    async export() {
      try {
        const data = await api(`/partidas/${S.code}/exportar`, { headers: { 'x-token': S.token } });
        download(`lobos-${S.code}.json`, JSON.stringify(data, null, 2));
      } catch (e) {
        toast(e.message, 'error');
      }
    },
    doPrint() {
      window.print();
    },
    async end() {
      if (!confirmAsk('¿Terminar el juego ahora? Se calculan los bonos finales.')) return;
      await act('terminar');
    },
  };

  root.addEventListener('click', (e) => {
    unlockAudio();
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const fn = ACTIONS[el.dataset.act];
    if (fn) {
      e.preventDefault();
      fn(el, e);
    }
  });
  overlayRoot.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (el && ACTIONS[el.dataset.act]) ACTIONS[el.dataset.act](el, e);
  });
  root.addEventListener('submit', (e) => {
    const f = e.target.closest('[data-form="name"]');
    if (!f) return;
    e.preventDefault();
    const name = val('name-input').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!name) return toast('Escribe tu nombre.', 'error');
    S.name = name;
    lsSet(NAME_KEY, name);
    S.screen = S.screen === 'nombre' ? 'mas' : 'panel';
    unlockAudio();
    render();
    poll();
  });
  root.addEventListener('change', (e) => {
    const el = e.target.closest('[data-change="role"]');
    if (el && el.value) act('rol', { playerId: el.dataset.id, role: el.value });
  });
  root.addEventListener('input', (e) => {
    const el = e.target;
    const b = el.dataset.bind;
    if (!b || !S.draft) return;
    if (b === 'team') {
      const t = S.draft.teams.find((x) => x.id === el.dataset.id);
      if (t) t.name = el.value;
      S.dirty = true;
    } else if (b === 'players') {
      S.draft.players[el.dataset.id] = el.value;
      S.dirty = true;
      const total = S.draft.teams.reduce((a, t) => a + (S.draft.players[t.id] || '').split('\n').filter((x) => x.trim()).length, 0);
      const pc = document.getElementById('pcount');
      if (pc) pc.textContent = total;
    } else if (b === 'sign') {
      S.draft.signs[el.dataset.k] = el.value;
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) poll();
  });
  window.addEventListener('beforeunload', (e) => {
    if (S.dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  render();
  poll();
  setInterval(poll, 2000);
  setInterval(tickUI, 250);
}
