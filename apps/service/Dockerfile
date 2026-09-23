FROM node:24.18.0-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && corepack prepare pnpm@11.12.0 --activate

WORKDIR /source

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json turbo.json ./
COPY apps/service/package.json apps/service/tsconfig.json apps/service/
COPY packages/contracts/package.json packages/contracts/tsconfig.json packages/contracts/
COPY packages/testkit/package.json packages/testkit/

RUN pnpm install --frozen-lockfile --filter @kiwi/service...

COPY apps/service/src apps/service/src
COPY apps/service/migrations apps/service/migrations
COPY packages/contracts/src packages/contracts/src
COPY packages/contracts/schemas packages/contracts/schemas

RUN pnpm --filter @kiwi/contracts build && pnpm --filter @kiwi/service build
RUN pnpm --filter @kiwi/service --prod deploy --legacy /output

FROM node:24.18.0-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV KIWI_SERVICE_ENV=production
ENV KIWI_SERVICE_HOST=0.0.0.0
ENV KIWI_SERVICE_PORT=4319

WORKDIR /app
COPY --from=build --chown=node:node /output/ ./

USER node
EXPOSE 4319

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 CMD ["node", "-e", "const http=require('node:http');const origin=new URL(process.env.KIWI_PUBLIC_ORIGIN);const request=http.get({hostname:'127.0.0.1',port:process.env.KIWI_SERVICE_PORT||'4319',path:'/v1/health/ready',headers:{host:origin.host}},response=>process.exit(response.statusCode===200?0:1));request.setTimeout(2000,()=>{request.destroy();process.exit(1)});request.on('error',()=>process.exit(1));"]

CMD ["node", "dist/index.js"]
