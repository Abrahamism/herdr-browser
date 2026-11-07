# herdr-browser

Navegador Chromium real (Brave por defecto) con control por CDP y soporte de extensiones de Chrome, pensado para usarse desde herdr.

## Qué es

herdr-browser lanza un navegador Chromium en su propia ventana con un perfil dedicado y un endpoint de depuración (CDP). El agente controla la pestaña por CDP (clic, escritura, teclas, desplazamiento, capturas) sin mover el puntero físico ni robar el mouse del usuario. Se integra a herdr como plugin: acciones y un panel de pestañas.

## Demo

El agente mueve el cursor, escribe y hace clic por su cuenta. Grabado en Wikipedia,
un sitio público y sin sesión iniciada.

![El agente mueve el cursor y hace clic](docs/demo.gif)

Capturas: [búsqueda](docs/demo-search.png) · [resultado](docs/demo-result.png)

## Requisitos

- Node.js 22 o superior.
- Un navegador Chromium: Brave (por defecto), Chrome, Edge o Chromium.

## Instalación

```bash
git clone https://github.com/Abrahamism/herdr-browser.git
cd herdr-browser
herdr plugin link "$PWD"
```

En Windows, con PowerShell o Git Bash, la ruta del plugin es la carpeta donde quedó el clon.

### Skill para agentes (opcional, recomendada)

Copia la skill a la carpeta que leen tus agentes:

```bash
mkdir -p ~/.agents/skills/herdr-browser
cp skills/herdr-browser/SKILL.md ~/.agents/skills/herdr-browser/
```

La skill le enseña al agente el ciclo `snapshot -> decidir -> clic -> verificar`.

## Uso del CLI

```bash
herdr-browser open https://example.com
herdr-browser tabs
herdr-browser snapshot
herdr-browser click e1
herdr-browser fill e2 "texto"
herdr-browser shot captura.png
herdr-browser stop
```

Banderas globales: `--browser`, `--profile`, `--session`, `--exe`, `--no-cursor`, `--json`, `--headless`.

## Varios agentes a la vez

Un mismo perfil puede alimentar a dos agentes sin que se pisen. Cada invocación pertenece a una
sesión: `--session <nombre>` o la variable `HERDR_BROWSER_SESSION`; si no decís nada, es `default`.

```bash
herdr-browser open https://example.com/a --session agent-a
herdr-browser open https://example.com/b --session agent-b
herdr-browser tabs --session agent-a
herdr-browser snapshot --session agent-b
```

- Una sesión es dueña de las pestañas que abre, anotadas en `<perfil>/sessions/<sesión>.json`, al
  lado de `state.json`. Cada archivo lo escribe solo su sesión, así que dos clientes no se pisan
  el estado.
- Un comando sin `--page` resuelve únicamente pestañas propias. Si la sesión no tiene ninguna, usa
  una pestaña sin dueño (abierta a mano o por una versión anterior); si todas tienen dueño, falla
  con un mensaje que nombra la sesión y dice qué correr (`session "agent-a" owns no tabs...`) en
  vez de caer a la primera pestaña.
- `open` reusa la pestaña de esa sesión y crea una nueva cuando no tiene ninguna. `--new` fuerza
  pestaña nueva y `--reuse` reusa la propia o adopta una sin dueño.
- `--page <id>` es explícito y cruza sesiones: sirve para tocar una pestaña ajena a propósito.
- `tabs --json` agrega a cada pestaña `session` (dueño, o `null` si no tiene), `owned` y `active`.
- `stop` cierra solo las pestañas de la sesión y deja el navegador vivo si otro cliente sigue
  trabajando; cuando no queda ninguna pestaña en el perfil, cierra el navegador como siempre.
  `stop --all` cierra el navegador compartido.

Dos procesos con el mismo nombre de sesión son, a propósito, un solo cliente: comparten pestaña
activa y no coordinan escrituras entre sí. Un agente, una sesión.

Si querés aislamiento total, cookies incluidas, cada agente con su propio perfil:
`--profile agent-a` (y `--session` ya no hace falta).

## Control por el agente

El agente usa `snapshot` para obtener refs (`e1`, `e2`…) y luego `click`, `fill`, `type`, `key`, `scroll`, `get`, `eval` y `shot`. Se dibuja un cursor dentro de la página para que el usuario vea dónde actúa.

Los refs no se guardan como atributos en el DOM: `e5` significa "el quinto elemento del mismo recorrido de `snapshot`, con el mismo filtro de visibilidad". Se recalculan al resolver, así que sobreviven entre invocaciones del CLI (incluso en procesos distintos) sin tocar la página.

### Esperar y ceder el control a la persona

```bash
herdr-browser wait --for selector=#tablero --timeout 20s
herdr-browser wait --for text="Sesión iniciada" --json
herdr-browser handoff --message "Entra con tu SSO y avísame"
herdr-browser handoff --for selector=#inicio --timeout 5m
```

`wait` consulta la página cada 200 ms y responde `wait: ok after <ms>` cuando la condición se
cumple. Un `selector=` cuenta como cumplido solo si el elemento se dibuja (no `display:none`), y
un vencimiento sale con **código 1**: un timeout nunca se reporta como éxito.

`handoff` imprime el mensaje para la persona y bloquea hasta que la página navegue o se cumpla
`--for`. Es la forma de resolver un login, un 2FA o un CAPTCHA en el perfil dedicado sin que el
agente adivine: no hay tarjeta ni extensión, es el mismo proceso esperando.

Los tiempos aceptan `500` (milisegundos), `30s` o `5m`.

### Retos anti-bot

Después de cada navegación, `open` revisa si lo que cargó es un reto (Cloudflare, Akamai,
DataDome, PerimeterX, Imperva, AWS WAF) o una página con un CAPTCHA montado, y espera a que el
navegador lo resuelva solo:

```bash
herdr-browser open https://sitio-protegido.example --challenge-wait 30s
```

La detección exige **dos señales** (título y texto) en los intersticiales duros, para no confundir
una nota sobre Cloudflare con un bloqueo; un widget de CAPTCHA se detecta por su marca en el DOM y
basta con uno. Nunca se resuelve nada: si el reto sobrevive al plazo, `open` imprime
`challenge: cloudflare — still there after 15s; run \`herdr-browser handoff\`` y el agente sabe que no
está viendo la página que pidió. `--challenge-wait 0` reporta sin esperar y
`HERDR_BROWSER_CHALLENGE_WAIT_MS` fija el valor por defecto.

## Extensiones

Solo extensiones desempaquetadas (directorios con `manifest.json`):

```bash
herdr-browser extensions add <dir>
herdr-browser extensions list
herdr-browser extensions remove <dir>
```

No se soporta la instalación desde la Web Store (CRX3 + verificación de firma) en v1.

## Perfil

Perfil aislado propio. Para importar cookies y extensiones desde el perfil real de Brave:

```bash
herdr-browser profile import --from brave
```

Copia `Local State`, cookies, datos de login y directorios de extensiones. Riesgo: copia credenciales a un segundo perfil; es una decisión explícita del usuario.

## Integración herdr

Retirada. El plugin clásico de herdr (`herdr-plugin.toml`, `min_herdr_version = "0.9.0"`) y sus
entrypoints (`open-from-herdr`, `open-panel`, `panel`) se eliminaron el 2026-11-03 junto con
herdr 0.9.5. La app vigente es herdr-app y su forma de integración es el mod `browser-tabs`
de la sección siguiente; `bin/herdr-browser.mjs` es el único entrypoint.

## Mod de herdr: pestañas del navegador

`mods/browser-tabs` es un mod de herdr-app que lista en un panel las pestañas del navegador
controlado y te deja activarlas con un clic. No usa `exec`, ni credenciales, ni red fuera de
`127.0.0.1`.

<img src="preview.png" alt="Panel de pestañas del navegador" width="520">

```bash
cp -r mods/browser-tabs ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/browser-tabs
herdr-app do pane.split --direction right --mod browser-tabs
```

La receta completa para reconstruirlo desde cero está en `RECIPE.md`.

## Límites

- Sin Web Store (solo extensiones desempaquetadas).
- Los iframes out-of-process se leen y se clican: sus refs llevan prefijo (`f1e12`). `eval` y `get` siguen operando sobre el documento principal.
- Sin input del sistema operativo (todo por CDP).
- El puntero físico no se mueve.
- Si el DOM cambia entre `snapshot` y `click`/`fill`, un ref puede apuntar a otro elemento: volvé a correr `snapshot` antes de actuar.

## Verificación

```bash
npm test          # unitarios + CLI contra un servidor CDP falso
npm run test:e2e  # integración real con Brave headless
```
