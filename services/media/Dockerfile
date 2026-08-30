FROM docker.io/astral/uv:0.10.12@sha256:72ab0aeb448090480ccabb99fb5f52b0dc3c71923bffb5e2e26517a1c27b7fec AS uv

# Docker Official Image manifest pinned 2026-08-30. The package pin below is
# Debian Bookworm's published FFmpeg 7:5.1.9-0+deb12u1 release.
FROM docker.io/library/python:3.12.13-slim-bookworm@sha256:4766d8b510c428e595d74b9cc5bbb2fae8e26316fffb4adc89908d79aacd58a2 AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

RUN apt-get update \
    && apt-get install --no-install-recommends -y ffmpeg=7:5.1.9-0+deb12u1 \
    && rm -rf /var/lib/apt/lists/*

FROM base AS build

COPY --from=uv /uv /uvx /usr/local/bin/

WORKDIR /app

COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-dev --no-install-project

COPY src ./src
COPY docker-selftest.py ./
RUN uv sync --frozen --no-dev
RUN . /app/.venv/bin/activate && python docker-selftest.py

FROM base AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:${PATH}"

WORKDIR /app

COPY --from=build /app /app

RUN groupadd --gid 10001 cuebench \
    && useradd --uid 10001 --gid cuebench --create-home --shell /usr/sbin/nologin cuebench \
    && mkdir -p /data/input /data/output \
    && chown -R cuebench:cuebench /data

USER cuebench

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD ["/bin/sh", "-c", ". /app/.venv/bin/activate && python -c \"import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=2).read()\""]

CMD ["/bin/sh", "-c", ". /app/.venv/bin/activate && exec uvicorn cuebench_media.app:create_app_from_environment --factory --host 0.0.0.0 --port 8080"]
