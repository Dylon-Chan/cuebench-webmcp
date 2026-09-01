#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'CueBench hosted smoke failed: %s\n' "$1" >&2
  exit 1
}

base_url="${1:-}"
[[ -n "$base_url" ]] || fail "pass the deployed CueBench base URL as the first argument"
command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v node >/dev/null 2>&1 || fail "Node.js is required"

base_url="$(node -e '
  const candidate = process.argv[1];
  const allowHttp = process.argv[2] === "1";
  let url;
  try { url = new URL(candidate); } catch { process.exit(1); }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  const secure = url.protocol === "https:";
  if (!secure && !(allowHttp && loopback && url.protocol === "http:")) process.exit(1);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "" && url.pathname !== "/")) process.exit(1);
  process.stdout.write(url.origin);
' "$base_url" "${CUEBENCH_SMOKE_ALLOW_HTTP:-0}")" \
  || fail "hosted checks require an HTTPS origin without credentials, path, query parameters, or fragments"

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/cuebench-smoke.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

contract_only="${CUEBENCH_SMOKE_CONTRACT_ONLY:-0}"
if [[ "$contract_only" == "1" ]]; then
  [[ "$base_url" == http://127.0.0.1:* || "$base_url" == http://localhost:* || "$base_url" == http://\[::1\]:* ]] \
    || fail "CUEBENCH_SMOKE_CONTRACT_ONLY is restricted to a loopback HTTP fixture"
else
  [[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]] \
    || fail "CLOUDFLARE_ACCOUNT_ID is required; hosted R2 privacy cannot be left unverifiable"
  [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] \
    || fail "CLOUDFLARE_API_TOKEN is required; hosted R2 privacy cannot be left unverifiable"
  turnstile_mode="${CUEBENCH_SMOKE_TURNSTILE_MODE:-}"
  [[ "$turnstile_mode" == "human" ]] \
    || fail "CUEBENCH_SMOKE_TURNSTILE_MODE must be human; real Turnstile interaction is required for every hosted cleanup smoke"
fi

curl_common=(
  --silent
  --show-error
  --connect-timeout 10
  --max-time 30
  --retry 2
  --retry-delay 1
  --retry-all-errors
)
if [[ "$base_url" == https://* ]]; then
  curl_common+=(--proto '=https' --tlsv1.2)
else
  curl_common+=(--proto '=http')
fi

request() {
  local name="$1"
  local path="$2"
  local requested_url="$base_url$path"
  local status
  local effective_url
  local redirect_count
  local header_blocks
  shift 2
  curl "${curl_common[@]}" \
    --dump-header "$scratch/$name.headers" \
    --output "$scratch/$name.body" \
    --write-out '%{http_code}\n%{url_effective}\n%{num_redirects}\n' \
    "$@" \
    "$requested_url" > "$scratch/$name.meta"
  status="$(sed -n '1p' "$scratch/$name.meta")"
  effective_url="$(sed -n '2p' "$scratch/$name.meta")"
  redirect_count="$(sed -n '3p' "$scratch/$name.meta")"
  header_blocks="$(awk '
    BEGIN { count = 0 }
    toupper($1) ~ /^HTTP\/[0-9.]+$/ && $2 ~ /^[0-9][0-9][0-9]$/ { count += 1 }
    END { print count }
  ' "$scratch/$name.headers")"
  [[ "$header_blocks" == "1" ]] \
    || fail "$path must return exactly one HTTP response header block"
  [[ "$redirect_count" == "0" && "$status" != 3?? ]] \
    || fail "$path redirected; the canonical deployed origin must respond directly"
  [[ "$effective_url" == "$requested_url" ]] \
    || fail "$path did not finish at its exact requested canonical URL"
  printf '%s' "$status"
}

header_value() {
  local file="$1"
  local name="$2"
  local wanted
  wanted="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')"
  awk -v wanted="$wanted" '
    BEGIN { IGNORECASE = 1 }
    {
      current = tolower($0)
      prefix = wanted ":"
      if (index(current, prefix) == 1) {
        sub(/^[^:]+:[[:space:]]*/, "", $0)
        sub(/\r$/, "", $0)
        value = $0
      }
    }
    END { print value }
  ' "$file"
}

assert_header() {
  local file="$1"
  local name="$2"
  local expected="$3"
  local value
  local value_lower
  local expected_lower
  value="$(header_value "$file" "$name")"
  [[ -n "$value" ]] || fail "required security header $name is absent"
  value_lower="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
  expected_lower="$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')"
  [[ "$value_lower" == *"$expected_lower"* ]] || fail "security header $name does not contain its required policy"
}

health_status="$(request health /api/health)"
[[ "$health_status" == "200" ]] || fail "/api/health returned HTTP $health_status"
node -e '
  const fs = require("node:fs");
  const parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (parsed?.status !== "ok") process.exit(1);
' "$scratch/health.body" || fail "/api/health did not return the bounded ok contract"

csp="$(header_value "$scratch/health.headers" content-security-policy)"
node -e '
  const directives = new Map(process.argv[1].split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const [name, ...sources] = part.split(/\s+/u);
    return [name, sources];
  }));
  const expected = new Map([
    ["default-src", ["\x27self\x27"]],
    ["base-uri", ["\x27self\x27"]],
    ["form-action", ["\x27self\x27"]],
    ["frame-ancestors", ["\x27none\x27"]],
    ["object-src", ["\x27none\x27"]],
    ["script-src", ["\x27self\x27", "https://challenges.cloudflare.com"]],
    ["style-src", ["\x27self\x27", "\x27unsafe-inline\x27"]],
    ["img-src", ["\x27self\x27", "data:", "blob:"]],
    ["media-src", ["\x27self\x27", "blob:"]],
    ["connect-src", ["\x27self\x27", "https://challenges.cloudflare.com"]],
    ["frame-src", ["\x27self\x27", "https://challenges.cloudflare.com"]],
  ]);
  if (directives.size !== expected.size) process.exit(1);
  for (const [name, sources] of expected) {
    if (JSON.stringify(directives.get(name)) !== JSON.stringify(sources)) process.exit(1);
  }
' "$csp" || fail "content-security-policy does not match the bounded CueBench and Turnstile policy"
assert_header "$scratch/health.headers" referrer-policy "no-referrer"
assert_header "$scratch/health.headers" x-content-type-options "nosniff"
assert_header "$scratch/health.headers" permissions-policy "camera=()"
if [[ "$base_url" == https://* ]]; then
  hsts="$(header_value "$scratch/health.headers" strict-transport-security)"
  [[ "$hsts" == "max-age=31536000" ]] || fail "strict-transport-security must use the dedicated-origin max-age policy"
fi

session_status="$(request session /api/session \
  --request POST \
  --header 'content-type: application/json' \
  --data '{}')"
[[ "$session_status" == "400" ]] || fail "/api/session without Turnstile returned HTTP $session_status instead of 400"
node -e '
  const fs = require("node:fs");
  const parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (parsed?.error?.code !== "TURNSTILE_REQUIRED") process.exit(1);
' "$scratch/session.body" || fail "anonymous processing did not fail closed without Turnstile"

sample_status="$(request sample /sample/gibbs-free-energy.mp4 --range 0-1023)"
[[ "$sample_status" == "200" || "$sample_status" == "206" ]] || fail "the bounded sample returned HTTP $sample_status"
sample_type="$(header_value "$scratch/sample.headers" content-type)"
sample_type="$(printf '%s' "$sample_type" | tr '[:upper:]' '[:lower:]')"
[[ "$sample_type" == video/mp4* ]] || fail "the bounded sample is not served as video/mp4"

reference_status="$(request reference /sample/reference-project.json)"
[[ "$reference_status" == "200" ]] || fail "the bounded sample reference returned HTTP $reference_status"
node -e '
  const fs = require("node:fs");
  const parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const duration = parsed?.durationMs ?? parsed?.media?.durationMs;
  const provider = parsed?.expected?.provider;
  if (!Number.isInteger(duration) || duration <= 0 || duration > 900000) process.exit(1);
  if (provider?.kind !== "deterministic-replay" || provider?.live !== false) process.exit(1);
' "$scratch/reference.body" || fail "the bundled demonstration is not bounded or truthfully labelled"

if [[ "$contract_only" == "1" ]]; then
  printf 'CueBench hosted HTTP contract fixture passed for %s (not deployment evidence).\n' "$base_url"
  exit 0
fi

node "$repository_root/scripts/verify-r2-private.mjs" \
  || fail "authenticated Cloudflare R2 privacy preflight was incomplete"
printf 'CueBench hosted HTTP and authenticated R2 privacy preflight passed for %s\n' "$base_url"

command -v pnpm >/dev/null 2>&1 || fail "pnpm is required for the hosted browser smoke"
printf 'CueBench opened a headed browser; complete the real Turnstile challenge when prompted.\n'
(
  cd "$repository_root"
  CUEBENCH_BASE_URL="$base_url" \
    CUEBENCH_SMOKE_REQUIRE_PROCESSING="1" \
    CUEBENCH_SMOKE_TURNSTILE_MODE="$turnstile_mode" \
    CUEBENCH_SMOKE_HEADLESS="0" \
    pnpm --filter @cuebench/web e2e
)
printf 'CueBench hosted browser release suite passed, including authenticated cancellation/deletion cleanup evidence.\n'
