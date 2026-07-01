import os
import sys
from pathlib import Path

# Add the vendor directory to sys.path so that absolute imports like
# `from src.utils.security import load_secure_key` inside the vendored file work,
# resolving to services/swarm/vendor/src/utils/security.py
vendor_root = Path(__file__).parent / "vendor"
if str(vendor_root) not in sys.path:
    sys.path.insert(0, str(vendor_root))

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from services.swarm.overrides.vertex import override_anthropic_client
import src.server.main as vendored_main

# --- Override 1: generation LLM (BUILD_PLAN §4A — deltas live here, not in the vendored file) ---
# Route the Anthropic-shaped calls to Vertex AI (keyless) instead of an Anthropic API key.
vendored_main._anthropic_client = override_anthropic_client

# --- Override 2: de-CCSJ-ify the correction prompt ---
# The vendored CORRECTION_SYSTEM_PROMPT hard-names "Calumet College of St. Joseph". We must not
# edit the vendored mirror, so we rebind the module constant from institution config at import
# time. The endpoint reads the module global at call time, so this takes effect for every request.
INSTITUTION_NAME = os.environ.get("INSTITUTION_LEGAL_NAME", "St. John Fisher University")
vendored_main.CORRECTION_SYSTEM_PROMPT = vendored_main.CORRECTION_SYSTEM_PROMPT.replace(
    "Calumet College of St. Joseph", INSTITUTION_NAME
)

app = vendored_main.app

# --- Override 3: zero-trust auth on the agent endpoints ---
# The vendored app ships permissive CORS and no auth. Only the Next.js server calls this service
# (server-to-server, so CORS is moot), but the endpoints must not be open. Require a bearer token
# matching SWARM_API_TOKEN when that secret is set. If it is unset (pure local dev), auth is skipped
# and a warning is logged so it can't silently ship open.
_SWARM_TOKEN = os.environ.get("SWARM_API_TOKEN", "")
# manual-entry-assistant is called DIRECTLY from the browser (TrackingDashboard, a Client
# Component) via the public NEXT_PUBLIC_SWARM_API_URL, so it cannot carry the server-only
# secret token. It is exempted here; fully securing it requires proxying that call through a
# Next.js route handler (tracked follow-up — see services/swarm/README.md).
_OPEN_PATHS = {
    "/health", "/docs", "/openapi.json", "/redoc",
    "/api/agent/manual-entry-assistant",
}


class _BearerAuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if not _SWARM_TOKEN or request.url.path in _OPEN_PATHS or request.method == "OPTIONS":
            return await call_next(request)
        header = request.headers.get("authorization", "")
        expected = f"Bearer {_SWARM_TOKEN}"
        if header != expected:
            return JSONResponse({"detail": "Unauthorized"}, status_code=401)
        return await call_next(request)


app.add_middleware(_BearerAuthMiddleware)
if not _SWARM_TOKEN:
    vendored_main.logger.warning(
        "SWARM_API_TOKEN is unset — the swarm API is unauthenticated (local-dev only)."
    )

# Adjust identity for SJFU (branding — cosmetic; the vendored health string is left as the mirror).
app.title = "SJFU Catalog Swarm API (Vertex AI)"

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8080))
    uvicorn.run(app, host="0.0.0.0", port=port)
