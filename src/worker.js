const DEFAULT_MODEL = "gpt-realtime-2";

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/api/health") {
        return json({
          ok: true,
          hasApiKey: Boolean(env.OPENAI_API_KEY),
          model: env.OPENAI_REALTIME_MODEL || DEFAULT_MODEL,
          runtime: "cloudflare-worker"
        });
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
      model: env.OPENAI_REALTIME_MODEL || DEFAULT_MODEL,
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
    const detail = await response.text();
    return json(
      {
        error: "OpenAI Realtime call failed",
        status: response.status,
        detail
      },
      response.status
    );
  }

  return new Response(response.body, {
    status: 200,
    headers: {
      "Content-Type": "application/sdp; charset=utf-8"
    }
  });
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
