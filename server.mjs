import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 4173);
const DEFAULT_REALTIME_MODEL = "gpt-realtime-2";
const DEFAULT_VISION_MODEL = "gpt-5.5";
const MAX_IMAGE_DATA_URL_LENGTH = 4_500_000;

const VISION_SCHEMA = {
  type: "object",
  properties: {
    primary_state: { type: "string" },
    action: { type: "string" },
    posture: { type: "string" },
    relationship: {
      type: "string",
      enum: ["single_cat", "affiliative", "play", "neutral", "tense", "conflict", "avoidance", "resource_competition", "unknown"]
    },
    cat_count: { type: "integer" },
    stress_level: {
      type: "string",
      enum: ["none", "low", "moderate", "high", "unknown"]
    },
    confidence: { type: "number" },
    visible_evidence: { type: "string" },
    what_to_check: {
      type: "array",
      items: { type: "string" }
    },
    suggested_response: { type: "string" },
    safety_warning: { type: "boolean" },
    limitations: { type: "string" }
  },
  required: [
    "primary_state",
    "action",
    "posture",
    "relationship",
    "cat_count",
    "stress_level",
    "confidence",
    "visible_evidence",
    "what_to_check",
    "suggested_response",
    "safety_warning",
    "limitations"
  ],
  additionalProperties: false
};

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
        model: process.env.OPENAI_REALTIME_MODEL || DEFAULT_REALTIME_MODEL,
        realtimeModel: process.env.OPENAI_REALTIME_MODEL || DEFAULT_REALTIME_MODEL,
        visionModel: process.env.OPENAI_VISION_MODEL || DEFAULT_VISION_MODEL
      });
    }

    if (req.method === "POST" && url.pathname === "/api/realtime/token") {
      return await createRealtimeToken(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/vision/analyze") {
      return await analyzeVision(req, res);
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
    model: process.env.OPENAI_REALTIME_MODEL || DEFAULT_REALTIME_MODEL,
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
    return sendOpenAiError(res, response.status, text, "OpenAI Realtime call failed");
  }

  res.writeHead(200, { "Content-Type": "application/sdp; charset=utf-8" });
  res.end(text);
}

async function createRealtimeToken(req, res) {
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

  const context = collectRequestContext(req.headers);
  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": context.safetyId
    },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model: process.env.OPENAI_REALTIME_MODEL || DEFAULT_REALTIME_MODEL,
        instructions: buildInstructions(context),
        audio: {
          output: {
            voice: "marin"
          }
        }
      }
    })
  });

  const text = await response.text();
  if (!response.ok) {
    return sendOpenAiError(res, response.status, text, "OpenAI Realtime token failed");
  }
  res.writeHead(response.status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(text);
}

async function analyzeVision(req, res) {
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

  let body;
  try {
    body = JSON.parse(await readBody(req, MAX_IMAGE_DATA_URL_LENGTH + 20_000));
  } catch (error) {
    return sendJson(
      res,
      { error: error.status === 413 ? "Image is too large. Use a smaller photo and retry." : "Expected JSON body." },
      error.status || 400
    );
  }

  const imageDataUrl = body?.image_data_url;
  if (!isSupportedImageDataUrl(imageDataUrl)) {
    return sendJson(res, { error: "Expected a JPEG, PNG, WEBP, or GIF image data URL." }, 400);
  }

  if (imageDataUrl.length > MAX_IMAGE_DATA_URL_LENGTH) {
    return sendJson(res, { error: "Image is too large. Use a smaller photo and retry." }, 413);
  }

  const context = sanitizeContext(body?.context);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": stableSafetyId(req.headers["user-agent"] || "unknown")
    },
    body: JSON.stringify({
      model: process.env.OPENAI_VISION_MODEL || DEFAULT_VISION_MODEL,
      input: [
        {
          role: "system",
          content: buildVisionInstructions(context)
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Analyze this domestic-cat image for visible posture, action, stress level, and the relationship between cats if multiple cats are visible. Return only the required JSON."
            },
            {
              type: "input_image",
              image_url: imageDataUrl
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "cat_vision_assessment",
          schema: VISION_SCHEMA,
          strict: true
        }
      },
      reasoning: {
        effort: "low"
      },
      max_output_tokens: 1200
    })
  });

  const text = await response.text();
  if (!response.ok) {
    return sendOpenAiError(res, response.status, text, "OpenAI Vision analysis failed");
  }

  let openAiData;
  try {
    openAiData = JSON.parse(text);
  } catch {
    return sendJson(res, { error: "OpenAI Vision analysis failed", detail: "Vision response was not valid JSON." }, 502);
  }

  const outputText = extractResponsesText(openAiData);
  const parsed = parseFirstJson(outputText);
  if (!parsed) {
    return sendJson(
      res,
      {
        error: "OpenAI Vision analysis failed",
        detail: "Vision model did not return the expected JSON shape."
      },
      502
    );
  }

  return sendJson(res, parsed);
}

function sendOpenAiError(res, status, text, fallbackError) {
  let code = "openai_error";
  try {
    const parsed = JSON.parse(text);
    code = parsed.error?.code || parsed.error?.type || code;
  } catch {
    code = status === 401 ? "openai_auth_error" : code;
  }

  const detail =
    status === 401
      ? "OpenAI credential was rejected. Replace OPENAI_API_KEY with a real OpenAI API key, then retry."
      : "OpenAI request failed. Check server logs for status only; do not expose API keys in client logs.";

  return sendJson(res, { error: fallbackError, status, code, detail }, status);
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

function buildVisionInstructions(context) {
  return [
    "You are CatSense Vision, a cautious visual behavior assessor for common domestic cats.",
    "Use Traditional Chinese in every user-facing string.",
    "Assess only visible evidence: body tension, ear angle, tail position, distance, orientation, eye contact, pawing, chasing, blocking, grooming, sleeping, eating, hiding, and resource proximity.",
    "For two or more visible cats, classify the relationship as affiliative, play, neutral, tense, conflict, avoidance, resource_competition, or unknown from visible evidence only.",
    "For one visible cat, set relationship to single_cat. If no cat is clearly visible, set primary_state/action/posture/relationship to unknown, cat_count to 0, confidence <= 0.2, and explain limitations.",
    "Do not identify breed, identity, age, medical diagnosis, or emotion as certain. Do not infer history that is not visible.",
    "Calibrate confidence from 0 to 1. Use <= 0.35 for cropped, blurry, dark, unusual-angle, or weak evidence images. Use >= 0.75 only when posture and interaction cues are clearly visible.",
    "Set safety_warning true for visible injury, possible respiratory distress, severe fear, active fight, trapped cat, inability to move normally, or any high-risk uncertainty.",
    "Return only JSON matching the schema. Keep strings concise.",
    `Owner context as weak prior only: ${JSON.stringify(context)}`
  ].join("\n");
}

function sanitizeContext(value) {
  if (!value || typeof value !== "object") return {};
  return {
    location: String(value.location || "").slice(0, 80),
    body_language: String(value.body_language || "").slice(0, 120),
    recent_changes: String(value.recent_changes || "").slice(0, 300)
  };
}

function isSupportedImageDataUrl(value) {
  return typeof value === "string" && /^data:image\/(?:jpeg|jpg|png|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(value);
}

function extractResponsesText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") chunks.push(content.text);
      if (typeof content.output_text === "string") chunks.push(content.output_text);
    }
  }
  return chunks.join("\n");
}

function parseFirstJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
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

function readBody(req, maxBytes = Number.POSITIVE_INFINITY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        const error = new Error("Request body too large");
        error.status = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}
