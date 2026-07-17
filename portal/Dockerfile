FROM node:22.16.0-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ARG VITE_TRACE_API_BASE_URL=https://api.tracestack.gg
ENV VITE_TRACE_API_BASE_URL=$VITE_TRACE_API_BASE_URL

RUN npm run build

FROM caddy:2.10-alpine

WORKDIR /app

COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist ./dist

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
