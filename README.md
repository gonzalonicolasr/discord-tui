# zcord

**Discord en tu terminal.** Texto, voz con cifrado de punta a punta, pantalla compartida y transmisiones, todo sin
salir de la terminal. Se usa con el mouse como Discord o con el teclado estilo vim.

🌐 **https://zcord.gonzalorocca.com**

![zcord en acción: escribir con una mención, saltar con Ctrl-k y entrar a una llamada](docs/img/zcord.gif)

## Features

- **Chat completo:** servidores, canales, DMs y grupos, hilos y foros. Incluye markdown, bloques de código,
  respuestas, edición, borrado, reacciones, menciones con `@`, emojis personalizados, stickers, encuestas,
  embeds y la línea de "mensajes nuevos".
- **Imágenes en la terminal:** avatares, GIFs animados y emojis con el protocolo gráfico de Kitty.
- **Adjuntos:** pegá con `Ctrl-v` una captura o archivos copiados en el gestor de archivos, o adjuntá un archivo
  por ruta.
- **Voz:** entrás con un click y ves quién habla. Tiene E2EE (DAVE) con código de privacidad, VAD o push-to-talk,
  mute, ensordecer, volumen por persona, salida de audio a elección y sonidos de eventos.
- **Chat de los canales de voz,** sin tener que entrar a la llamada.
- **Pantalla compartida (Go Live):** elegís qué monitor transmitir.
- **Ver la transmisión de otros** dentro de la terminal.
- **Temas:** seis incluidos (Catppuccin oscuro y claro, Gruvbox, Tokyo Night, Nord, Dracula) y los tuyos en
  `~/.config/zcord/themes/` con un JSON chico. Ver [docs/themes.md](docs/themes.md).
- **Todo clickeable** (sin ids que tipear), con `Ctrl-k` para saltar a cualquier canal, tu estado
  (en línea / ausente / no molestar) y listas de miembros grandes.

## Consumo

zcord usa **unas 3,7 veces menos memoria** que la app oficial de Discord, aun estando en una llamada.

| | memoria (PSS) | procesos |
| --- | --- | --- |
| **zcord 0.2.0**, en una llamada de voz | **217 MB** | 1 (+2 de audio: `pw-record`, `pw-cat`) |
| Discord 1.0.162 (con Vencord), sin llamada | 814 MB | 9 |

- **Cómo se midió:** el 8/11/2026, en Arch Linux con un Ryzen 9 5900X. Los dos estaban abiertos al mismo tiempo y se
  midieron durante 60 s, sumando el PSS (memoria real, con las páginas compartidas repartidas) de todos sus procesos.
- **La comparación juega en contra de zcord:** estaba en una llamada y todavía no usaba la versión compilada.
- **Versión compilada** (`bin/zcord` corre `dist/`, armado con `bun build` sin Babel en ejecución): en la demo baja
  de 86–110 MB a **55 MB**, y en reposo usa ~0,2 % de un núcleo.
- **CPU:** en una llamada zcord usa ~4 % de un núcleo; es el audio (mezcla, Opus y PipeWire, 50 cuadros por segundo).
  Falta medir Discord en una llamada para comparar.
- **Para medir vos:** `scripts/measure.sh build` (la demo) y el log `app.mem`, que escribe la app real cada 60 s
  en `~/.local/state/discord-tui/discord-tui.log`.

| Voz y transmisiones | Saltar a cualquier lado (`Ctrl-k`) |
| --- | --- |
| ![barra de voz con E2EE, quién habla y botones](docs/img/voz.png) | ![buscador de canales](docs/img/saltar.png) |

| Chat | Splash |
| --- | --- |
| ![chat con canales, hilos, reacciones y lista de miembros](docs/img/chat.png) | ![splash de zcord](docs/img/splash.png) |

## Cómo correrlo

Requisitos:
- Linux con PipeWire y Wayland.
- [Bun](https://bun.sh) ≥ 1.3.14.
- Una terminal con protocolo Kitty: Ghostty o Kitty.
- Opcionales: `wl-clipboard` (pegar), `wf-recorder` o `ffmpeg` (pantalla compartida).

```sh
bun install
bin/zcord          # la app compilada; se recompila sola si cambió el código (login con QR la primera vez)
bin/zcord demo     # la UI con datos falsos, sin conectarse a Discord
```

Para tenerlo en el PATH: `ln -s ~/projects/discord-tui/bin/zcord ~/.local/bin/zcord`. Dentro de la app, `?` muestra
todas las teclas.

> ⚠️ zcord entra con tu cuenta personal (no es un bot). Eso va contra los Términos de Discord y la cuenta puede
> terminar suspendida. Usalo sabiendo ese riesgo.

## Desarrollo

```sh
bun test                       # tests (UI con testRender, sin red)
bun run typecheck
ZCORD_DEV=1 bin/zcord          # correr desde src/ sin compilar
bun scripts/build.ts           # compilar a dist/ a mano
scripts/measure.sh build       # memoria y CPU de la demo (también: dev)
bun scripts/screenshots.tsx    # regenera las capturas de este README desde la demo
bun scripts/readme-gif.tsx     # regenera docs/img/zcord.gif (necesita ffmpeg)
bun scripts/og-image.ts        # imagen para compartir la landing
scripts/deploy-site.sh         # publica site/ en zcord.gonzalorocca.com (cerostation)
```

La landing vive en `site/index.html`: es estática y usa las imágenes de `docs/img`.

- Las notas del protocolo están en `docs/protocol-notes.md`.
- La checklist de pruebas con la cuenta real está en `docs/PRUEBAS-GON.md`.
- Las reglas del repo (token, fixtures redactados) están en `AGENTS.md`.
