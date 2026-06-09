# Security

## API key handling

Do not put `OPENAI_API_KEY` in browser code, HTML, CSS, committed files, query strings, or client-side storage.

Use one of these safe options:

- Local development: create `.env` or `.env.local` in this folder. Both are ignored by git.
- Production on Cloudflare Workers: set `OPENAI_API_KEY` with `wrangler secret put OPENAI_API_KEY`.
- CI/CD: use GitHub Actions secrets or the hosting platform secret store.

The browser only talks to this app's Node server. The Node server calls OpenAI with `OPENAI_API_KEY` and returns only the SDP answer needed for the WebRTC session.

For the deployed Cloudflare Worker, the browser talks to the Worker. The Worker calls OpenAI with the Cloudflare secret and returns only the SDP answer needed for the WebRTC session.

## Before pushing

Run a quick secret scan with your preferred scanner before pushing. At minimum, inspect changed files for:

- `OPENAI_API_KEY` assigned to a real value
- any OpenAI key copied into `public/`
- any key copied into README, screenshots, logs, or browser code

If any real key appears, remove it and rotate the key before pushing.
