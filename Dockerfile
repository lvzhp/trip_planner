# ---------- stage 1: build the React/Vite frontend ----------
FROM node:22-alpine AS web

RUN npm install -g pnpm@11.8.0
WORKDIR /web
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --config.minimumReleaseAge=0
COPY frontend/ ./
RUN pnpm build

# ---------- stage 2: FastAPI backend + built frontend ----------
FROM python:3.13-slim AS api

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1
RUN pip install --no-cache-dir "uv>=0.5"

WORKDIR /workspace/backend
COPY backend/pyproject.toml backend/uv.lock backend/README.md ./
RUN uv sync --frozen --no-dev --no-install-project

COPY backend/ ./
COPY --from=web /web/dist /workspace/frontend/dist

RUN useradd --create-home --uid 10001 --user-group trace \
    && mkdir -p /workspace/backend/data \
    && chown -R trace:trace /workspace
USER trace

EXPOSE 8010
HEALTHCHECK --interval=20s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8010/api/health', timeout=3)"
CMD [".venv/bin/uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8010"]
