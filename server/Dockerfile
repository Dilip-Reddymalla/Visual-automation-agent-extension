# The API in front of vLLM. Deliberately small: the contract, the session state, and
# nothing that needs a GPU -- so this image starts and answers /health on a machine that
# has no accelerator at all.

FROM python:3.11-slim

WORKDIR /app

# Pinned, and installed before the source is copied so a code change does not re-resolve
# the dependency tree on a machine that may be offline.
RUN pip install --no-cache-dir \
    fastapi==0.115.6 \
    'uvicorn[standard]==0.34.0' \
    httpx==0.28.1 \
    jsonschema==4.23.0 \
    python-multipart==0.0.20

COPY app.py planner.py check_guided_decoding.py ./
# Generated from extension/src/shared/contract.ts by `npm run schema:gen`. Copied rather
# than regenerated: this image has no Node, and a second generator would be a second
# contract.
COPY schema.json schema.request.json ./

EXPOSE 8000

# One worker. The GPU is the bottleneck and concurrent requests to vLLM queue anyway;
# more workers would only multiply the session dictionaries.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
