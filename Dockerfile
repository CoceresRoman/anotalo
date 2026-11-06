# Opción liviana para probar el bot rápido / desarrollo local.
# Para una instancia real de producción, la guía recomendada sigue siendo
# deploy/README.md (VM + pm2 + Caddy) — ver ese doc.
#
# Multi-stage: deps (instala todo) -> build (genera el cliente Prisma y
# compila Next.js) -> runtime (solo lo necesario para `npm start`).

# ---- deps ----
FROM node:20-alpine AS deps
WORKDIR /app

# bcrypt (dependencia directa) compila un addon nativo en el install; la
# musl libc de alpine no tiene un binario prebuilt para eso, así que
# node-gyp necesita un toolchain real para compilarlo desde fuente.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci

# ---- build ----
FROM node:20-alpine AS build
WORKDIR /app

# El binario del query engine de Prisma está linkeado dinámicamente contra
# OpenSSL; alpine no lo trae instalado por default (si falta, `prisma
# generate`/el arranque de la app fallan con un error de libssl).
RUN apk add --no-cache openssl

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Mismo fix que ya usa el CI (.github/workflows/ci-cd.yml) y el deploy a la
# VM (deploy/README.md) para el "JavaScript heap out of memory" de
# `next build` a medida que crece el codebase.
ENV NODE_OPTIONS="--max-old-space-size=4096"

RUN npx prisma generate
RUN npm run build

# Ya no hace falta nada de devDependencies (typescript, tailwind, postcss,
# vitest, ...) para correr `next start` — las sacamos para que el stage de
# runtime no las cargue.
RUN npm prune --omit=dev

# ---- runtime ----
FROM node:20-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache openssl

ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.mjs ./next.config.mjs
COPY --from=build /app/prisma ./prisma

# Holds the sqlite data file (docker-compose.yml's app_data volume mounts
# here, with DATABASE_URL=file:/app/data/prod.db) — deliberately separate
# from /app/prisma (schema + migrations), which must always come from THIS
# image, never from a stale volume. Created up front so the directory
# exists even running the image without the named volume mounted.
RUN mkdir -p /app/data

EXPOSE 3000

# `prisma migrate deploy` aplica las migraciones pendientes contra la base
# sqlite (fresca o persistida en el volumen) antes de cada arranque — el
# equivalente, en este setup sin humano en el medio, del paso manual que
# deploy/README.md documenta para la VM.
CMD ["sh", "-c", "npx prisma migrate deploy && npm start"]
