---
titulo: Aislamiento de objetivo por sesión — dos agentes manejando el mismo navegador
feature: session-isolation
estatus: cerrada
fecha_creacion: 2026-11-06
actualizado: 2026-11-06
siguiente: —
modo: implementacion
tags: [herdr-browser, cdp, concurrencia, cli, issue-1]
---

# Aislamiento de objetivo por sesión

Cierra el issue público [Abrahamism/herdr-browser#1](https://github.com/Abrahamism/herdr-browser/issues/1):
dos clientes del CLI manejando el mismo navegador se pisan las pestañas porque todos resuelven el
objetivo con un único `state.json.activeTargetId` y caen a `tabs[0]`. El arreglo es una identidad
de cliente por invocación y propiedad explícita de pestañas, sin depender de la suerte.

## Specs

- **S1** — "Two clients can drive the browser concurrently without retargeting each other: each
  client's commands address only tabs it owns or explicitly named, and `tabs --json` distinguishes
  them."
- **S2** — "Give each invocation a client identity (`--session <name>` or
  `HERDR_BROWSER_SESSION`) and persist an ownership map `targetId -> session` next to
  `state.json`."
- **S3** — "Make `open` allocate a new tab per session by default instead of reusing `tabs[0]`;
  keep reuse behind `--reuse`."
- **S4** — "Resolve targets only within the caller's session-owned tabs, and fail loudly with a
  clear error when the caller has none instead of silently falling back to `tabs[0]`."
- **S5** — "Surface `session`/`owner` in `tabs --json` so an agent can see which tab is whose."
- **S6** — "Make `stop` session-scoped (`stop --session`, closing only that client's tabs) and
  require an explicit `--all` to close the shared browser."
- **S7** — "Document the multi-agent contract in `README.md` and
  `skills/herdr-browser/SKILL.md`."

## Interpretaciones fijadas (no contradicen el issue; las eligió el implementador)

- **I1 — Sesión por defecto = `default`.** Sin `--session` ni `HERDR_BROWSER_SESSION`, un cliente
  único se comporta exactamente como hoy: su pestaña, su `open`, su `stop`. La compatibilidad no
  se negocia: el caso de un solo agente no cambia.
- **I2 — Una pestaña tiene un solo dueño y el dueño se escribe al abrir.** No hay *leases* ni
  expiración: el archivo de sesión lista los `targetId` que esa sesión abrió. Un `targetId` que ya
  no existe se poda al leer; no se reescribe nada por podar.
- **I3 — `--page` sigue siendo nombrado explícito y cruza sesiones.** "or explicitly named" (S1):
  si pasás un id ajeno, la orden va a esa pestaña. Sin `--page`, jamás se toca una pestaña de otro.
- **I4 — Pestañas sin dueño son legado/humano.** Una pestaña abierta por el mod, por una versión
  anterior o por el usuario no la reclama nadie. Si la sesión no tiene pestañas propias, resolver
  sobre una pestaña sin dueño mantiene el comportamiento previo (y prefiere el `activeTargetId`
  viejo de `state.json` si sobrevive). Nunca se toma una pestaña de otra sesión.
- **I5 — `stop` cierra el navegador cuando no queda nada abierto.** Cierra sus pestañas, borra su
  archivo y, si no queda ninguna pestaña viva en el perfil, hace el cierre completo de hoy
  (`Browser.close` + borrar `state.json` + imprimir `browser: stopped`). Con pestañas de otras
  sesiones vivas, no toca el navegador. `--all` fuerza el cierre completo siempre.
- **I6 — `tabs --json` suma campos, no quita ninguno.** `session`, `owned` y `active` se agregan
  junto a `index`, `id`, `title`, `url`, `attached`.
- **I7 — Mismo nombre de sesión = mismo cliente.** Dos procesos con el mismo `--session` comparten
  pestaña activa y no coordinan sus escrituras (no hay lock entre procesos). Es intencional: la
  sesión es la identidad, y dos procesos del mismo agente son un cliente. Aislamiento real entre
  agentes = nombres distintos (o perfiles distintos).

## Tasks

- [x] **T1** — `src/sessions.mjs`: identidad de sesión, archivo por sesión (`sessions/<name>.json`),
      propiedad, poda contra pestañas vivas, escritura atómica (tmp + rename). Spec: S2. Ruta: inline.
      Commit: `8224d05`.
- [x] **T2** — Resolución de objetivo por sesión en `resolveTarget`: propio → `--page` → sin dueño →
      error alto con instrucción. Spec: S1, S4, I3, I4. Ruta: inline. Commit: `8224d05`.
- [x] **T3** — `open` por sesión: reusa su pestaña, `--new` asigna, `--reuse` reusa o adopta una sin
      dueño, error si no hay nada que reusar. Spec: S3, I2, I4. Ruta: inline. Commit: `8224d05`.
- [x] **T4** — `tabs` (humano + `--json` con dueño), `status`, `activate` y `close` coherentes con la
      propiedad; ayuda del CLI actualizada. Spec: S1, S5, I6. Ruta: inline. Commit: `8224d05`.
- [x] **T5** — `stop` por sesión + `stop --all`; `browser: stopped` solo cuando el navegador se
      cierra de verdad. Contrato roto a propósito (`stop` ya no mata el navegador si otro cliente
      tiene pestañas). Spec: S6, I5. Ruta: inline. Commit: `8224d05` (posible porque el hunk de
      `stop` vive en el mismo archivo que la resolución: separarlo dejaba un commit con la suite en
      rojo, prohibido por el flujo).
- [x] **T6** — Tests: 5 unitarios de sesiones, 5 de CLI (dos procesos concurrentes contra el CDP
      falso, ya *stateful* en `test/fake-cdp.mjs`), e2e actualizado. Spec: S1-S6. Ruta: inline.
      Commit: `8224d05`.
- [x] **T7** — Docs: README (sección multi-agente, flags, semántica de `stop`, ruta del proyecto
      genérica en la skill del repo), `skills/herdr-browser/SKILL.md` y la copia instalada en
      `~/.agents/skills/herdr-browser/SKILL.md` con su ruta absoluta. Spec: S7. Ruta: inline.
- [x] **T8** — Verificación independiente (`gentle-ai-verify`) y prueba real con dos sesiones contra
      Brave. Spec: S1-S7. Ruta: `gentle-ai-verify` + inline.

## Evidencia

- Mapa del CLI (explorador read-only, 2026-11-06): `state.activeTargetId` solo lo escribían
  `cli.mjs:116-119` (`saveActive`) y se leía en `cli.mjs:125-126` (`activeTab`) y `cli.mjs:239`
  (`tabs`); `pageHandle` era el único chokepoint de 9 comandos; `listTabs` (`tabs.mjs:13-19`) nunca
  marcaba `active`, así que `resolveTab` siempre caía a `tabs[0]`.
- El mod `mods/browser-tabs` solo lee `state.port` y `/json/list`: los archivos de sesión no lo
  afectan (verificado leyendo `mods/browser-tabs/main.js`).
- `npm test`: 45 tests, **44 pass, 0 fail, 1 skip** (el e2e, gateado). `npm run test:e2e`:
  **1 pass** con Brave headless real en ~3 s.
- Prueba real de dos sesiones (Brave headless + HTTP local, 2026-11-06): cada sesión en su pestaña
  (`/a` y `/b`), `stop --session agent-a` cierra solo la suya y `agent-b` sigue en `/b`;
  `stop --all` cierra el navegador (`browser: stopped`, `status` → `browser: not running`).
  Todas las comprobaciones en verde.
- Verificación independiente (`gentle-ai-verify`, 2026-11-06): PASS. Veredicto por spec: S1-S6
  COVERED; S7 PARTIAL por dos observaciones —la ruta del proyecto en la skill del repo apuntaba a
  una carpeta vieja y los mensajes de error estaban parafraseados—, ambas corregidas antes del
  commit de docs. Observación no bloqueante aceptada y documentada como I7 (dos procesos con el
  mismo nombre de sesión no coordinan escrituras).

## Log

- **L1** (2026-11-06) — Pedido original, literal: "Hay que ponerse a trabajar en el issue que
  levantamos para el herdr brwser https://github.com/Abrahamism/herdr-browser/issues/"
- **L2** (2026-11-06) — Alcance: el issue es la especificación (S1-S7 salen de su cuerpo verbatim);
  las interpretaciones I1-I7 son del implementador y quedan a revisión de Ismael.
- **L3** (2026-11-06) — Estado previo del repo: rama `main`, con cambios sin commitear de la sesión
  anterior (borrado en stage de `bin/panel.mjs`, `bin/open-panel.mjs`, `bin/open-from-herdr.mjs`,
  `herdr-plugin.toml` y edición de README sobre la retirada del plugin). Se dejan intactos: los
  commits de esta feature enumeran rutas explícitas y el hunk de README ajeno vuelve al árbol de
  trabajo después de commitear solo el propio.
- **L4** (2026-11-06) — `stop` cambia de contrato (S6): con pestañas de otra sesión vivas ya no
  cierra el navegador. Un cliente único no nota la diferencia, porque al cerrar su última pestaña
  no queda nada y el cierre completo se dispara igual.
- **L5** (2026-11-06) — Publicado: rama `fix/session-isolation` en `origin` y **PR #2**
  (https://github.com/Abrahamism/herdr-browser/pull/2) con `Closes #1`; el issue queda abierto hasta el
  merge. Es el único paso que faltaba.
- **L6** (2026-11-06) — Al publicar apareció que la historia **local** del repo no comparte raíz con
  `origin/main`: el import local (`440e448`) es un commit distinto del `Initial commit`
  remoto (`74398f8`), sin ancestro común. Los árboles sí eran idénticos en código (solo diferían
  `odd/tasks/herdr-browser.md`, que nunca se publicó, y la ruta de la skill), así que los dos commits
  se hicieron cherry-pick sobre `origin/main` en una rama nueva con el mismo nombre, resolviendo un
  conflicto de una línea en `skills/herdr-browser/SKILL.md`. La verificación se repitió sobre esa
  rama: `npm test` 44 pass / 0 fail / 1 skip y e2e 1 pass. La historia local vieja quedó en la
  rama `backup/session-isolation`, sin pushear y a la espera de que Ismael decida qué hacer con ella.
