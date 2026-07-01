import os
import json
from google import genai
from google.genai import types
import logging

logger = logging.getLogger(__name__)

class VertexContentBlock:
    def __init__(self, text: str):
        self.type = "text"
        self.text = text

class VertexMessageResponse:
    def __init__(self, text: str):
        self.content = [VertexContentBlock(text)]
        self.stop_reason = "end_turn"
        self.stop_details = ""

class VertexMessagesShim:
    def __init__(self):
        # We assume standard ADC in Vertex AI (e.g. on Cloud Run)
        self.client = genai.Client(vertexai=True)
        self.location = "us-east5" # typical GCP region for Vertex Gemini
        
    def create(self, model: str, max_tokens: int, system: str = None, messages: list = None, **kwargs) -> VertexMessageResponse:
        # Map models: 'claude-opus-4-8' -> 'gemini-1.5-pro'
        vertex_model = "gemini-1.5-pro"
        
        # Output config logic
        output_config = kwargs.get("output_config", {})
        response_schema = None
        response_mime_type = "text/plain"
        
        if "format" in output_config and output_config["format"].get("type") == "json_schema":
            response_schema = output_config["format"]["schema"]
            response_mime_type = "application/json"
            
        config = types.GenerateContentConfig(
            system_instruction=system,
            max_output_tokens=max_tokens,
            response_mime_type=response_mime_type,
            response_schema=response_schema
        )
        
        # Map messages (Anthropic array of dict to genai contents)
        formatted_messages = []
        for m in (messages or []):
            role = "user" if m["role"] == "user" else "model"
            formatted_messages.append(types.Content(role=role, parts=[types.Part.from_text(text=m["content"])]))
            
        logger.info(f"Routing LLM call to Vertex ({vertex_model}) via OAuth...")
        response = self.client.models.generate_content(
            model=vertex_model,
            contents=formatted_messages,
            config=config
        )
        
        return VertexMessageResponse(response.text)

class VertexShimClient:
    def __init__(self):
        self.messages = VertexMessagesShim()

def override_anthropic_client():
    return VertexShimClient()
