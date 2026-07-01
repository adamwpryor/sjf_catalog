import sys
from pathlib import Path

# Add the root of sjf_catalog to sys.path so that absolute imports like `from src.utils.security...` inside the vendored file work
workspace_root = Path(__file__).parent.parent.parent
if str(workspace_root) not in sys.path:
    sys.path.insert(0, str(workspace_root))

from services.swarm.overrides.vertex import override_anthropic_client
import services.swarm.vendor.main as vendored_main

# Apply SJFU-specific override: Use Vertex AI natively on Cloud Run via OAuth
# instead of an Anthropic API Key.
vendored_main._anthropic_client = override_anthropic_client

# Export the FastAPI app so uvicorn can run `services.swarm.main:app`
app = vendored_main.app

# Adjust title for SJFU
app.title = "SJFU Catalog Swarm API (Vertex AI)"
