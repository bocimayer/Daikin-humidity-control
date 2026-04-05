# ── Build stage ────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (layer-cached until package.json changes).
COPY package*.json ./
RUN npm ci

# Compile TypeScript.
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

# ── Runtime stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

# Create a non-root user/group.
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Install production dependencies only.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output from the build stage.
COPY --from=builder /app/dist ./dist

# Cloud Run injects PORT automatically; 8080 is the default.
ENV PORT=8080
EXPOSE 8080

USER appuser

CMD ["node", "dist/server.js"]
