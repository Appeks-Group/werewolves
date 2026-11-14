# Lobos en el parque · app de jefes

Aplicación web para que los jefes (dirigentes scouts) administren en tiempo real **"Lobos en el parque"**, una variante de "Hombres lobo" para jugar en campo abierto. Cada jefe la usa desde su teléfono y todos ven lo mismo en segundos.

- **Frontend:** HTML, CSS y JavaScript sin frameworks, en `public/`.
- **API:** Netlify Functions (v2, ESM) en `/api/*`.
- **Datos:** cada partida es un JSON en Netlify Blobs (`partidas`, consistencia fuerte), con escrituras condicionales por ETag y reintentos. Así, si dos jefes registran algo al mismo tiempo, no se pierde ningún cambio.
- **Sincronización:** cada teléfono consulta el servidor cada 2 segundos con `?since=<versión>`. Si nada cambió, la respuesta es `{unchanged:true}`.

## Estructura

```
lib/game.mjs              Reglas puras del juego (sin dependencias). El estado se reconstruye desde la lista de acciones.
lib/api.mjs               Manejador HTTP (Request/Response estándar), independiente del hosting.
lib/memory-store.mjs      Almacenamiento en memoria con la misma semántica de ETag que Blobs.
netlify/functions/api.mjs Adaptador para Netlify (Blobs).
scripts/dev-server.mjs    Servidor local sin Netlify (sirve public/ y la API en memoria).
scripts/simulate.mjs      Cientos de partidas aleatorias que verifican las reglas.
scripts/api-test.mjs      Prueba de la API: escrituras simultáneas y privacidad de la pantalla pública.
public/                   index.html, styles.css y js/ (portada, jefes, pantalla pública).
```

## Probar en tu computadora

Se necesita Node.js 20 o más reciente.

```bash
npm install
npm run dev          # http://localhost:8888
npm test             # simulación + prueba de la API
```

El servidor local guarda las partidas en memoria, así que se pierden al detenerlo. Para que otros teléfonos de tu red lo abran, usa la IP de tu computadora (por ejemplo `http://192.168.1.20:8888`).

También puedes probar un despliegue real: `BASE_URL=https://tu-sitio.netlify.app npm run test:api`. En ese modo se omite la parte que adelanta el reloj.

## Desplegar desde GitHub en Netlify

1. Crea un repositorio **vacío** en GitHub (por ejemplo `lobos-en-el-parque`), sin README ni .gitignore.
2. Desde esta carpeta, súbelo:
   ```bash
   git init
   git add .
   git commit -m "App de jefes para Lobos en el parque"
   git branch -M main
   git remote add origin https://github.com/TU_USUARIO/lobos-en-el-parque.git
   git push -u origin main
   ```
3. En [app.netlify.com](https://app.netlify.com) entra a **Add new site → Import an existing project → GitHub** y elige el repositorio.
4. En la configuración de build:
   - **Base directory:** vacío
   - **Build command:** vacío (no hay build)
   - **Publish directory:** `public`
   - **Functions directory:** `netlify/functions` (ya viene en `netlify.toml`)
5. Pulsa **Deploy**. Netlify instala `@netlify/blobs`, empaqueta la función y habilita Blobs sin configuración extra.
6. Abre la URL del sitio, crea una partida y comparte el enlace de jefes.

Cada `git push` a `main` vuelve a desplegar el sitio.

## Cómo se usa

1. **Portada → Crear partida.** Obtienes el **enlace de jefes** (`?g=CÓDIGO&t=TOKEN`), que se comparte por WhatsApp, copiando el enlace o con QR, y el **enlace de pantalla pública** (`?g=CÓDIGO&p=TOKEN`), de solo lectura.
2. Cada jefe escribe su nombre una vez. Todo lo que registre queda firmado en la bitácora.
3. **Preparación:** equipos → jugadores → roles → reparto en la tienda de roles → señas → iniciar.
   - **Con tarjetas (manual):** la app dice cuántas tarjetas de cada rol poner boca abajo en la mesa (las de la tabla, ajustables). Llama a cada jugador uno por uno. Tú tocas la tarjeta que sacó y la app descuenta las que quedan. Luego, en "Reparto", usa "Solo lobos" para que cada lobo vea a los demás y la seña.
   - **Automático:** la app reparte al azar las cantidades de la tabla entre todos los jugadores.
4. **Juego:** registrar muertes (con "Yo lo vi"), ventana de 1 minuto de la bruja, aviso de silbato, asamblea guiada (anuncio, apuestas, debate, votación y bote), chismoso, fila de invocación, pausa, deshacer y exportar.
5. El final se detecta solo: ya no quedan lobos, los lobos igualan o superan a los aldeanos, o se acaba el tiempo. Ahí la app calcula los bonos y muestra el desglose.

### Decisiones de diseño que conviene saber

- **Deshacer:** revierte la última acción vigente, en orden, y queda registrado en la bitácora. Puede deshacer incluso el inicio del juego.
- **Pausa:** congela todos los cronómetros: juego, ronda, debate, bruja e invocación.
- **Revelación de roles:** el rol de una víctima de lobo, cazador o bruja se revela cuando se cierra la ventana de la bruja, no antes. Así una víctima salvada no queda expuesta. Las expulsiones por votación se revelan al momento.
- **Mártir:** el +3 se suma en cuanto se confirma que fue el primer muerto. Los bonos de integridad, mejor apostador y lobos se suman al terminar.
- **Muertos:** los lobos muertos, por la causa que sea, quedan "fuera" y no son fantasmas. Los aldeanos muertos son fantasmas y se pueden invocar.
- **Terminar a mano** (en "Más"): si quedan lobos vivos, ganan los lobos, igual que si se acabara el tiempo.
