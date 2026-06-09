# CatSense Live

RWD realtime web prototype for common house-cat vocal intent classification.

This is not a cat-language translator. It uses live audio plus owner-provided context to infer likely intent, confidence, checks, and safety warnings.

## Run

```powershell
cd work\catsense-live
Copy-Item .env.example .env
# edit .env and set OPENAI_API_KEY locally; .env is ignored by git
node server.mjs
```

Open `http://localhost:4173`.

## Deploy to Cloudflare Workers

Install Wrangler and log in:

```powershell
npm install
npx wrangler login
```

Set the OpenAI key as a Cloudflare secret. Do not put the key in `wrangler.jsonc`, `public/`, or GitHub:

```powershell
npx wrangler secret put OPENAI_API_KEY
```

Deploy:

```powershell
npx wrangler deploy
```

After deploy, Wrangler prints a public `https://...workers.dev` URL. Use that URL for production browser access.

## Architecture

- Browser captures microphone audio and creates a WebRTC offer.
- Local Node server receives the SDP offer at `/api/realtime/session`.
- Server calls OpenAI `POST /v1/realtime/calls` with `OPENAI_API_KEY` and the realtime session config.
- Browser receives the SDP answer and opens the `oai-events` data channel.
- The UI requests text-only analysis every 6 seconds and renders the first JSON object it receives.

The Cloudflare deployment uses the same browser flow, but `/api/realtime/session` is handled by `src/worker.js` instead of the local Node server.

## Safety

- `OPENAI_API_KEY` is never sent to the browser.
- Keep `OPENAI_API_KEY` in server-side environment variables or ignored `.env` files only.
- Results are probabilistic and should not replace a veterinarian.
- `vet_warning=true` is raised for risky vocal patterns or distress context.
