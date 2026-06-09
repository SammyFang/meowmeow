# CatSense Live

RWD web prototype for common house-cat sound and visual behavior checks.

This is not a cat-language translator. It uses live audio, an optional image, and owner-provided context to infer likely intent, posture/action, cat-cat relationship, confidence, checks, and safety warnings.

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
- Local Node server or Cloudflare Worker mints a short-lived Realtime client secret at `/api/realtime/token`.
- Browser uses that short-lived secret to call OpenAI `POST /v1/realtime/calls` with its SDP offer.
- Browser receives the SDP answer and opens the `oai-events` data channel.
- The UI requests text-only analysis every 6 seconds and renders the first JSON object it receives.
- Browser can upload or capture one image and sends a resized data URL to `/api/vision/analyze`.
- The server-side endpoint calls OpenAI Responses with `OPENAI_VISION_MODEL` and a strict JSON schema for posture, action, relationship, confidence, checks, and safety flags.

The main `OPENAI_API_KEY` never reaches the browser.

## Safety

- `OPENAI_API_KEY` is never sent to the browser.
- Keep `OPENAI_API_KEY` in server-side environment variables or ignored `.env` files only.
- Results are probabilistic and should not replace a veterinarian.
- `vet_warning=true` is raised for risky vocal patterns or distress context.
- `safety_warning=true` is raised for risky visual signs such as visible injury, severe fear, active fighting, or high-risk uncertainty.
