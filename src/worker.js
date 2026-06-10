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

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/api/health") {
        return json({
          ok: true,
          hasApiKey: Boolean(env.OPENAI_API_KEY),
          model: env.OPENAI_REALTIME_MODEL || DEFAULT_REALTIME_MODEL,
          realtimeModel: env.OPENAI_REALTIME_MODEL || DEFAULT_REALTIME_MODEL,
          visionModel: env.OPENAI_VISION_MODEL || DEFAULT_VISION_MODEL,
          runtime: "cloudflare-worker"
        });
      }

      if (request.method === "POST" && url.pathname === "/api/realtime/token") {
        return await createRealtimeToken(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/vision/analyze") {
        return await analyzeVision(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/realtime/session") {
        return await createRealtimeCall(request, env);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(JSON.stringify({ level: "error", message: error.message }));
      return json({ error: "Server error", detail: error.message }, 500);
    }
  }
};

async function createRealtimeCall(request, env) {
  if (!env.OPENAI_API_KEY) {
    return json(
      {
        error: "OPENAI_API_KEY is missing",
        detail: "Set OPENAI_API_KEY with `wrangler secret put OPENAI_API_KEY`, then redeploy."
      },
      503
    );
  }

  const sdp = await request.text();
  if (!sdp.includes("v=0")) {
    return json({ error: "Expected SDP offer body" }, 400);
  }

  const context = collectRequestContext(request.headers);
  const formData = new FormData();
  formData.set("sdp", sdp);
  formData.set(
    "session",
    JSON.stringify({
      type: "realtime",
      model: env.OPENAI_REALTIME_MODEL || DEFAULT_REALTIME_MODEL,
      instructions: buildInstructions(context),
      audio: {
        output: {
          voice: "marin"
        }
      }
    })
  );

  const response = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "OpenAI-Safety-Identifier": context.safetyId
    },
    body: formData
  });

  if (!response.ok) {
    return await openAiErrorResponse(response, "OpenAI Realtime call failed");
  }

  return new Response(response.body, {
    status: 200,
    headers: {
      "Content-Type": "application/sdp; charset=utf-8"
    }
  });
}

async function createRealtimeToken(request, env) {
  if (!env.OPENAI_API_KEY) {
    return json(
      {
        error: "OPENAI_API_KEY is missing",
        detail: "Set OPENAI_API_KEY with `wrangler secret put OPENAI_API_KEY`, then redeploy."
      },
      503
    );
  }

  const context = collectRequestContext(request.headers);
  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": context.safetyId
    },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model: env.OPENAI_REALTIME_MODEL || DEFAULT_REALTIME_MODEL,
        instructions: buildInstructions(context),
        audio: {
          output: {
            voice: "marin"
          }
        }
      }
    })
  });

  if (!response.ok) {
    return await openAiErrorResponse(response, "OpenAI Realtime token failed");
  }

  return new Response(response.body, {
    status: response.status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

async function analyzeVision(request, env) {
  if (!env.OPENAI_API_KEY) {
    return json(
      {
        error: "OPENAI_API_KEY is missing",
        detail: "Set OPENAI_API_KEY with `wrangler secret put OPENAI_API_KEY`, then redeploy."
      },
      503
    );
  }

  const body = await request.json().catch(() => null);
  const imageDataUrl = body?.image_data_url;
  if (!isSupportedImageDataUrl(imageDataUrl)) {
    return json({ error: "Expected a JPEG, PNG, WEBP, or GIF image data URL." }, 400);
  }

  if (imageDataUrl.length > MAX_IMAGE_DATA_URL_LENGTH) {
    return json({ error: "Image is too large. Use a smaller photo and retry." }, 413);
  }

  const context = sanitizeContext(body?.context);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": stableSafetyId(request.headers.get("user-agent") || "unknown")
    },
    body: JSON.stringify({
      model: env.OPENAI_VISION_MODEL || DEFAULT_VISION_MODEL,
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
    return openAiTextErrorResponse(response.status, text, "OpenAI Vision analysis failed");
  }

  let openAiData;
  try {
    openAiData = JSON.parse(text);
  } catch {
    return json({ error: "OpenAI Vision analysis failed", detail: "Vision response was not valid JSON." }, 502);
  }

  const outputText = extractResponsesText(openAiData);
  const parsed = parseFirstJson(outputText);
  if (!parsed) {
    return json(
      {
        error: "OpenAI Vision analysis failed",
        detail: "Vision model did not return the expected JSON shape."
      },
      502
    );
  }

  return json(parsed);
}

async function openAiErrorResponse(response, fallbackError) {
  const text = await response.text();
  return openAiTextErrorResponse(response.status, text, fallbackError);
}

function openAiTextErrorResponse(status, text, fallbackError) {
  let code = "openai_error";
  try {
    const parsed = JSON.parse(text);
    code = parsed.error?.code || parsed.error?.type || code;
  } catch {
    code = status === 401 ? "openai_auth_error" : code;
  }

  const detail =
    status === 401
      ? "OpenAI credential was rejected. Replace the Cloudflare OPENAI_API_KEY secret with a real OpenAI API key, then retry."
      : "OpenAI request failed. Check Worker logs for status only; do not expose API keys in client logs.";

  return json(
    {
      error: fallbackError,
      status,
      code,
      detail
    },
    status
  );
}

function buildInstructions(context) {
  return [
    "You are CatSense Live, a cautious acoustic classifier for common domestic cat vocalizations.",
    "Do not claim to translate cat language. Classify the likely intent from acoustic evidence first, then use owner context only as a weak prior.",
    "Listen for call type, duration, repetition, pitch contour, intensity, roughness, hiss/growl noise, purr vibration, trill/chirp onset, and stress/yowl characteristics.",
    "Kitten calls are often very short. A single clear 1-2 second meow, chirp, trill, hiss, or yowl is enough to classify, but confidence must stay calibrated to the limited evidence.",
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
  const raw = headers.get("x-catsense-context");
  let visibleContext = {};
  if (raw) {
    try {
      visibleContext = JSON.parse(decodeBase64Url(raw));
    } catch {
      visibleContext = {};
    }
  }

  return {
    visibleContext,
    safetyId: stableSafetyId(headers.get("user-agent") || "unknown")
  };
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function stableSafetyId(input) {
  const bytes = new TextEncoder().encode(String(input));
  let hash = 2166136261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return `catsense-${(hash >>> 0).toString(16)}`;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}
