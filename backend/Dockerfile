# ── Stage 1: dependencies ────────────────────────────────────────────────────
FROM node:20-slim AS deps
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --ignore-scripts

# ── Stage 2: runtime image ───────────────────────────────────────────────────
FROM node:20-slim AS runner
WORKDIR /app

ENV NODE_ENV=production

# Copy production node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source (axl-cli is a local dev tool — excluded via .dockerignore)
COPY . .

# Cloud Run injects PORT; default to 3001 for local docker run
EXPOSE 3001

CMD ["node", "server.js"]
