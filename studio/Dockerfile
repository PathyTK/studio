# docker build -t pathy-studio .
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG VITE_CONTACT_EMAIL
ENV VITE_CONTACT_EMAIL=$VITE_CONTACT_EMAIL
ARG VITE_DEMO=false
ENV VITE_DEMO=$VITE_DEMO
RUN npm run build

FROM nginx:1.27-alpine
# nginx's entrypoint runs envsubst on /etc/nginx/templates/*.template at start.
# API_URL: where the pathy-api service lives (e.g. https://pathy-api-xxxx.run.app).
# RSLIDES_URL: where rslides lives (e.g. https://rslides-xxxx.run.app). PORT: injected by Cloud Run.
# API_URL points at the accounts/AI service; the default is a dead address so demo-only containers still start.
ENV PORT=8080 RSLIDES_URL=http://rslides:8080 FS_SLIDES_URL=http://fs-slides:2500 API_URL=http://127.0.0.1:9
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY 15-rslides-host.envsh /docker-entrypoint.d/15-rslides-host.envsh
RUN chmod +x /docker-entrypoint.d/15-rslides-host.envsh
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
