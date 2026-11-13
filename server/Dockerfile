# docker build -t pathy-server .                       # runtime image (local / any container host)
# docker build --target test -t pathy-server-test .    # run the test suite (in-process Postgres, no server needed)
# On Vercel this image is not used: the same handler runs as a serverless function (see ../api).
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npx tsc

FROM build AS test
RUN node --test "dist/test/*.test.js"

FROM node:22-alpine AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/src/node-server.js"]
