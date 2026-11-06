# notas-whatsapp

Bot personal de WhatsApp para capturar notas, gastos, ingresos, recordatorios
(sincronizados con Google Calendar) y seguimiento de cuotas/suscripciones,
con un pequeño dashboard web para consultar y gestionar todo eso.

Está pensado como **una instancia por persona**, no como un servicio
multi-usuario: cada quien clona este repo y corre su propio bot contra su
propio número de WhatsApp. No hay onboarding de "usuarios" ni multi-tenant;
es software personal que corre en tu propia VM o máquina.

## ⚠️ Aviso de riesgo

Este bot usa [Baileys](https://github.com/WhiskeySockets/Baileys), un
cliente **no oficial** del protocolo de WhatsApp Web (no usa la API oficial
de WhatsApp Business). Eso significa que no está soportado ni aprobado por
WhatsApp/Meta, y conectar un número conlleva riesgo de que esa cuenta sea
bloqueada ("banneada").

**Recomendación: usá un número de WhatsApp secundario, no tu número
principal.** No hay garantía de que el número usado para esto siga
funcionando a largo plazo.

## Instalación y deploy

La guía completa de instalación/deploy (VM, dependencias, variables de
entorno, pairing con WhatsApp, backups, CI/CD) está en
[`deploy/README.md`](deploy/README.md). Esa es la referencia; este README
no la duplica.

Como punto de partida rápido, ver también [`.env.example`](.env.example)
para las variables de entorno que necesita la app. Corré
`npx tsx scripts/setup.ts` para armar tu `.env` interactivamente: te pide
usuario y contraseña de la webapp y genera el `WEBAPP_USERNAME`,
`WEBAPP_PASSWORD_HASH` y `SESSION_SECRET` por vos (el resto de las
variables, como `GROQ_API_KEY`, se completan a mano según `.env.example`).

Google Calendar (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REDIRECT_URI`)
es **opcional**: si no se configura, los recordatorios funcionan igual, solo
que quedan confirmados directamente en vez de sincronizarse con un evento de
Calendar. La moneda, timezone, offset UTC e idioma del prompt de
clasificación de WhatsApp también son configurables por variables de entorno
(`DEFAULT_CURRENCY`, `APP_TIMEZONE`, `APP_UTC_OFFSET`, `BOT_LOCALE`) — ver
[`.env.example`](.env.example) para sus valores por defecto. `BOT_LOCALE`
solo traduce ese prompt; el resto de las respuestas del bot (confirmaciones,
respuestas a consultas, avisos de recordatorios) sigue siempre en español.
Las 6 categorías fijas de gastos (Comida/Transporte/Servicios/Salud/Ocio/Otros)
también quedan siempre en español, independientemente de `BOT_LOCALE`.

## Probar rápido con Docker

Para probar el bot rápido o para desarrollo local hay una alternativa
liviana con Docker Compose. **No reemplaza** a [`deploy/README.md`](deploy/README.md):
ese sigue siendo el camino recomendado para una instancia real de
producción (VM propia, backups, pairing estable de WhatsApp a largo plazo).

```bash
cp .env.example .env
# completar .env con tus valores (ver .env.example)

docker compose up --build
```

El primer arranque va a loguear el QR de WhatsApp en la salida de
`docker compose logs -f app` — escanealo desde el WhatsApp que vayas a usar
para el bot. La base sqlite (`prisma/`) y la sesión de WhatsApp
(`.wa-auth/`) quedan en volúmenes nombrados, así que sobreviven a
`docker compose down` / `up` (pero no a `docker compose down -v`, que los
borra).

Para parar: `docker compose down`.

## Licencia

MIT. Ver [`LICENSE`](LICENSE).
