---
titulo: Paridad con browse — handoff, retos anti-bot, stealth, allowlist, HAR y TTL de pestañas
feature: browse-parity
estatus: en-progreso
fecha_creacion: 2026-11-06
actualizado: 2026-11-06
siguiente: T4 — allowlist
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
- [ ] **T4** — Allowlist por sesión (`src/origins.mjs`, `allow`, guardia de navegación). Version 1.0.4. Spec: S4, I5.
- [ ] **T5** — Captura de red a HAR con redacción (`src/har.mjs`, comando `network`). Version 1.0.5. Spec: S5, I6.
- [ ] **T6** — TTL de pestañas (`tabs cleanup`, `lastUsedAt`). Version 1.0.6. Spec: S6, I7.
- [ ] **T7** — Release 1.2.0: README, `skills/herdr-browser/SKILL.md`, CHANGELOG y push. Spec: S7.

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
