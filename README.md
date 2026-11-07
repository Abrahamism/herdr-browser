<h1 align="center">herdr-browser™</h1>

<p align="center"><strong>Un navegador Chromium real para agentes: perfil propio, CDP directo y cero dependencias.</strong></p>

<p align="center">
  <a href="https://github.com/Abrahamism/herdr-browser/releases"><img src="https://img.shields.io/github/v/release/Abrahamism/herdr-browser?style=for-the-badge&labelColor=1A1218&color=F095C8" alt="versión"></a>
  <img src="https://img.shields.io/badge/Node.js-22+-F095C8?style=for-the-badge&labelColor=1A1218" alt="Node.js 22+">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-F095C8?style=for-the-badge&labelColor=1A1218" alt="plataformas">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-F095C8?style=for-the-badge&labelColor=1A1218" alt="licencia MIT"></a>
  <img src="https://img.shields.io/badge/dependencias-0-F095C8?style=for-the-badge&labelColor=1A1218" alt="cero dependencias">
</p>

<p align="center">
  <strong>
    <a href="#uso-del-cli">Uso</a> &nbsp;·&nbsp;
    <a href="#versión-120">Novedades</a> &nbsp;·&nbsp;
    <a href="#mod-de-herdr-pestañas-del-navegador">Mod</a> &nbsp;·&nbsp;
    <a href="#allowlist-por-sesión">Allowlist</a> &nbsp;·&nbsp;
    <a href="#captura-de-red-har">Red</a> &nbsp;·&nbsp;
    <a href="CHANGELOG.md">Changelog</a>
  </strong>
</p>

<br>

Navegador Chromium real (Brave por defecto) con control por CDP y soporte de extensiones de Chrome, pensado para usarse desde herdr.

## Qué es

herdr-browser lanza un navegador Chromium en su propia ventana con un perfil dedicado y un endpoint de depuración (CDP). El agente controla la pestaña por CDP (clic, escritura, teclas, desplazamiento, capturas) sin mover el puntero físico ni robar el mouse del usuario. Se integra a herdr-app con el mod `browser-tabs`, que lista las pestañas en un panel.

## Versión 1.2.0

Lo que trae esta entrega. Cada punto tiene su sección más abajo.

| Mejora | Cómo se usa | Qué resuelve |
|---|---|---|
| Esperar sin polling | `wait --for ...` | Bloquea hasta que la página llega al estado pedido; un timeout sale con código 1, nunca como éxito |
| Ceder el navegador | `handoff --message ...` | Login, 2FA o CAPTCHA: lo hace la persona y el agente sigue solo |
| Retos anti-bot | `open --challenge-wait` | Reporta Cloudflare, Akamai, DataDome, PerimeterX, Imperva, AWS WAF y CAPTCHA en vez de fingir que la página cargó |
| Menos detectable | automático | Sin `Runtime.enable`, sin refs en el DOM, cursor en shadow root cerrado, `navigator.webdriver` en false |
| Allowlist por sesión | `allow`, `open --allow-origin` | El agente no sale de los dominios autorizados; un redirect fuera de la lista se rechaza |
| Captura de red | `network --url ... --file x.har` | HAR 1.2 con credenciales redactadas y sin cuerpos de respuesta |
| Limpieza de pestañas | `tabs cleanup --idle 10m` | Cierra lo ocioso; nunca una pestaña que abrió una persona |

La versión instalada se consulta con `herdr-browser --version`; el detalle completo está en
`CHANGELOG.md`.

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

TTL de pestañas: `tabs cleanup [--idle <ms|s|m>] [--all] [--dry-run] [--json]` cierra las pestañas inactivas (10 minutos por defecto). `--all` alcanza las de todas las sesiones. Una pestaña que nadie posee nunca se cierra: pertenece al humano. Cualquier comando que resuelva una pestaña reinicia su temporizador (`lastUsedAt`), así que una pestaña en uso no se barre.

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

## Allowlist por sesión

`open --allow-origin <patrones>` fija una lista de orígenes permitidos en el archivo de la sesión. `allow list|add|remove|clear` la administra. Reglas de matching:

- `about:blank` siempre se permite.
- Un patrón sin puerto vale para cualquier puerto; con puerto debe coincidir exacto.
- `example.com` coincide solo con `example.com` (no subdominios).
- `*.example.com` coincide con cualquier subdominio y nunca con el apex.
- Un patrón con esquema (`https://example.com`) exige el mismo esquema y host (puerto por defecto).
- `file://` solo se permite si el patrón es literalmente `file://`.
- Una URL que no se puede parsear nunca coincide.

Límite honesto: un popup que sale de la lista se rechaza cuando el siguiente comando de página lo resuelve; no se cierra automáticamente, porque no hay proceso vigilante.

## Captura de red (HAR)

`network [--url <url>] [--idle <ms>] [--timeout <ms>] [--file <out.har>] [--json]` adjunta a la pestaña resuelta, opcionalmente navega, espera red ociosa y escribe un HAR 1.2 con `Authorization`, `Cookie`, `Set-Cookie` y otros headers sensibles redactados a `<redacted>`. También se redactan los parámetros sensibles de la query string (`?token=…`, `?api_key=…`, `?session_id=…`) y se dejan intactos los que son datos (`?store_id=42`). Los cuerpos de respuesta no se almacenan.

Límite honesto: la captura vive dentro de una sola invocación; no hay daemon que escuche entre comandos. El comando adjunta, opcionalmente navega, espera red ociosa y escribe el archivo.
Segundo límite, medido y no supuesto: Chromium reporta cookies y `Authorization` en los eventos
*extra-info* del protocolo, que este comando **no** recolecta. Verificado con un servidor local que
recibió la cookie y la devolvió en el cuerpo: la credencial viajó en la petición y el HAR no guardó
ni su valor ni su nombre. La redacción de headers sí está cubierta por tests para el caso en que el
header llegue en el evento principal.

## Límites

- Sin Web Store (solo extensiones desempaquetadas).
- Los iframes out-of-process se leen y se clican: sus refs llevan prefijo (`f1e12`). `eval` y `get` siguen operando sobre el documento principal.
- Sin input del sistema operativo (todo por CDP).
- El puntero físico no se mueve.
- Si el DOM cambia entre `snapshot` y `click`/`fill`, un ref puede apuntar a otro elemento: volvé a correr `snapshot` antes de actuar.

## Built with

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/Chromium-4285F4?style=flat-square&logo=googlechrome&logoColor=white" alt="Chromium">
  <img src="https://img.shields.io/badge/CDP-1A1218?style=flat-square&logo=googlechrome&logoColor=F095C8" alt="Chrome DevTools Protocol">
  <img src="https://img.shields.io/badge/0%20dependencias-F095C8?style=flat-square&labelColor=1A1218&color=F095C8" alt="sin dependencias">
</p>

<p align="center">
  <img src="docs/gentle-ai.png" width="64" alt="gentle-ai">
  <br>
  <sub>Construido con <a href="https://github.com/Gentleman-Programming/gentle-shell">gentle-ai</a> · orquestación, memoria y revisión</sub>
</p>

## Verificación

```bash
npm test          # unitarios + CLI contra un servidor CDP falso
npm run test:e2e  # integración real con Brave headless
```
