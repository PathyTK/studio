# Pathy Studio (POC)

Single-page React studio for whole-slide images. Anyone can view, draw and upload; an account (email or Google)
unlocks saved annotations and the AI chat. Two deployments share one codebase:

```
LOCAL (docker-compose)                              PRODUCTION (Vercel + Cloud Run)
browser -> studio (nginx + React)                   browser -> Vercel
             |-- /api/auth|annotations|ai -> server            |-- static React app
             |-- /api/slides|open|tile|upload -> rslides       |-- /api/*  Vercel Function (api/) -> Postgres (Neon)
server -> Postgres (container)                                  `-- slides: browser calls rslides on Cloud Run directly
```

- `studio/` – Vite + React + TypeScript, OpenSeadragon + Annotorious. Locally nginx serves the build and proxies `/api` (same origin).
- `server/` – accounts, saved annotations and AI chat as ONE framework-free request handler (`src/handler.ts`, Web `Request` -> `Response`) on Postgres. `src/node-server.ts` runs it in Docker; tests use an in-process Postgres (PGlite).
- `api/[...path].ts` – the same handler as a **Vercel Function**. (`api/` at the repo root is Vercel's functions folder; the shared code lives in `server/`.)
- `repos/rslides` – changed (branch `pathy-3.0`): public slide library, anonymous uploads, path-traversal guard, Cloud Run `PORT`, slimmer Docker build. See *Slides and uploads*.
- `repos/fs-slides`, `repos/pathy-web` – reference only, unchanged. fs-slides is not needed for the POC.

## Accounts and AI (guarded behind sign-up)
Browsing, drawing, uploading and sharing stay anonymous. **Chat with the AI is only for signed-in users with a confirmed email.**

- **Sign up** with email + password (min. 10 characters) or **Continue with Google**. Email sign-ups get a confirmation link via [Resend](https://resend.com); the link signs you in. No login is possible before confirming.
- **Ask AI** (top right of the viewer) opens a chat. Each message carries a fresh screenshot of the current view and, if you selected an annotation, a close-up of it with your note and its size. Quick actions: *Identify the organ*, *Describe this view*, *Opinion on my annotation*. Answers stream from Claude. A one-time notice explains that views are sent to the AI provider, that slides must not contain patient-identifiable data, and that this is not a diagnosis.
- **Saved annotations:** anonymous users keep annotations only in the browser tab (the sidebar and a first-annotation message say so). Signed-in users also get them saved to their account (`slide_annotations` table, one document per user and slide, `GET/PUT /api/annotations`), restored on any device after sign-in. Shapes drawn before signing up are uploaded to the new account; if both sides have a slide, the newest copy wins. Signing out clears the tab's copy. Limits: 2 MB / 5,000 shapes per slide, 300 slides per user. Annotations for uploaded slides are kept even after the upload itself expires (24 h).
- **Limits:** `AI_DAILY_LIMIT` messages per user per day, plus a per-minute burst limit; signup/login/email endpoints are rate limited.
- **Security notes:** passwords are hashed with scrypt; session and email tokens are random and only their hashes are stored; the session cookie is `httpOnly` + `SameSite=Lax` (+ `Secure` on https); state-changing calls must come from `APP_URL`; signup and login answers do not reveal whether an address is registered.

### Configure (`.env`)
```
cp .env.example .env       # .env is git-ignored. Never commit real keys.
```
| Variable | What / where to get it |
|---|---|
| `APP_URL` | Public URL of the studio. Used in email links, cookie security and the origin check. |
| `RESEND_API_KEY`, `EMAIL_FROM` | [resend.com/api-keys](https://resend.com/api-keys). The default sandbox sender only delivers to your own Resend account address; verify your domain at [resend.com/domains](https://resend.com/domains) to email real users. |
| `GOOGLE_CLIENT_ID` | Google Cloud Console → Credentials → OAuth client ID (Web). Add `APP_URL` under *Authorized JavaScript origins*. ID-token flow: no client secret needed. |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | [console.anthropic.com](https://console.anthropic.com). |
| `AI_DAILY_LIMIT` | Messages per user per UTC day (default 30). |
| `NODE_ENV` | `development` (default locally): unset keys fall back to helpers: confirmation emails are **printed in the `api` log** and the AI answers with a clearly labelled **mock**. `production`: unset keys disable the feature. |

### Testing the AI with a local model (no API key)
Chat always requires an account. In dev mode (`NODE_ENV=development`, no `RESEND_API_KEY`) the confirmation email is printed in the `api` log (`docker-compose logs api`): sign up, then open that link.

To avoid needing an Anthropic key, set `LLM_BASE_URL` + `LLM_MODEL` to any OpenAI-compatible, vision-capable model (used when `ANTHROPIC_API_KEY` is empty). Bundled option, a local model in Docker:
```
docker-compose --profile llm up -d ollama
docker-compose exec ollama ollama pull qwen2.5vl:3b      # ~3 GB, once
# .env:  LLM_BASE_URL=http://ollama:11434/v1   LLM_MODEL=qwen2.5vl:3b
docker-compose up -d --build api studio
```
A 3B model on CPU is slow (about a minute per answer) and far weaker than Claude: it is for testing the plumbing (screenshots, annotation close-ups, streaming, limits), not the quality of the pathology answers. The chat panel shows the model name so it is clear this is not the production model.

Tests: `docker build --progress=plain --target test server` (22 tests, real Postgres engine in memory). Demo mode has no backend, so no sign-in or AI there.

## Private slides (fs-slides) and tokens
`fs-slides` (branch `pathy-3.0` of its repo) no longer uses Auth0. Signed-in studio users get a **15-minute HS256 token** from `POST /api/auth/slides-token` (claims `iss: pathy-studio`, `aud: fs-slides`, `sub`, `email`) and send it as `Authorization: Bearer ...`; fs-slides verifies it with the shared `SLIDES_TOKEN_SECRET` (same value on both sides, `openssl rand -base64 48`, never committed). The verified email is the user's folder `slides/<email>/`, so addresses that could escape a folder are refused at sign-up, at token issue and again in fs-slides. `/api/admin/fs` (lists every user) is limited to `ADMIN_EMAILS` (nobody by default). The studio UI does not list private slides yet.

`rslides` has no authentication of its own, so it only serves the folders in `ALLOWED_SLIDE_PREFIXES` (default `public,sessions`) and answers 403 for anything else (e.g. `slides/<email>/...`). Set it to `*` only when rslides sits behind something that authenticates.

## Deploy on Vercel (everything except the slide renderer)
Vercel hosts the React app, the API (`api/`, serverless) and, via its Storage tab, the Postgres database. Only `rslides` (Rust + OpenSlide + big files) stays elsewhere, e.g. Cloud Run.

1. **Import** `PathyTK/studio` at vercel.com/new. Keep **Root Directory** `./`; `vercel.json` sets install, build and output. (Needs the Vercel GitHub app on the `PathyTK` org.)
2. **Create the database**: project **Storage** tab -> **Create Database** -> **Neon (Postgres)** -> connect it to the project. Vercel injects `DATABASE_URL` / `POSTGRES_URL` for you. The tables are created automatically on the first request.
3. **Environment variables** (Settings -> Environment Variables; values are never committed):

| Variable | Value |
|---|---|
| `VITE_RENDERING_API` | Base URL of your rslides service, e.g. `https://rslides-xxxx.europe-west1.run.app` (build-time). Without it the build falls back to the demo. |
| `APP_URL` | Your production URL (optional on Vercel: defaults to the project's production domain). Used in email links. |
| `RESEND_API_KEY`, `EMAIL_FROM` | Confirmation emails. Verify your domain in Resend to email real users. |
| `GOOGLE_CLIENT_ID` | Add the production URL under *Authorized JavaScript origins* of that OAuth client. |
| `ANTHROPIC_API_KEY` (+ `ANTHROPIC_MODEL`, `AI_DAILY_LIMIT`) | AI chat. |

4. **rslides must be reachable from browsers**: Cloud Run service with `--allow-unauthenticated`. CORS is already open (`GET/POST/PUT`, incl. `Content-Type`; redeploy rslides from the `pathy-3.0` branch for the `Content-Type` fix). Cloud Run caps HTTP/1 request bodies at 32 MB, so very large uploads need HTTP/2 or direct-to-bucket uploads.
5. **Redeploy** after changing env vars. Preview deployments use their own URL: confirmation links point at `APP_URL`, so test sign-up on production.

Notes: functions run with `maxDuration` 60 s (AI answers stream). Rate limits live in Postgres, so they hold across function instances. Use the **pooled** connection string. `VITE_DEMO=true` forces the backend-free demo.

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
  `docker build --build-arg VITE_DEMO=true -t pathy-studio-demo studio && docker run -e RSLIDES_URL=http://127.0.0.1:9 -p 3000:8080 pathy-studio-demo` (API_URL defaults to a dead address, which is fine in demo mode).

## Known limits
- rslides keeps opened slides in memory and has no rate limiting yet; fine for a POC, not for open internet.
- Pan/Rectangle/Polygon annotations only; no AI, reports, or patient data.
