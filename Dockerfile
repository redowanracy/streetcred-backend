# Stage 1: Build TypeScript
FROM node:20-alpine AS builder
WORKDIR /app

# Install build dependencies
COPY package*.json ./
COPY tsconfig*.json ./
RUN npm ci

# Copy source and build
COPY src/ ./src/
COPY migrations/ ./migrations/
RUN npm run build

# Stage 2: Production Runner
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled files and migrations
COPY --from=builder /app/dist ./dist
COPY migrations/ ./migrations/
COPY docs/ ./docs/

# Create a non-root user for security
RUN addgroup -S streetcred && adduser -S streetcred -G streetcred
USER streetcred

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/v1/health || exit 1

CMD ["node", "dist/index.js"]
