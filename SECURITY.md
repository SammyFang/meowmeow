# Security

## API key handling

Do not put `OPENAI_API_KEY` in browser code, HTML, CSS, committed files, query strings, or client-side storage.

Use one of these safe options:

- Local development: create `.env` or `.env.local` in this folder. Both are ignored by git.
- Production: set `OPENAI_API_KEY` as a server-side secret in the hosting provider.
- CI/CD: use GitHub Actions secrets or the hosting platform secret store.

The browser only talks to this app's Node server. The Node server calls OpenAI with `OPENAI_API_KEY` and returns only the SDP answer needed for the WebRTC session.

## Before pushing

Run a quick secret scan with your preferred scanner before pushing. At minimum, inspect changed files for:

- `OPENAI_API_KEY` assigned to a real value
- any OpenAI key copied into `public/`
- any key copied into README, screenshots, logs, or browser code

If any real key appears, remove it and rotate the key before pushing.
