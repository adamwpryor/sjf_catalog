/**
 * Shared multi-provider LLM utilities.
 *
 * The app is intentionally provider-agnostic (Vertex/Gemini by default, with
 * OpenAI and Anthropic paths) and calls each provider over raw `fetch`. This
 * module centralizes credential resolution and a single-shot completion helper
 * so routes don't each re-implement the same provider routing.
 */

/**
 * Resolves GCP credentials using Vercel OIDC Workload Identity, Service Account
 * keys, or Application Default Credentials.
 *
 * @param req - The incoming HTTP request (used to read the Vercel OIDC token).
 * @returns An object containing the GCP projectId, location, and an access token.
 */
export async function getGcpCredentials(req: Request) {
  const gcpProjectId = process.env.GCP_PROJECT_ID || 'sjf-catalog-app';
  const gcpLocation = process.env.GCP_LOCATION || 'us-central1';
  let accessToken = process.env.VERTEX_AI_ACCESS_TOKEN || '';

  // 1. Exchange dynamic Vercel OIDC Token for Google STS / Service Account access token
  const oidcToken = req.headers.get('x-vercel-oidc-token') || process.env.VERCEL_OIDC_TOKEN;
  if (oidcToken && process.env.GCP_PROJECT_NUMBER && process.env.GCP_WORKLOAD_IDENTITY_POOL_ID) {
    try {
      console.log(`[Vertex AI OIDC] Initiating keyless Workload Identity exchange...`);
      const projectNumber = process.env.GCP_PROJECT_NUMBER;
      const poolId = process.env.GCP_WORKLOAD_IDENTITY_POOL_ID;
      const providerId = process.env.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID || 'vercel';
      const saEmail = process.env.GCP_SERVICE_ACCOUNT_EMAIL;

      const providerPath = `projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/providers/${providerId}`;
      const stsRes = await fetch("https://sts.googleapis.com/v1/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audience: `//iam.googleapis.com/${providerPath}`,
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
          subject_token: oidcToken,
          subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
          scope: "https://www.googleapis.com/auth/cloud-platform"
        })
      });

      if (stsRes.ok) {
        const stsData = await stsRes.json();
        const stsToken = stsData.access_token;

        const impRes = await fetch(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${saEmail}:generateAccessToken`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${stsToken}`
          },
          body: JSON.stringify({
            scope: ["https://www.googleapis.com/auth/cloud-platform"],
            lifetime: "3600s"
          })
        });

        if (impRes.ok) {
          const impData = await impRes.json();
          accessToken = impData.accessToken;
          console.log(`[Vertex AI OIDC] WIF STS exchange succeeded! Impersonated: ${saEmail}`);
        }
      }
    } catch (err: any) {
      console.warn(`[Vertex AI OIDC] work identity exchange failed: ${err.message}`);
    }
  }

  // 2. Fallback to Service Account Private Key JSON parsing
  if (!accessToken && process.env.GCP_PRIVATE_KEY && process.env.GCP_SERVICE_ACCOUNT_EMAIL) {
    try {
      console.log(`[Vertex AI Auth] Private Key found. Signing credentials JWT...`);
      const { GoogleAuth } = await import('google-auth-library');
      const auth = new GoogleAuth({
        projectId: gcpProjectId,
        credentials: {
          client_email: process.env.GCP_SERVICE_ACCOUNT_EMAIL,
          private_key: process.env.GCP_PRIVATE_KEY.replace(/\\n/g, '\n')
        },
        scopes: 'https://www.googleapis.com/auth/cloud-platform'
      });
      const client = await auth.getClient();
      const tokenRes = await client.getAccessToken();
      accessToken = tokenRes.token || '';
      console.log(`[Vertex AI Auth] SA Private Key auth successful.`);
    } catch (err: any) {
      console.warn(`[Vertex AI Auth] SA Private Key auth failed: ${err.message}`);
    }
  }

  // 3. Fallback to Application Default Credentials (ADC) local gcloud loading
  if (!accessToken) {
    try {
      const { GoogleAuth } = await import('google-auth-library');
      const auth = new GoogleAuth({
        scopes: 'https://www.googleapis.com/auth/cloud-platform'
      });
      const client = await auth.getClient();
      const tokenRes = await client.getAccessToken();
      accessToken = tokenRes.token || '';
      console.log(`[Vertex AI Auth] Loaded credentials from Local ADC.`);
    } catch (err: any) {
      console.warn(`[Vertex AI Auth] Local ADC fallback failed: ${err.message}`);
    }
  }

  return {
    projectId: gcpProjectId,
    location: gcpLocation,
    accessToken
  };
}

export interface CallLLMOptions {
  /** System / instruction prompt. */
  system: string;
  /** User prompt / content. */
  user: string;
  /** The incoming request, used to resolve keyless Vertex credentials. */
  req: Request;
  /** Request JSON-only output (Gemini responseMimeType + instruction for others). */
  json?: boolean;
  /** Max output tokens. Defaults to 2000. */
  maxTokens?: number;
}

export interface CallLLMResult {
  text: string;
  model: string;
}

/**
 * Performs a single-shot completion against the first available provider.
 * Preference order: Anthropic (Claude) -> Vertex AI (Gemini) -> Gemini API key -> OpenAI.
 *
 * @param opts - The prompt, request, and output options.
 * @returns The generated text and the model label, or null if no provider is configured.
 */
export async function callLLM(opts: CallLLMOptions): Promise<CallLLMResult | null> {
  const { system, user, req, json = false, maxTokens = 2000 } = opts;
  const geminiKey = process.env.GEMINI_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  // A JSON-only nudge for providers without a structured-output flag.
  const systemForJson = json
    ? `${system}\n\nIMPORTANT: Respond with a single valid JSON object only. No prose, no markdown fences.`
    : system;

  // 1. Anthropic direct (Claude) — preferred for reasoning-heavy tasks.
  if (anthropicKey) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-opus-4-8',
          max_tokens: maxTokens,
          system: systemForJson,
          messages: [{ role: 'user', content: user }],
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data.content?.find((b: any) => b.type === 'text')?.text;
        if (text) return { text, model: 'Claude Opus 4.8' };
      } else {
        console.warn(`[callLLM] Anthropic returned ${res.status}: ${await res.text()}`);
      }
    } catch (err: any) {
      console.warn(`[callLLM] Anthropic call failed: ${err.message}`);
    }
  }

  const gcp = await getGcpCredentials(req);

  // 2. Vertex AI Gemini (keyless Workload Identity / Service Account).
  if (gcp.accessToken) {
    try {
      const apiModel = 'gemini-2.5-pro';
      const url = `https://${gcp.location}-aiplatform.googleapis.com/v1/projects/${gcp.projectId}/locations/${gcp.location}/publishers/google/models/${apiModel}:generateContent`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${gcp.accessToken}` },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: user }] }],
          systemInstruction: { parts: [{ text: system }] },
          ...(json ? { generationConfig: { responseMimeType: 'application/json' } } : {}),
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return { text, model: 'Gemini 2.5 Pro (Vertex AI)' };
      } else {
        console.warn(`[callLLM] Vertex Gemini returned ${res.status}: ${await res.text()}`);
      }
    } catch (err: any) {
      console.warn(`[callLLM] Vertex Gemini call failed: ${err.message}`);
    }
  }

  // 3. Gemini API key (Google AI Studio).
  if (geminiKey) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: user }] }],
          systemInstruction: { parts: [{ text: system }] },
          ...(json ? { generationConfig: { responseMimeType: 'application/json' } } : {}),
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return { text, model: 'Gemini 2.5 Flash' };
      } else {
        console.warn(`[callLLM] Gemini returned ${res.status}: ${await res.text()}`);
      }
    } catch (err: any) {
      console.warn(`[callLLM] Gemini call failed: ${err.message}`);
    }
  }

  // 4. OpenAI.
  if (openaiKey) {
    try {
      const baseUrl = process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1';
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: systemForJson },
            { role: 'user', content: user },
          ],
          temperature: 0.3,
          ...(json ? { response_format: { type: 'json_object' } } : {}),
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content;
        if (text) return { text, model: 'GPT-4o' };
      } else {
        console.warn(`[callLLM] OpenAI returned ${res.status}: ${await res.text()}`);
      }
    } catch (err: any) {
      console.warn(`[callLLM] OpenAI call failed: ${err.message}`);
    }
  }

  return null;
}

/**
 * Extracts a JSON object from a model response that may be wrapped in prose or
 * markdown code fences.
 *
 * @param text - The raw model output.
 * @returns The parsed object, or null if no valid JSON could be extracted.
 */
export function extractJson<T = any>(text: string): T | null {
  if (!text) return null;
  // Strip markdown fences if present.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  // Find the outermost JSON object.
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(candidate.slice(start, end + 1)) as T;
    } catch {
      // fall through to salvage
    }
  }

  // Salvage: recover complete `{...}` objects from a (possibly truncated) array,
  // e.g. when the model hit max_tokens mid-array. Rebuild { "initiatives": [...] }.
  const arrStart = candidate.indexOf('[', Math.max(0, candidate.indexOf('initiatives')));
  if (arrStart !== -1) {
    const objs: string[] = [];
    let depth = 0, objStart = -1, inStr = false, esc = false;
    for (let i = arrStart + 1; i < candidate.length; i++) {
      const ch = candidate[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') { if (depth === 0) objStart = i; depth++; }
      else if (ch === '}') { depth--; if (depth === 0 && objStart !== -1) { objs.push(candidate.slice(objStart, i + 1)); objStart = -1; } }
    }
    if (objs.length > 0) {
      try {
        return JSON.parse(`{"initiatives":[${objs.join(',')}]}`) as T;
      } catch {
        return null;
      }
    }
  }
  return null;
}
