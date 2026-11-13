# Pathy Studio (POC)

Single-page React studio for whole-slide images. No accounts; annotations live in `sessionStorage`
(the **Share** button copies a link that carries the annotations). Everything runs in containers.

```
browser ──► studio (nginx + React, :3000) ──/api──► rslides (Rust, OpenSlide, :8080) ──► /slides
```

- `studio/` – Vite + React + TypeScript, OpenSeadragon + Annotorious. nginx serves the build and proxies `/api` to rslides (same origin: no CORS).
- `repos/rslides` – changed (branch `pathy-3.0`): public slide library, anonymous uploads, path-traversal guard, Cloud Run `PORT`, slimmer Docker build. See *Slides and uploads*.
- `repos/fs-slides`, `repos/pathy-web` – reference only, unchanged. fs-slides is not needed for the POC.

## Sharing a session
**Share** copies a link containing the whole session (annotations of every slide + the slide being viewed), gzip-compressed into the URL fragment. Opening it in another browser loads those annotations (replacing that browser's annotations for the same slides) and opens the slide. No server stores anything and the `#fragment` is never sent over the network. Works in demo mode too. Limits: very large sessions make long links (the app warns above ~8,000 characters, when chat apps may truncate); links to *uploaded* slides stop working when the upload expires (24 h).

## Drawing
Pan / Rectangle / Polygon live in the viewer toolbar (shortcuts V / R / P). Polygon: drag the first edge, click to add points, double-click to finish. Shapes are saved the moment they are drawn.

## Slides and uploads
- **Public slides** (visible to every visitor): files in `SLIDE_DIR/public` (`./slides/public` locally; a demo slide is baked into the image).
- **Uploads**: the big "Upload your slide" box (drag & drop). The browser makes a random session id; the file goes to `SLIDE_DIR/sessions/<id>/` via `PUT /api/upload/:session/:filename` and is listed under "Your uploads" for that session only. rslides checks the extension, the size (`MAX_UPLOAD_BYTES`, default 2 GB, matched by `VITE_MAX_UPLOAD_MB` in the UI), max 10 slides per session, and that OpenSlide can actually read the file. Folders older than `SESSION_TTL_HOURS` (default 24) are deleted hourly.
- API: `GET /api/slides?session=<id>` (public + own), `PUT /api/upload/:session/:filename`, `GET /api/open/*path`, `GET /api/tile/serve/...`.
- Anyone who knows a session id can open that session's uploads (no accounts); the id is random and never listed.
- **Cloud Run limit:** HTTP/1 requests are capped at 32 MB, so large uploads need HTTP/2 end to end, or (better, not built) direct signed uploads to a GCS bucket. Also add rate limiting before exposing this publicly.

## Run locally
```
docker compose up --build        # http://localhost:3000
```
Extra slides: drop files into `./slides` (mounted read-only into rslides).
Frontend dev without Docker: `cd studio && npm i && RSLIDES_URL=http://localhost:8080 npm run dev`.

## Google Cloud Run
```
# rslides (mount a GCS bucket at /slides via Cloud Run volume mounts to serve your own slides)
gcloud run deploy rslides --source repos/rslides --memory 2Gi --cpu 2 --port 8080 --no-allow-unauthenticated

# studio: only needs the rslides URL
gcloud run deploy pathy-studio --source studio --port 8080 \
  --set-env-vars RSLIDES_URL=https://<rslides-url> --allow-unauthenticated
```
If rslides is private, give the studio's service account `roles/run.invoker` and add an identity-token
header in nginx (not done in this POC; simplest is to make rslides public or put both behind IAP).
Contact link: `mailto:` to aws@pathy.ai and oussama@pathy.ai by default; override with build arg `VITE_CONTACT_EMAIL` (comma-separated).

## Demo mode (no backend)
Strictly static: lists two bundled sample DZI images (public OpenSeadragon examples, not pathology) and never calls `/api`.
- Any build: open the app with `?demo=1`.
- Demo-only deployment (e.g. Vercel or a container): `VITE_DEMO=true npm run build`, or
  `docker build --build-arg VITE_DEMO=true -t pathy-studio-demo studio && docker run -e RSLIDES_URL=http://127.0.0.1:9 -p 3000:8080 pathy-studio-demo`.

## Known limits
- rslides keeps opened slides in memory and has no rate limiting yet; fine for a POC, not for open internet.
- Pan/Rectangle/Polygon annotations only; no AI, reports, or patient data.
