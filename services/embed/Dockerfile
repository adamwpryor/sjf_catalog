# Qwen3 embedding service — GCP Cloud Run (L4 GPU).
# Base image ships vLLM + torch + CUDA, matching the hub's embedding stack.
FROM vllm/vllm-openai:latest

WORKDIR /app

# FastAPI wrapper deps (vllm/torch already in base).
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Bake the model into the image for fast cold-start (large image, but no 16GB
# download on scale-from-zero). Set --build-arg BAKE=false to download at runtime.
ARG BAKE=true
ARG EMBED_MODEL=Qwen/Qwen3-Embedding-8B
RUN if [ "$BAKE" = "true" ]; then \
      python -c "from huggingface_hub import snapshot_download; snapshot_download('${EMBED_MODEL}')"; \
    fi

COPY app.py .

ENV EMBED_MODEL=Qwen/Qwen3-Embedding-8B \
    EMBED_DIM=1024 \
    PORT=8080 \
    HF_HUB_OFFLINE=0

# Clear the base image's vLLM server entrypoint; run our FastAPI app instead.
ENTRYPOINT []
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
