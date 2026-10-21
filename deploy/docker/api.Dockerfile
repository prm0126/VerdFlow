# API and worker image (same build; the command picks the process).
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @vf/shared build && pnpm --filter @vf/api build
RUN pnpm --filter @vf/api deploy --prod --legacy /out

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out /app
USER node
EXPOSE 4000
# Override with ["node", "dist/worker.js"] for the worker, or dist/cli/migrate.js for migrations.
CMD ["node", "dist/main.js"]
