# herdr-browser

Navegador Chromium real (Brave por defecto) con control por CDP y soporte de extensiones de Chrome, pensado para usarse desde herdr.

## Qué es

herdr-browser lanza un navegador Chromium en su propia ventana con un perfil dedicado y un endpoint de depuración (CDP). El agente controla la pestaña por CDP (clic, escritura, teclas, desplazamiento, capturas) sin mover el puntero físico ni robar el mouse del usuario. Se integra a herdr como plugin: acciones y un panel de pestañas.

## Demo

El agente mueve el cursor, escribe y hace clic por su cuenta. Grabado en Wikipedia,
un sitio público y sin sesión iniciada.

![El agente mueve el cursor y hace clic](docs/demo.gif)

Capturas: [búsqueda](docs/demo-search.png) · [resultado](docs/demo-result.png)

## Mod de herdr: pestañas del navegador

`mods/browser-tabs` es un mod de herdr-app que lista en un panel las pestañas del navegador
controlado y te deja activarlas con un clic. No usa `exec`, ni credenciales, ni red fuera de
`127.0.0.1`.

![Pestañas del navegador](preview.png)

```bash
cp -r mods/browser-tabs ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/browser-tabs
herdr-app do pane.split --direction right --mod browser-tabs
```

La receta completa para reconstruirlo desde cero está en `RECIPE.md`.

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

Banderas globales: `--browser`, `--profile`, `--exe`, `--no-cursor`, `--json`, `--headless`.

## Control por el agente

El agente usa `snapshot` para obtener refs (`e1`, `e2`…) y luego `click`, `fill`, `type`, `key`, `scroll`, `get`, `eval` y `shot`. Se dibuja un cursor dentro de la página para que el usuario vea dónde actúa.

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

Plugin con acción de apertura y panel de pestañas en un pane (`herdr-plugin.toml`). Incluye `open-from-herdr`, `open-panel` y `panel`.

## Límites

- Sin Web Store (solo extensiones desempaquetadas).
- Los iframes out-of-process se leen y se clican: sus refs llevan prefijo (`f1e12`). `eval` y `get` siguen operando sobre el documento principal.
- Sin input del sistema operativo (todo por CDP).
- El puntero físico no se mueve.

## Verificación

```bash
npm test          # unitarios + CLI contra un servidor CDP falso
npm run test:e2e  # integración real con Brave headless
```
