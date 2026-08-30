FROM ghcr.io/astral-sh/uv:0.10.12 AS uv

FROM python:3.12.13-slim-bookworm AS build

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

COPY --from=uv /uv /uvx /usr/local/bin/

WORKDIR /app

COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-dev --no-install-project

COPY src ./src
RUN uv sync --frozen --no-dev

FROM python:3.12.13-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:${PATH}"

RUN apt-get update \
    && apt-get install --no-install-recommends -y ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app /app

RUN groupadd --gid 10001 cuebench \
    && useradd --uid 10001 --gid cuebench --create-home --shell /usr/sbin/nologin cuebench \
    && mkdir -p /data/input /data/output \
    && chown -R cuebench:cuebench /data

USER cuebench

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD ["/app/.venv/bin/python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=2).read()"]

CMD ["/app/.venv/bin/uvicorn", "cuebench_media.app:create_app_from_environment", "--factory", "--host", "0.0.0.0", "--port", "8080"]
