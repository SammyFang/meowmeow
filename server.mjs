import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 4173);

loadLocalEnv();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, {
        ok: true,
        hasApiKey: Boolean(process.env.OPENAI_API_KEY),
        model: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2"
      });
    }

    if (req.method === "POST" && url.pathname === "/api/realtime/session") {
      return await createRealtimeCall(req, res);
    }

    if (req.method !== "GET") {
      return sendJson(res, { error: "Method not allowed" }, 405);
    }

    const safePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = path.normalize(path.join(publicDir, safePath));
    if (!filePath.startsWith(publicDir)) {
      return sendJson(res, { error: "Invalid path" }, 400);
    }

    const ext = path.extname(filePath);
    const body = await readFile(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    res.end(body);
  } catch (error) {
    if (error.code === "ENOENT") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    console.error(error);
    sendJson(res, { error: "Server error", detail: error.message }, 500);
  }
});

server.listen(port, () => {
  console.log(`CatSense Live running at http://localhost:${port}`);
  if (!process.env.OPENAI_API_KEY) {
    console.log("OPENAI_API_KEY is not set. Realtime connection will stay disabled until configured.");
  }
});

async function createRealtimeCall(req, res) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return sendJson(
      res,
      {
        error: "OPENAI_API_KEY is missing",
        detail: "Set OPENAI_API_KEY in the environment or in work/catsense-live/.env, then restart the server."
      },
      503
    );
  }

  const sdp = await readBody(req);
  if (!sdp.includes("v=0")) {
    return sendJson(res, { error: "Expected SDP offer body" }, 400);
  }

  const context = collectRequestContext(req.headers);
  const sessionConfig = JSON.stringify({
    type: "realtime",
    model: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2",
    instructions: buildInstructions(context),
    audio: {
      output: {
        voice: "marin"
      }
    }
  });

  const formData = new FormData();
  formData.set("sdp", sdp);
  formData.set("session", sessionConfig);

  const response = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Safety-Identifier": context.safetyId
    },
    body: formData
  });

  const text = await response.text();
  if (!response.ok) {
    res.writeHead(response.status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        error: "OpenAI Realtime call failed",
        status: response.status,
        detail: text
      })
    );
    return;
  }

  res.writeHead(200, { "Content-Type": "application/sdp; charset=utf-8" });
  res.end(text);
}

function buildInstructions(context) {
  return [
    "You are CatSense Live, a cautious acoustic classifier for common domestic cat vocalizations.",
    "Do not claim to translate cat language. Classify the likely intent from acoustic evidence first, then use owner context only as a weak prior.",
    "Listen for call type, duration, repetition, pitch contour, intensity, roughness, hiss/growl noise, purr vibration, trill/chirp onset, and stress/yowl characteristics.",
    "Return JSON only. Do not output markdown, prose outside JSON, or invented certainty.",
    "Use this exact schema: {\"sound_type\":\"short_meow|long_meow|repeated_meow|trill|purr|hiss|growl|yowl|chirp|mixed|unknown\",\"likely_intent\":\"hungry|greeting|wants_attention|wants_out|stress|pain_warning|territorial|play|contentment|unknown\",\"confidence\":0.0,\"acoustic_evidence\":\"short evidence phrase\",\"what_to_check\":[\"string\"],\"suggested_response\":\"string\",\"vet_warning\":false,\"notes\":\"string\"}.",
    "Confidence must be calibrated: use 0.20 or lower for unclear audio, silence, mostly human speech, background noise, or weak evidence; use 0.60+ only when the acoustic pattern and context agree.",
    "Return unknown when evidence is insufficient, even if the context suggests a likely answer.",
    "Set vet_warning true for repeated yowling, suspected pain, respiratory distress, sudden behavior change, growling/hissing with distress, injury cues, or any risky low-confidence pattern.",
    `Session context from browser headers: ${JSON.stringify(context.visibleContext)}`
  ].join("\n");
}

function collectRequestContext(headers) {
  const raw = headers["x-catsense-context"];
  let visibleContext = {};
  if (raw && typeof raw === "string") {
    try {
      visibleContext = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    } catch {
      visibleContext = {};
    }
  }
  return {
    visibleContext,
    safetyId: stableSafetyId(headers["user-agent"] || "unknown")
  };
}

function stableSafetyId(input) {
  let hash = 2166136261;
  for (const ch of String(input)) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `catsense-${(hash >>> 0).toString(16)}`;
}

function loadLocalEnv() {
  for (const fileName of [".env.local", ".env"]) {
    const envPath = path.join(__dirname, fileName);
    if (!existsSync(envPath)) continue;
    const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (key && !process.env[key]) process.env[key] = value;
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}
