# Changelog

Cambios de herdr-browser. La versión vive en `package.json` y se consulta con
`herdr-browser --version`. Los comandos y sus límites están documentados en `README.md`.

## 1.2.2 (2026-11-07)

### Añadido

- **`login <url> [--profile] [--timeout]`** — abre el navegador del perfil **sin** puerto de
  depuración para que una persona inicie sesión, espera a que cierre la ventana y deja la
  sesión guardada. Es la salida para portales cuyo reto anti-bot rechaza un lanzamiento
  controlado por CDP: la persona resuelve el reto una vez, sin depurador, y desde ahí cada
  comando sobre ese perfil arranca autenticado.
  Medido contra `dash.cloudflare.com`: perfil nuevo en Brave limpio pasa el reto; el mismo
  navegador lanzado por la herramienta no. Con el perfil logueado vía `login`, el dashboard
  carga sin reto bajo CDP.

## 1.2.1 (2026-11-07)

### Corregido

- **El detector de retos se perdía el intersticial real de Cloudflare.** La página se
  sirve como un cascarón vacío que recién después se rellena; el sondeo corría una sola
  vez, encontraba el cuerpo en blanco y concluía "limpio". Ahora vuelve a sondear
  mientras el documento no tenga texto, con un presupuesto de 1,5 s (`settleMs`).
  Verificado contra `dash.cloudflare.com`: antes no reportaba nada, ahora imprime
  `challenge: cloudflare (title and text)`.
- **Faltaba el texto en español del reto** (`Verificación de seguridad en curso`, `no eres
  un bot`): solo estaban las frases en inglés y `verificando`.
- `about:blank` ya no paga el sondeo de asentamiento: un documento vacío no puede ser
  retado.

## 1.2.0 (2026-11-06)

Versión de la entrega de paridad con las herramientas de navegador basadas en extensión,
sin adoptar su arquitectura: perfil dedicado, CDP directo y cero dependencias externas.
Durante el desarrollo se usaron hitos internos (1.0.1 a 1.0.6, uno por capacidad); no
fueron versiones publicadas y se consolidan acá.

### Añadido

- **`wait --for selector|text|url=<valor> [--timeout]`** — espera una condición de la página
  sin hacer polling de `snapshot`. Un `selector=` cuenta solo si el elemento se dibuja, y un
  vencimiento sale con código 1: un timeout nunca se reporta como éxito.
- **`handoff [--message] [--for] [--timeout]`** — imprime el paso humano y bloquea hasta que la
  página navega o se cumple la condición. Es la forma de resolver login, 2FA o CAPTCHA en el
  perfil dedicado: el mismo proceso espera, sin tarjeta ni daemon.
- **Detección de retos anti-bot** — tras cada navegación, `open` reconoce intersticiales de
  Cloudflare, Akamai, DataDome, PerimeterX, Imperva y AWS WAF, además de CAPTCHA montados
  (Turnstile, reCAPTCHA, hCaptcha, PerimeterX, DataDome). Espera `--challenge-wait` (15 s por
  defecto, `HERDR_BROWSER_CHALLENGE_WAIT_MS`) a que el navegador lo resuelva solo y **nunca**
  resuelve uno interactivo.
- **`allow list|add|remove|clear` y `open --allow-origin`** — allowlist de orígenes por sesión.
  `example.com` fija ese host, `*.example.com` cubre subdominios y nunca el apex, un patrón con
  esquema fija el esquema, `about:blank` siempre se permite. Una navegación fuera de la lista
  se rechaza antes de tocar el navegador, y un redirect que sale de la lista se deja en blanco
  y se rechaza.
- **`network [--url] [--idle] [--timeout] [--file] [--json]`** — captura el tráfico de una
  página en un HAR 1.2 con credenciales redactadas y sin cuerpos de respuesta. Una sola
  invocación: adjunta, opcionalmente navega, espera red ociosa y escribe el archivo.
- **`tabs cleanup [--idle] [--all] [--dry-run]`** — barre pestañas ociosas. Cada pestaña lleva
  `lastUsedAt`, cualquier comando que resuelva una pestaña reinicia el contador, y una pestaña
  que no es de ninguna sesión nunca se cierra: es de la persona.

### Cambiado

- Los refs pasaron de atributos `data-herdr-browser-ref` en el DOM a **posiciones en un único
  recorrido** (orden del DOM, solo visibles, tope de 500). No se escribe nada en la página y
  los refs siguen sirviendo desde otro proceso; si el DOM cambia entre `snapshot` y `click`,
  el número puede apuntar a otro elemento, así que hay que volver a hacer `snapshot`.
- `--clave=valor` corta solo en el primer `=`, así `--for url=https://x?a=b` conserva el valor.
- `--timeout`, `--idle` y `--challenge-wait` aceptan `500`, `30s` o `5m`.

### Corregido y seguridad

- **Ningún `Runtime.enable` en sesiones de página**, el tell clásico de CDP. Los contextos de
  frame salen de `Page.createIsolatedWorld`.
- **Cursor en shadow root cerrado**, sin globales en `window` (`__hbPos`, `__hbPaint`).
- **`--disable-blink-features=AutomationControlled`** al lanzar: `navigator.webdriver` queda en
  false sin parchear descriptores.
- **`--version`** imprimía la ayuda en lugar de la versión.
- **`tabs cleanup`** podaba el archivo de sesión antes de cerrar, así que un cierre fallido
  dejaba una pestaña huérfana que ningún barrido alcanzaba. Ahora cierra primero y olvida después.
- **`network --url`** navegaba sin consultar la allowlist.
- **Credenciales en la query string** (`?token=...`, `?api_key=...`, `?session_id=...`) se
  escribían en claro en el HAR aunque los headers y los cuerpos se redactaban. `redactUrl` las
  reemplaza por `<redacted>` y deja intacto el resto de la query (`?store_id=42` sigue legible).
  Lo encontró una verificación independiente antes de publicar.

### Límites conocidos

- Captura de red: vive dentro de una invocación, no hay daemon entre comandos. Chromium reporta
  cookies y `Authorization` en eventos *extra-info* del protocolo que `network` no recolecta,
  así que un HAR puede ser silencioso al respecto (verificado: la cookie viaja y no queda registrada).
- Un popup que sale de la allowlist se rechaza cuando el siguiente comando de página lo resuelve;
  no se cierra automáticamente.
- IPv6 literal (`[::1]`) no se puede fijar en la allowlist; usá un nombre o `127.0.0.1`.

### Verificación de esta versión

- `npm test`: 101 tests, 100 pass, 0 fail, 1 skip (el e2e, gateado).
- `npm run test:e2e`: 1 pass con Brave headless real.
- Cada capacidad se probó además a mano contra Brave real: refs entre procesos, redirect fuera
  de la lista, cookie que viaja sin quedar en el HAR y barrido de pestañas ociosas.
