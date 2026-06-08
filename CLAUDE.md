# Ilum — Guía para Claude Code

Contexto permanente del repo. Léelo al inicio de cada sesión (junto con `TASKS.md`).

## Qué es

Ilum es un guardián para agentes de IA de código (Codex, Claude Code, aider, etc.).
Intercepta comandos peligrosos y vigila cambios en archivos sensibles en tiempo real,
avisando por terminal/Telegram/notificación macOS y permitiendo rollback.

## Stack

- **Node.js ESM puro** (`"type": "module"`). **Sin TypeScript. Sin build step.** Se ejecuta tal cual.
- Deps mínimas: `chalk` (color), `chokidar` (file watch), `express` (dashboard). `node-pty` y `electron` son opcionales.
- `fetch` nativo (Node 18+) para Telegram — sin librerías HTTP.
- La tray app (`tray/`) es Electron y tiene su propio `package.json`/`node_modules`.

## Estructura de carpetas

- `bin/` — ejecutables: `agentguard` (CLI principal) y `agentguard-daemon.js` (proceso del daemon).
- `src/` — toda la lógica (módulos ESM). `src/dashboard/` es el server web + assets estáticos.
- `test/` — tests con `node:test` y unos pocos con jest (ESM). Sin framework pesado.
- `tray/` — app de menu bar en Electron (proyecto Node aparte).
- `shell-wrapper/` — wrapper de shell en Go + scripts (intercepción a nivel shell).
- `docs/` — documentación.

## Tests

```bash
npm test          # corre toda la suite (node:test + jest). Debe quedar verde antes de commit.
```

Los tests fijan `NODE_ENV=test`, lo que redirige el audit log a un archivo temporal en
`$TMPDIR` — **nunca** escriben al log real `~/.agentguard/audit.log`. Al agregar un test
nuevo, añádelo a la cadena del script `test` en `package.json` (la lista es explícita).

## Convenciones ESM

- Usa **`import` / `export`**, nunca `require()` (excepto archivos `.cjs` puntuales como `node-hook.cjs`).
- Extensiones explícitas en imports relativos: `import { log } from "./logger.js"`.
- Módulos puros cuando sea posible (sin I/O ni efectos), con "seams" para testear
  (p.ej. `opts.spawnFn`, `setSink()`, funciones builder puras como `buildTrayPlist`).
- Rutas: absolutas vía `path`/`os.homedir()`/`fileURLToPath`. Nunca incrustes `~` en archivos generados.

## Flujo de trabajo (Git)

- **Rama de trabajo: siempre `dev`. Nunca commitear directo a `main`.**
- `main` solo recibe merges de `dev` al cerrar (y desde ahí se publica a npm).
- Después de cambios: `npm test`. Si falla, **revierte antes de commitear**.
- Commit + push:
  ```bash
  git add <archivos>
  git commit -m "tipo(scope): descripción"
  git push origin dev
  ```
- Hay dos remotes configurados (`morphius101` y `Osva2023`); `git push origin dev` empuja a ambos.

## Archivos que NO tocar sin revisión explícita

- `src/config.js` — carga/merge de configuración.
- `src/logger.js` — formato del audit log y rutas.
- `bin/agentguard` — entry point del CLI.

Si una tarea pide cambiarlos, esa instrucción explícita **es** la revisión: hazlo mínimo y con cuidado.

## Daemon y configuración

- **Config** (`src/config.js` → `loadConfig()`): busca `agentguard.config.json` en el cwd,
  luego `~/.agentguard/config.json`, luego defaults internos. Define `watchPaths`,
  `notifications` (telegram/system/minLevel), `auditLog`, etc.
- **Daemon** (`bin/agentguard-daemon.js`, controlado por `src/daemon-control.js`):
  - PID: `~/.agentguard/daemon.pid` · Log: `~/.agentguard/daemon.log` · Audit: `~/.agentguard/audit.log`
  - `agentguard daemon start|stop|status|logs|report`
  - `agentguard daemon install|uninstall` → launchd (`com.agentguard.daemon`, KeepAlive).
- **Tray** (`src/tray-control.js`): `agentguard tray [install|uninstall]` → launchd
  (`com.agentguard.tray`, solo RunAtLoad, log en `~/.agentguard/tray.log`).

## Módulos principales (`src/`)

- `index.js` — re-exporta la API pública.
- `classifier.js` — clasifica un comando en SAFE/WARN/HIGH/CRITICAL usando `rules.js`.
- `rules.js` — reglas regex de riesgo por comando.
- `correlation-rules.js` — patrones multi-evento (p.ej. mass-delete, exfil) sobre el event bus.
- `correlator.js` — evalúa las correlation-rules contra el `event-bus.js`.
- `event-bus.js` — bus en memoria de eventos (file_write, file_delete, process_exec…).
- `filewatcher.js` — vigila `watchPaths` con chokidar y emite eventos.
- `sensitive.js` — patrones de archivos sensibles (`.env`, claves, etc.).
- `interceptor.js` — intercepción Fase 0 (escaneo de stdout/stderr línea a línea).
- `pty-interceptor.js` — intercepción Fase 1 (PTY real + shell wrapper).
- `shell-daemon.js` / `node-hook.cjs` — hooks de intercepción a nivel shell/Node.
- `decoder.js` — decodifica comandos ofuscados (base64, etc.) antes de clasificar.
- `approval.js` — UI de aprobación en terminal (readline, raw mode; fallback no-TTY = deny).
- `enforcement.js` — aplica la decisión (permitir/bloquear) sobre un incidente.
- `snapshot.js` — snapshot/restore del working tree vía `git stash -u`.
- `pending-changes.js` — registro de cambios pendientes para rollback por archivo.
- `reviewer.js` — revisión post-acción de cambios.
- `preview.js` — genera preview de un incidente (qué borraría/sobrescribiría).
- `suppression.js` — dedupe/cooldown de notificaciones repetidas.
- `notifier.js` — alertas: Telegram + notificación nativa macOS (vía osascript).
- `telegram-listener.js` — escucha respuestas de Telegram (approve/deny, keep/rollback).
- `logger.js` — audit log en JSON-lines (`~/.agentguard/audit.log`), `sessionId` por proceso.
- `report.js` / `summary.js` — resumen del audit log (`agentguard report`).
- `init.js` — wizard interactivo de `agentguard init`.
- `config.js` — carga de configuración (ver arriba).
- `daemon-control.js` / `tray-control.js` — ciclo de vida launchd del daemon y la tray.
- `dashboard/server.js` — server web (express) para ver la actividad.
