// Portada: crear partida y obtener los enlaces.
import { api, esc, jefeLink, publicLink, shareBlock, copyText, renderQr, rememberGame, recentGames, toast } from './common.js';

export function startPortada(root) {
  let created = null;

  function render() {
    if (created) {
      const jl = jefeLink(created.code, created.token);
      const pl = publicLink(created.code, created.publicToken);
      root.innerHTML = `<main class="wrap">
        <section class="card center"><p class="lbl">Partida creada</p><h1 class="code">${esc(created.code)}</h1>
          <p>Comparte el enlace de jefes con los demás dirigentes. Cada quien escribe su nombre al entrar.</p>
          <a class="btn primary xxl" href="${esc(jl)}">Entrar como jefe →</a></section>
        ${shareBlock({ id: 'jefes', title: '🔑 Enlace de jefes', desc: 'Quien lo tenga puede ver todo y registrar acciones. Solo para jefes.', url: jl, waText: `Lobos en el parque · enlace de JEFES (no lo compartas con los muchachos): ${jl}` })}
        ${shareBlock({ id: 'publica', title: '📺 Pantalla pública (opcional)', desc: 'Solo lectura, para proyectar o enseñar a los muchachos. Nunca muestra roles secretos.', url: pl, waText: `Lobos en el parque · pantalla pública: ${pl}`, openLabel: 'Abrir' })}
      </main>`;
      return;
    }
    const recent = recentGames();
    root.innerHTML = `<main class="wrap">
      <section class="hero">
        <div class="hero-ic">🐺🌲</div>
        <h1>Lobos en el parque</h1>
        <p>Panel en tiempo real para los jefes: roles, muertes, bruja, asambleas, bote e invocaciones, sincronizado en todos los teléfonos.</p>
        <button class="btn primary xxl" data-act="create">＋ Crear partida nueva</button>
      </section>
      ${
        recent.length
          ? `<section class="card"><h3>Partidas recientes en este teléfono</h3><ul class="plain">${recent
              .map((g) => `<li><a href="${esc(jefeLink(g.code, g.token))}">${esc(g.code)}</a> <span class="muted small">${new Date(g.at).toLocaleString('es-MX')}</span></li>`)
              .join('')}</ul></section>`
          : ''
      }
      <section class="card"><h3>¿Cómo funciona?</h3><ol>
        <li>Crea la partida y comparte el <b>enlace de jefes</b> por WhatsApp o QR.</li>
        <li>Captura equipos y jugadores; la app reparte los roles.</li>
        <li>Enseña cada rol en la tienda de roles y define las señas.</li>
        <li>Inicia el juego: todos los jefes ven lo mismo en segundos.</li>
      </ol></section>
    </main>`;
  }

  root.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const a = el.dataset.act;
    if (a === 'create') {
      el.disabled = true;
      try {
        created = await api('/partidas', { method: 'POST' });
        rememberGame(created.code, created.token);
        render();
      } catch (err) {
        toast(err.message || 'No se pudo crear la partida.', 'error');
        el.disabled = false;
      }
    } else if (a === 'copy') copyText(el.dataset.url);
    else if (a === 'qr') {
      const box = document.getElementById(el.dataset.target);
      if (box.innerHTML) box.innerHTML = '';
      else renderQr(box, el.dataset.url);
    }
  });

  render();
}
