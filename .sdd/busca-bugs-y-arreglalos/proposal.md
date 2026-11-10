# Propuesta — busca bugs y arreglalos

## Intención

El pedido es "busca bugs y arreglalos". La búsqueda ya se hizo en la fase de exploración: la línea de base está verde (782 tests, typecheck limpio), no hay TODOs/FIXMEs y el repo ya tiene una auditoría previa (`docs/AUDITORIA-2026-11-08.md`) con 22 bugs catalogados (B1–B22). Verifiqué contra `main` @ `ac13a61` y quedan **20 bugs abiertos**; B7 y B18 ya fueron corregidos y **no se tocan**.

El plan convierte esa auditoría verificada en un ciclo de arreglos: primero lo de mayor impacto visible y protocolo, después la resiliencia HTTP, el ciclo de vida de auth, la semántica de leído, la voz, y al final la limpieza chica.

## Alcance

Se corrigen los 20 bugs abiertos, agrupados por archivo y por responsabilidad:

- **Protocolo (B22, B3):** leer `read_state`, `user_guild_settings` y `channel_overrides` en formato versionado `{entries, partial, version}` y mezclar `merged_members`.
- **HTTP (B5, B2, B15):** timeout de 30 s, header `x-ratelimit-global`, y liberar colas terminadas.
- **Auth (B1):** registrar `onUnauthorized` también en el arranque con sesión guardada.
- **Ciclo de vida (B10, B12):** flush de settings al salir y guarda frente a `notify-send` que lanza.
- **Leído (B8, B21, B6):** automatizaciones de read-state, ack token + `last_viewed`, y no pedir historial al moverse entre servidores.
- **Voz (B4):** seguir a Discord cuando un moderador te mueve de canal.
- **Limpieza (B9, B11, B13, B14, B16, B17, B19, B20):** rotación de log + gate de dispatch, volumen 0 persistente, sacar `ready.shape`, no re-subir adjuntos en retry, throttle sin socket viejo, Content-Length antes de `arrayBuffer()`, título de grupos y teclas vim.

## Fuera de alcance

- B7 y B18 (ya corregidos en `main`).
- Verificación contra la cuenta real: es 🧍 Paso de Gon. Se deja flaggeado puntualmente en B21 (ack token) y en B22 (forma real del READY versionado).
- No se tocan dependencias ni versiones.

## Racional

La auditoría ya priorizó por impacto: B22 es el síntoma "todos los canales con puntito" y además rompe los mutes; B5 cuelga colas REST; B1 mata REST en silencio; B2 ignora el rate-limit global; B4 desconecta la UI de la llamada real. Agrupar por archivo minimiza rebases y mantiene cada tarea verificable con un comando de test acotado.
