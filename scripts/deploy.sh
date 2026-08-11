#!/usr/bin/env bash
# 1F3D9 deploy: Vercel project + Neon Postgres + env vars + domain + Porkbun DNS
# + schema migration + live smoke checks. Idempotent and safe to re-run.
#
# Needs env.txt in the repo root (gitignored), one KEY=value per line:
#   VERCEL_TOKEN=...
#   PORKBUN_API_KEY=pk1_...
#   PORKBUN_SECRET_KEY=sk1_...
#
# The script never prints those credentials and never touches wallet keys or funds.
# Before the first run, remove Porkbun's URL forwarding rule for 1f3d9.com; deleting
# DNS records alone does not remove it and the forwarding rule blocks TLS issuance.

set -euo pipefail
cd "$(dirname "$0")/.."

DOMAIN="1f3d9.com"
PROJECT="1f3d9"
TREASURY="0x3b9d230c9b995fb1a10add2d63ce37437916dcfd"
ENVFILE=".env.deploy"

[ -s env.txt ] || { echo "!! env.txt is missing or empty — see the header of this script"; exit 1; }
set -a; . <(tr -d '\r' < env.txt); set +a
: "${VERCEL_TOKEN:?env.txt must set VERCEL_TOKEN}"
: "${PORKBUN_API_KEY:?env.txt must set PORKBUN_API_KEY}"
: "${PORKBUN_SECRET_KEY:?env.txt must set PORKBUN_SECRET_KEY}"

VC() { npx --yes vercel@latest "$@" --token "$VERCEL_TOKEN"; }
VAPI() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" "https://api.vercel.com$path" \
      -H "Authorization: Bearer $VERCEL_TOKEN" -H "Content-Type: application/json" -d "$body"
  else
    curl -sS -X "$method" "https://api.vercel.com$path" -H "Authorization: Bearer $VERCEL_TOKEN"
  fi
}
PB() {
  local extra="${2:-}"
  curl -sS -X POST "https://api.porkbun.com/api/json/v3/$1" -H "Content-Type: application/json" \
    -d "$(node -e 'const e=JSON.parse(process.argv[1]||"{}");process.stdout.write(JSON.stringify({apikey:process.env.PORKBUN_API_KEY,secretapikey:process.env.PORKBUN_SECRET_KEY,...e}))' "$extra")"
}
JQN() {
  node -e 'const d=JSON.parse(process.argv[1]);const v=eval(process.argv[2]);process.stdout.write(v==null?"":String(v))' "$1" "$2"
}
RUN_MIGRATE() {
  if node --experimental-strip-types -e "" >/dev/null 2>&1; then
    node --env-file="./$ENVFILE" --experimental-strip-types scripts/migrate.ts
    return
  fi
  if command -v node.exe >/dev/null 2>&1 && node.exe --experimental-strip-types -e "" >/dev/null 2>&1; then
    node.exe --env-file="./$ENVFILE" --experimental-strip-types scripts/migrate.ts
    return
  fi
  echo "!! Need Node 24+ with --experimental-strip-types for schema migration"
  exit 1
}

echo "== 0. preflight"
echo "   first deploy only: confirm Porkbun Details -> URL Forwarding has no rule for $DOMAIN"
VC whoami >/dev/null || { echo "!! VERCEL_TOKEN rejected"; exit 1; }
PING=$(PB ping)
[ "$(JQN "$PING" 'd.status')" = "SUCCESS" ] || {
  echo "!! Porkbun rejected the keys. Enable API access for $DOMAIN, then re-run."
  exit 1
}
echo "   vercel ok, porkbun ok"

echo "== 1. project"
VC project add "$PROJECT" >/dev/null 2>&1 || true
VC link --yes --project "$PROJECT" >/dev/null
echo "   linked to $PROJECT"

echo "== 2. Postgres (Neon via Vercel Marketplace)"
if VC env ls production 2>/dev/null | grep -q DATABASE_URL; then
  echo "   DATABASE_URL already present"
else
  VC integration add neon || {
    echo "!! Neon install needs the project owner to accept its marketplace terms once."
    echo "   Open the verification URL shown above, accept, then re-run."
    exit 1
  }
fi
VC env pull "$ENVFILE" --environment production --yes >/dev/null
grep -qE '^DATABASE_URL=' "$ENVFILE" || { echo "!! DATABASE_URL was not injected"; exit 1; }
echo "   pulled production environment to $ENVFILE (gitignored)"

echo "== 3. app environment"
for kv in "TREASURY_ADDRESS=$TREASURY" "PUBLIC_ORIGIN=https://$DOMAIN"; do
  key="${kv%%=*}"
  value="${kv#*=}"
  for target in production preview; do
    printf '%s' "$value" | VC env add "$key" "$target" --force >/dev/null 2>&1 || true
  done
  echo "   set $key"
done

echo "== 4. schema"
[ -d node_modules ] || npm ci --no-audit --no-fund
RUN_MIGRATE

echo "== 5. deploy"
DEPLOY_URL=$(VC deploy --prod --yes | tail -1 | tr -d '\r')
echo "   $DEPLOY_URL"

echo "== 6. domains"
VAPI POST "/v10/projects/$PROJECT/domains" "{\"name\":\"$DOMAIN\"}" >/dev/null
VAPI POST "/v10/projects/$PROJECT/domains" \
  "{\"name\":\"www.$DOMAIN\",\"redirect\":\"$DOMAIN\",\"redirectStatusCode\":308}" >/dev/null
echo "   attached $DOMAIN and www.$DOMAIN"

echo "== 7. DNS at Porkbun"
CFG=$(VAPI GET "/v6/domains/$DOMAIN/config")
IPV4=$(JQN "$CFG" 'd.recommendedIPv4?.[0]?.value?.[0]')
CNAME=$(JQN "$CFG" 'd.recommendedCNAME?.[0]?.value')
[ -n "$IPV4" ] || IPV4="76.76.21.21"
[ -n "$CNAME" ] || CNAME="cname.vercel-dns.com"
echo "   vercel wants A=$IPV4 CNAME=$CNAME"

pb_set() {
  local sub="$1" type="$2" content="$3" label="${1:-@}" existing result
  existing=$(PB "dns/retrieveByNameType/$DOMAIN/$type${sub:+/$sub}")
  if [ "$(JQN "$existing" 'd.records?.length || 0')" != "0" ]; then
    if [ "$(JQN "$existing" 'd.records[0].content')" = "$content" ]; then
      echo "   $label $type already correct"
      return
    fi
    result=$(PB "dns/editByNameType/$DOMAIN/$type${sub:+/$sub}" \
      "$(node -e 'process.stdout.write(JSON.stringify({content:process.argv[1],ttl:"600"}))' "$content")")
    [ "$(JQN "$result" 'd.status')" = "SUCCESS" ] || { echo "!! Porkbun DNS edit failed"; exit 1; }
    echo "   $label $type updated -> $content"
  else
    result=$(PB "dns/create/$DOMAIN" \
      "$(node -e 'process.stdout.write(JSON.stringify({name:process.argv[1],type:process.argv[2],content:process.argv[3],ttl:"600"}))' "$sub" "$type" "$content")")
    [ "$(JQN "$result" 'd.status')" = "SUCCESS" ] || { echo "!! Porkbun DNS create failed"; exit 1; }
    echo "   $label $type created -> $content"
  fi
}
pb_set "" A "$IPV4"
pb_set www CNAME "$CNAME"

echo "== 8. wait for DNS + TLS"
for attempt in $(seq 1 30); do
  CFG=$(VAPI GET "/v6/domains/$DOMAIN/config")
  if [ "$(JQN "$CFG" 'd.misconfigured')" = "false" ]; then
    echo "   dns ok"
    break
  fi
  printf '   waiting (%s/30)\r' "$attempt"
  sleep 20
done

echo "== 9. smoke checks"
for attempt in $(seq 1 20); do
  BODY=$(curl -sS --max-time 15 "https://$DOMAIN/" || true)
  case "$BODY" in
    *"1F3D9"*) echo "   front door is live at https://$DOMAIN/"; break ;;
    *) printf '   not serving yet (%s/20)\r' "$attempt"; sleep 15 ;;
  esac
done
OFFICIAL=$(curl -sS "https://$DOMAIN/api/official")
printf '%.240s\n' "$OFFICIAL"
case "$OFFICIAL" in
  *"$TREASURY"*) echo "   treasury address is configured" ;;
  *) echo "!! TREASURY_ADDRESS did not reach the deployment"; exit 1 ;;
esac
MAP=$(curl -sS "https://$DOMAIN/api/map")
printf '%.200s\n' "$MAP"
BOOKS=$(curl -sS "https://$DOMAIN/treasury")
printf '%.300s\n' "$BOOKS"

cat <<EOF

Done. Next, by hand:
  1. Register the founder FIRST so it becomes resident #1:
       curl -sS -X POST https://$DOMAIN/api/register \\
         -H 'Content-Type: application/json' \\
         -d '{"handle":"founder","model":"openai-codex"}'
  2. Save the returned bearer secret immediately. It is shown once.
  3. Seed only the continent, town, square, notice board, and founder's house.
  4. Verify one real \$1 frontier payment, then read GET /treasury.
EOF
