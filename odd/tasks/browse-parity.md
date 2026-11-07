---
titulo: Paridad con browse — handoff, retos anti-bot, stealth, allowlist, HAR y TTL de pestañas
feature: browse-parity
estatus: cerrada
fecha_creacion: 2026-11-06
actualizado: 2026-11-06
siguiente: —
modo: implementacion
tags: [herdr-browser, cdp, cli, seguridad, stealth, paridad]
---

# Paridad con browse

Seis capacidades que `anomalyco/browse` tiene y nosotros no, elegidas por valor real sobre
nuestro modelo (perfil dedicado, CDP directo, CLI sin dependencias) y descartando lo que solo
tiene sentido con su arquitectura de extensión + relay. Una por una, un commit por cada una.

## Specs

- **S1** — "**`handoff` + `wait --for selector|text|url [--timeout]`.** No necesita extensión: el
  comando imprime instrucciones, hace polling por CDP y bloquea hasta que aparezca la condición."
- **S2** — "**Detección de challenge + espera configurable** post-navegación. Lista de firmas
  contra `title` y `innerText`."
- **S3** — "**Limpieza de stealth.** Sacar `Runtime.enable` de sesiones de página, mover cursor y
  refs a shadow root cerrado con atributos no adivinables, y agregar
  `--disable-blink-features=AutomationControlled`."
- **S4** — "**`--allow-origin` por sesión** en `open`/`navigate`: niega navegaciones fuera de lista
  y cierra popups que salgan."
- **S5** — "**`network` a HAR con redacción** de `Authorization`/`Cookie`."
- **S6** — "**TTL de pestañas** (`--max-idle` en `open`, o barrido en `status`)."
- **S7** — "Cada uno hacer un commint al repo local, con versionado como 1.0.1, 1.0.2. 1.0.3,
  cuando tengan todos integrados saltas al 1.2.0 y ahi es donde lanzamos push al remo remoto"

## Interpretaciones fijadas (las eligió el implementador)

- **I1 — `wait` es honesto sobre el reloj.** Un timeout no es éxito: imprime el estado observado,
  con `--json` devuelve `{ok:false}` y sale con código 1. Nunca inventa una espera que no ocurrió.
- **I2 — `handoff` no coordina por archivos.** Es el mismo proceso esperando: imprime el mensaje
  para la persona, toma la URL como línea base y sigue cuando cambia la URL o cuando se cumple
  `--for`. Sin carril de eventos ni tarjeta: eso pide extensión, y la extensión es justo lo que
  no queremos.
- **I3 — La detección de retos no resuelve nada.** Solo reporta la familia (cloudflare, akamai,
  datadome, perimeterx, imperva, awswaf), espera lo que el navegador resuelve solo y, si persiste,
  manda a `handoff`. Resolver un CAPTCHA o un reto interactivo es trabajo humano, siempre.
- **I4 — Los refs dejan de vivir en el DOM.** `e5` pasa a ser "el quinto elemento del mismo
  recorrido, con el mismo filtro de visibilidad", recalculado al resolver: cero mutación del DOM y
  los refs siguen sirviendo entre invocaciones del CLI. Costo aceptado: si el DOM cambia entre
  `snapshot` y `click`, el ref puede apuntar a otro elemento; se documenta en los límites y el
  error sigue diciendo "run snapshot again".
- **I5 — La allowlist se guarda en el archivo de la sesión**, no en un daemon: `open` la fija y
  cada invocación posterior la lee. Comodín soportado: `*.example.com` (subdominios, no el apex).
- **I6 — `network` captura en una sola invocación.** No hay daemon que escuche eventos entre
  comandos, así que el contrato es: adjuntar, opcionalmente navegar, esperar red ociosa y escribir
  el HAR. Se prefiere un contrato pequeño y verdadero a un `start/stop` que no puede cumplir.
- **I7 — El TTL se cobra explícito.** `tabs cleanup --idle <ms>` cierra lo ocioso de la sesión;
  `--all` alcanza las demás; `--dry-run` lista sin cerrar. `lastUsedAt` se actualiza cada vez que
  un comando resuelve la pestaña.

## Tasks

- [x] **T1** — `wait` y `handoff` (`src/wait.mjs`, CLI, tests). Version 1.0.1. Spec: S1, I1, I2.
- [x] **T2** — Detección de retos (`src/challenge.mjs`, `navigate`, `--challenge-wait`). Version 1.0.2. Spec: S2, I3.
- [x] **T3** — Stealth: sin `Runtime.enable`, refs por índice, cursor en shadow root cerrado, switch de launch. Version 1.0.3. Spec: S3, I4.
- [x] **T4** — Allowlist por sesión (`src/origins.mjs`, `allow`, guardia de navegación). Version 1.0.4. Spec: S4, I5.
- [x] **T5** — Captura de red a HAR con redacción (`src/har.mjs`, comando `network`). Version 1.0.5. Spec: S5, I6.
- [x] **T6** — TTL de pestañas (`tabs cleanup`, `lastUsedAt`). Version 1.0.6. Spec: S6, I7.
- [x] **T7** — Release 1.2.0: README, `skills/herdr-browser/SKILL.md`, CHANGELOG y push. Spec: S7.

## Evidencia

- **Suite:** `npm test` 99 tests, 98 pass, 0 fail, 1 skip (el e2e, gateado). `npm run test:e2e`
  1 pass con Brave headless real. Versión final `herdr-browser 1.2.0`.
- **T1 (1.0.1)** Brave real: `selector=body`, `text=dominio`, `url=example.com` y
  `handoff --for selector=p` resuelven; `#no-existe` sale 1. El primer intento con
  "Example Domain" falló porque la página se sirvió localizada en español: el primitivo
  estaba bien y el smoke estaba mal.
- **T2 (1.0.2)** Brave real con una página local que imita un intersticial de Cloudflare:
  reporta `challenge: cloudflare (title and text)`; `example.com` no reporta nada. El test
  cazó un falso positivo propio: `cloudflare` pelado en el título matcheaba un artículo.
- **T3 (1.0.3)** Brave real, cuatro procesos: `snapshot` numera e1..e4, `click e2` activa el
  SEGUNDO botón (`out=two`), `fill e3` escribe el campo, 0 refs en el DOM,
  `navigator.webdriver` = false, cero `Runtime.enable` en `src/`.
- **T4 (1.0.4)** Brave real: open permitido, `allow list`, open fuera de lista rechazado con
  la pestaña intacta, y un 302 real fuera de la lista rechazado y dejado en `about:blank`.
- **T5 (1.0.5)** Brave real contra un servidor local: la cookie viajó (la página devolvió
  `eco:session=SUPERSECRET`) y ningún HAR contiene el secreto. Chromium reporta cookies en
  eventos *extra-info* que el comando no recolecta: documentado como límite medido.
- **T6 (1.0.6)** Brave real, 3 pestañas en 2 sesiones: dry-run lista 1 y no cierra (3 antes,
  3 después), cierra la envejecida, `--all` alcanza la otra sesión, `--idle 500` sale 1.
- **Revisión del padre sobre el trabajo delegado:** T4 llegó sin los tests del matcher y T5
  con un test que escribía en TEMP sin limpiar y no probaba la redacción; ambas suites las
  escribió el padre. En T3 el escaneo de elementos quedó copiado tres veces (el modo de
  falla del esquema por índice) y se unificó en un solo preludio. En T4 el guardia corría
  después de asignar pestaña; en T5 `network --url` navegaba sin allowlist; en T6 el
  cleanup pruneaba antes de cerrar. Los tres huecos se corrigieron antes del commit.
- **Commits:** `af0c8e5` (retirada del plugin viejo, preexistente), `13eba10` T1,
  `462d947` T2, `5dc1756` T3, `52588f6` T4, `a34ed25` T5, `ffd0505` T6 y el commit de
  release 1.2.0, todos en la rama `feat/browse-parity`.

- **T8 (verificación independiente, `gentle-ai-verify`):** allowlist PASS — el matcher
  rechaza host fuera de lista, el truco de userinfo (`https://example.com@evil.example/`),
  la subida de subdominio al apex y la bajada de esquema; el guardia está en los tres
  puntos que navegan (`open` `src/cli.mjs:371`, `pageHandle` `:207-210`, `network --url`
  `:833`). **Redacción FAIL en 1.2.0**: `?token=…`, `?api_key=…` y `?session_id=…`
  llegaban en claro a `request.url` y `request.queryString` (`src/har.mjs:95-108`).
  Corregido en 1.2.1 con `redactUrl` (parámetros sensibles a `<redacted>`, datos
  intactos, URL sin cambios byte por byte) y cubierto por tests unitarios y de CLI.
  Lección: mi propia verificación real usó cabeceras y cookies, nunca un secreto en la
  query string; el hueco estaba justo fuera de lo que probé.

## Log

- **L1** (2026-11-06) — Pedido original, literal: "Va, los que propones me agradan. Hazlo,
  implementalos, 1 por 1, no inicies uno hasta terminar el otro. Cada uno hacer un commint al repo
  local, con versionado como 1.0.1, 1.0.2. 1.0.3, cuando tengan todos integrados saltas al 1.2.0 y
  ahi es donde lanzamos push al remo remoto"
- **L2** (2026-11-06) — Alcance aceptado: las seis propuestas de mi respuesta de análisis, en su
  orden y con su texto (S1-S6). Los tres descartes siguen descartados: extensión + relay +
  Patchright, pairing ECDH y `execute` con Playwright.
- **L3** (2026-11-06) — Estado previo del repo: rama `fix/session-isolation` ya mergeada a
  `origin/main` (PR #2). El árbol arrastraba la retirada del plugin clásico sin commitear (borrado
  en stage de `bin/panel.mjs`, `bin/open-panel.mjs`, `bin/open-from-herdr.mjs` y
  `herdr-plugin.toml`, más su sección en README); se cierra en `af0c8e5` para que la release no
  dependa de cambios colgados.
