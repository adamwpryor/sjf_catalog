import sys
from pathlib import Path

# Add the vendor directory to sys.path so that absolute imports like 
# `from src.utils.security import load_secure_key` inside the vendored file work,
# resolving to services/swarm/vendor/src/utils/security.py
vendor_root = Path(__file__).parent / "vendor"
if str(vendor_root) not in sys.path:
    sys.path.insert(0, str(vendor_root))

from services.swarm.overrides.vertex import override_anthropic_client
import src.server.main as vendored_main

# Apply SJFU-specific override: Use Vertex AI natively on Cloud Run via OAuth
# instead of an Anthropic API Key.
vendored_main._anthropic_client = override_anthropic_client

# Export the FastAPI app so uvicorn can run `services.swarm.main:app`
app = vendored_main.app

# Adjust title for SJFU
app.title = "SJFU Catalog Swarm API (Vertex AI)"
