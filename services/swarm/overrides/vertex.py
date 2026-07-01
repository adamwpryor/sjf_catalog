"""SJFU override: route the vendored swarm's Anthropic calls to Vertex AI (keyless).

The vendored `src/server/main.py` talks to an Anthropic-shaped client
(`client.messages.create(model, max_tokens, system, messages, output_config, ...)`).
On Cloud Run we have no Anthropic key — Adam's org disallows API keys — so this shim
presents that exact surface while calling Vertex Gemini via Application Default
Credentials (BUILD_PLAN §P8: "GCP-hosted LLM … Vertex Gemini").

It is deliberately an *override*, never an edit to the vendored file (BUILD_PLAN §4A).

Fidelity notes (why this is more than a passthrough):
  * Messages carry Anthropic content blocks — a bare string OR a list of
    {type:text|document} blocks (catalog-correction sends a rendered-page PDF and an
    uploaded source doc for vision grounding). Both shapes are mapped to genai Parts.
  * Anthropic structured output uses full JSON Schema; Gemini's responseSchema is an
    OpenAPI subset that rejects `additionalProperties`, so it is stripped recursively.
  * A Gemini safety/recitation stop is mapped to Anthropic's `stop_reason="refusal"`
    so the vendored refusal guards (which return HTTP 502) still fire.
"""

import os
import base64
import logging

from google import genai
from google.genai import types

logger = logging.getLogger(__name__)

# Current Vertex Gemini generation model. Override with VERTEX_GEMINI_MODEL.
# (gemini-1.5-pro is retired on Vertex; 2.5-pro is the current flagship.)
DEFAULT_VERTEX_MODEL = os.environ.get("VERTEX_GEMINI_MODEL", "gemini-2.5-pro")
# ADC location for Vertex; us-east5 carries the Gemini models. Override with GOOGLE_CLOUD_LOCATION.
VERTEX_LOCATION = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-east5")

# Gemini finish reasons that mean the model declined — surfaced as an Anthropic refusal.
_REFUSAL_FINISH_REASONS = {"SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "RECITATION", "SPII"}


def _strip_unsupported_schema(node):
    """Return a copy of a JSON Schema with keys Vertex's responseSchema rejects removed.

    Gemini accepts an OpenAPI 3 subset; `additionalProperties` (emitted by every schema
    in the vendored main.py) is not part of it and causes a 400. Recurse through
    properties/items so nested objects are cleaned too.

    Args:
        node: A JSON-schema fragment (dict/list/scalar).

    Returns:
        The same structure with unsupported keys pruned.
    """
    if isinstance(node, dict):
        return {
            k: _strip_unsupported_schema(v)
            for k, v in node.items()
            if k != "additionalProperties"
        }
    if isinstance(node, list):
        return [_strip_unsupported_schema(v) for v in node]
    return node


def _to_parts(content) -> list:
    """Map one Anthropic message's content to a list of genai Parts.

    Args:
        content: Either a plain string or a list of Anthropic content blocks
            ({"type": "text", ...} or {"type": "document", "source": {...}}).

    Returns:
        List[types.Part]: parts ready for a genai Content.
    """
    if isinstance(content, str):
        return [types.Part.from_text(text=content)]

    parts: list = []
    for block in content or []:
        btype = block.get("type")
        if btype == "text":
            parts.append(types.Part.from_text(text=block.get("text", "")))
        elif btype == "document":
            source = block.get("source", {}) or {}
            data = source.get("data", "")
            mime = source.get("media_type", "application/pdf")
            if data:
                parts.append(types.Part.from_bytes(data=base64.b64decode(data), mime_type=mime))
        else:
            # Unknown block — degrade gracefully to its string form rather than drop context.
            parts.append(types.Part.from_text(text=str(block)))
    return parts


class VertexContentBlock:
    def __init__(self, text: str):
        self.type = "text"
        self.text = text


class VertexMessageResponse:
    """Anthropic-shaped response: `.content[].text`, `.stop_reason`, `.stop_details`."""

    def __init__(self, text: str, stop_reason: str = "end_turn", stop_details: str = ""):
        self.content = [VertexContentBlock(text)]
        self.stop_reason = stop_reason
        self.stop_details = stop_details


class VertexMessagesShim:
    def __init__(self):
        # Keyless: Application Default Credentials on Cloud Run. project/location come from
        # ADC / env (GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION) — never an API key.
        self.client = genai.Client(vertexai=True, location=VERTEX_LOCATION)

    def create(self, model: str, max_tokens: int, system: str = None,
               messages: list = None, **kwargs) -> VertexMessageResponse:
        vertex_model = DEFAULT_VERTEX_MODEL

        output_config = kwargs.get("output_config", {}) or {}
        response_schema = None
        response_mime_type = "text/plain"
        fmt = output_config.get("format", {}) or {}
        if fmt.get("type") == "json_schema" and fmt.get("schema"):
            response_schema = _strip_unsupported_schema(fmt["schema"])
            response_mime_type = "application/json"

        config = types.GenerateContentConfig(
            system_instruction=system,
            max_output_tokens=max_tokens,
            response_mime_type=response_mime_type,
            response_schema=response_schema,
        )

        contents = [
            types.Content(
                role=("user" if m["role"] == "user" else "model"),
                parts=_to_parts(m["content"]),
            )
            for m in (messages or [])
        ]

        logger.info("Routing LLM call to Vertex (%s) via ADC…", vertex_model)
        response = self.client.models.generate_content(
            model=vertex_model, contents=contents, config=config
        )

        # Detect a declined/blocked generation and surface it as an Anthropic refusal so the
        # vendored guards return a clean 502 instead of crashing on an empty `.text`.
        finish_reason = ""
        candidate = (getattr(response, "candidates", None) or [None])[0]
        if candidate is not None and getattr(candidate, "finish_reason", None) is not None:
            finish_reason = str(candidate.finish_reason).split(".")[-1].upper()
        if finish_reason in _REFUSAL_FINISH_REASONS:
            return VertexMessageResponse("", stop_reason="refusal", stop_details=finish_reason)

        # `.text` can raise when there is no text part; fall back to an empty string.
        try:
            text = response.text or ""
        except Exception as exc:  # pragma: no cover - defensive
            logger.error("Vertex response had no text part: %s", exc)
            text = ""
        return VertexMessageResponse(text)


class VertexShimClient:
    def __init__(self):
        self.messages = VertexMessagesShim()


def override_anthropic_client():
    """Factory matching the vendored `_anthropic_client()` signature (zero-arg → client)."""
    return VertexShimClient()
