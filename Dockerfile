# Build stage for dependencies
FROM node:20-alpine AS deps

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.9.0 --activate

WORKDIR /app

# Copy package files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/

# Install dependencies
RUN pnpm install --frozen-lockfile


# Build stage for web
FROM node:20-alpine AS web-builder

RUN corepack enable && corepack prepare pnpm@9.9.0 --activate

WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules

# Copy web source code
COPY apps/web ./apps/web
COPY package.json pnpm-workspace.yaml ./

# Build web
WORKDIR /app/apps/web
RUN pnpm build


# Build stage for api
FROM node:20-alpine AS api-builder

RUN corepack enable && corepack prepare pnpm@9.9.0 --activate

WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules

# Copy api source code
COPY apps/api ./apps/api
COPY package.json pnpm-workspace.yaml ./

# Build api
WORKDIR /app/apps/api
RUN pnpm build


# Production stage
FROM node:20-alpine AS production

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# Copy built api
COPY --from=api-builder --chown=nodejs:nodejs /app/apps/api/dist ./apps/api/dist
COPY --from=api-builder --chown=nodejs:nodejs /app/apps/api/package.json ./apps/api/

# Copy built web (will be served by api)
COPY --from=web-builder --chown=nodejs:nodejs /app/apps/web/dist ./apps/web/dist

# Copy root package.json, workspace config, and lockfile
COPY --chown=nodejs:nodejs package.json pnpm-workspace.yaml pnpm-lock.yaml ./

# Install pnpm and production dependencies only
RUN corepack enable && corepack prepare pnpm@9.9.0 --activate && \
    pnpm install --filter @game-cal/api --prod --frozen-lockfile && \
    rm -rf ~/.pnpm-store

# Switch to non-root user
USER nodejs

# Environment variables
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0

# Expose port
EXPOSE 8787

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8787/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the server
CMD ["node", "apps/api/dist/index.js"]
