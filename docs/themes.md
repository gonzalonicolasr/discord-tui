# Temas

zcord trae seis temas: **oscuro** (Catppuccin Mocha, el de siempre), **claro** (Catppuccin Latte), **Gruvbox**,
**Tokyo Night**, **Nord** y **Dracula**. Se elige en settings (`gs`) → *Apariencia* → *tema*: Enter o `l` pasa al
siguiente y `h` vuelve al anterior. Se guarda solo.

## Agregar un tema propio

1. Creá la carpeta `~/.config/zcord/themes/` (o `$XDG_CONFIG_HOME/zcord/themes/`).
2. Poné un archivo `<nombre>.json`. El nombre del archivo es el del tema: minúsculas, números y guiones
   (`mi-tema.json` → `mi-tema`).
3. Abrí zcord (o `bin/zcord demo` para probarlo sin loguearte) y elegilo en settings.

Si un archivo tiene un error, zcord lo saltea y muestra un aviso con el archivo y el problema
(por ejemplo `tema mi-tema.json: "colors.accent" tiene que ser un color #rrggbb`). Los demás temas cargan igual.

Para empezar, copiá [`docs/themes/kanagawa.json`](themes/kanagawa.json):

```sh
mkdir -p ~/.config/zcord/themes
cp docs/themes/kanagawa.json ~/.config/zcord/themes/
```

## Formato

```json
{
  "label": "Mi tema",
  "extends": "nord",
  "palette": { "bg": "#1f1f28", "...": "..." },
  "colors": { "accent": "#ff79c6" }
}
```

Todo es opcional, pero tiene que haber `palette` o `colors`:

- **`palette`**: los colores base, y zcord arma con ellos todos los demás. Son obligatorios `bg`, `panel`,
  `selection`, `faint`, `dim`, `fg`, `accent`, `red`, `orange`, `yellow`, `green`, `cyan` y `purple`; `pink` y
  `codeBg` son opcionales.
- **`extends`**: si no hay `palette`, el tema parte de otro (uno incluido o uno tuyo que venga antes en orden
  alfabético) y solo cambia lo que pongas en `colors`. Sin `extends`, parte del oscuro.
- **`colors`**: pisa colores sueltos, al final. Todos son `#rrggbb`:

| campo | dónde se ve |
| --- | --- |
| `bg`, `fg` | fondo y texto |
| `dim`, `faint` | texto secundario, cosas apagadas |
| `accent` | botones, selección activa, links internos |
| `border`, `borderFocus` | bordes de los paneles; el del panel con foco |
| `panel`, `selection`, `selectionFg` | barras, fila seleccionada |
| `header` | títulos de sección |
| `unread`, `mention`, `mentionBg`, `mentionFg` | canales no leídos y menciones |
| `error`, `warn`, `ok` | avisos |
| `codeBg`, `codeFg`, `quote`, `link` | markdown |
| `online`, `idle`, `dnd`, `offline` | estado de la gente |
| `speaking` | quién habla en la llamada |
| `modeNormal`, `modeInsert`, `modeFg` | el cartel NORMAL / INSERT |
| `names` | lista de colores para nombres de usuarios sin rol |
| `brand` | degradé del logo del splash |

`names` y `brand` son listas: `"names": ["#e46876", "#98bb6c", "#7e9cd8"]`.
