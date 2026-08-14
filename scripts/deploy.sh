#!/usr/bin/env bash
# 1F3D9 deploy: Vercel project + Neon Postgres + env vars + domain + Porkbun DNS
# + live smoke checks. Idempotent and safe to re-run.
#
# This command NEVER migrates a database. Preview and production migrations use
# the separately guarded npm scripts documented in docs/HOSTED_CHAT_SIGNIN.md.
#
# Needs env.txt in the repo root (gitignored), one literal KEY=value per line.
# Quotes and shell expressions are rejected; this file is data, not a script.
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
PRODUCTION_DEPLOY_ACKNOWLEDGEMENT="DEPLOY_REVIEWED_COMMIT_TO_1F3D9_PRODUCTION"

load_deploy_settings() {
  [ -e env.txt ] || return 0

  local line key value line_number=0
  local -A seen_keys=()
  while IFS= read -r line || [ -n "$line" ]; do
    line_number=$((line_number + 1))
    line="${line%$'\r'}"
    [ -z "$line" ] && continue
    [[ "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || {
      echo "!! env.txt line $line_number must be a literal KEY=value setting"
      return 1
    }

    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      VERCEL_TOKEN|PORKBUN_API_KEY|PORKBUN_SECRET_KEY|CONFIRM_PRODUCTION_DEPLOY|\
      PRODUCTION_RELEASE_BRANCH|PRODUCTION_RELEASE_COMMIT|\
      PRESERVE_ENABLED_HOSTED_CHAT_SIGNIN) ;;
      *)
        echo "!! unexpected key in env.txt at line $line_number"
        return 1
        ;;
    esac
    if [[ -n "${seen_keys[$key]+present}" ]]; then
      echo "!! duplicate key in env.txt at line $line_number"
      return 1
    fi
    case "$value" in
      *[!A-Za-z0-9._~:/@%+=,-]*)
        echo "!! env.txt line $line_number contains unsupported characters"
        return 1
        ;;
    esac

    seen_keys[$key]=1
    printf -v "$key" '%s' "$value"
    export "$key"
  done < env.txt
}

# Parse the ignored settings file as inert data before checking release intent.
# No provider or production operation has happened at this point.
load_deploy_settings

verify_release_intent() {
  [ "${CONFIRM_PRODUCTION_DEPLOY:-}" = "$PRODUCTION_DEPLOY_ACKNOWLEDGEMENT" ] || {
    echo "!! production deploy requires CONFIRM_PRODUCTION_DEPLOY=$PRODUCTION_DEPLOY_ACKNOWLEDGEMENT"
    return 1
  }
  [ -n "${PRODUCTION_RELEASE_BRANCH:-}" ] || {
    echo "!! PRODUCTION_RELEASE_BRANCH must name the reviewed release branch"
    return 1
  }
  git check-ref-format --branch "$PRODUCTION_RELEASE_BRANCH" >/dev/null 2>&1 || {
    echo "!! PRODUCTION_RELEASE_BRANCH is not a valid branch name"
    return 1
  }
  [[ "${PRODUCTION_RELEASE_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || {
    echo "!! PRODUCTION_RELEASE_COMMIT must be the full reviewed commit id"
    return 1
  }

  local current_branch current_commit branch_commit worktree_state
  current_branch=$(git symbolic-ref --quiet --short HEAD) || {
    echo "!! production deploy requires the named release branch, not a detached checkout"
    return 1
  }
  current_commit=$(git rev-parse --verify HEAD) || {
    echo "!! could not read the current release commit"
    return 1
  }
  branch_commit=$(git rev-parse --verify "$PRODUCTION_RELEASE_BRANCH^{commit}" 2>/dev/null) || {
    echo "!! the intended release branch does not exist locally"
    return 1
  }
  [ "$current_branch" = "$PRODUCTION_RELEASE_BRANCH" ] || {
    echo "!! current branch is not the intended production release branch"
    return 1
  }
  [ "$current_commit" = "$PRODUCTION_RELEASE_COMMIT" ] && \
    [ "$branch_commit" = "$PRODUCTION_RELEASE_COMMIT" ] || {
    echo "!! current commit is not the reviewed production release commit"
    return 1
  }
  worktree_state=$(git status --porcelain=v1 --untracked-files=all) || {
    echo "!! could not verify that the release worktree is clean"
    return 1
  }
  [ -z "$worktree_state" ] || {
    echo "!! production release worktree must be clean, including untracked files"
    return 1
  }
  echo "   release branch and commit verified; worktree is clean"
}

echo "== 0. immutable release gate"
verify_release_intent
if [ "${1:-}" = "--verify-release-only" ]; then
  [ "$#" -eq 1 ] || { echo "!! --verify-release-only accepts no other arguments"; exit 1; }
  exit 0
fi
[ "$#" -eq 0 ] || { echo "!! unknown deploy argument"; exit 1; }

[ -s env.txt ] || { echo "!! env.txt is missing or empty — see the header of this script"; exit 1; }
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
echo "== 1. complete local release gates"
[ -d node_modules ] || npm ci --no-audit --no-fund
npm test
npm run typecheck
npm run test:postgres
npm run test:e2e
verify_release_intent
echo "   unit, type, PostgreSQL, and browser tests passed"

echo "== 2. provider preflight"
echo "   first deploy only: confirm Porkbun Details -> URL Forwarding has no rule for $DOMAIN"
VC whoami >/dev/null || { echo "!! VERCEL_TOKEN rejected"; exit 1; }
PING=$(PB ping)
[ "$(JQN "$PING" 'd.status')" = "SUCCESS" ] || {
  echo "!! Porkbun rejected the keys. Enable API access for $DOMAIN, then re-run."
  exit 1
}
echo "   vercel ok, porkbun ok"

echo "== 3. project"
VC project add "$PROJECT" >/dev/null 2>&1 || true
VC link --yes --project "$PROJECT" >/dev/null
echo "   linked to $PROJECT"

echo "== 4. Postgres connection presence (no migration)"
if VC env ls production 2>/dev/null | grep -q DATABASE_URL; then
  echo "   DATABASE_URL already present"
else
  VC integration add neon || {
    echo "!! Neon install needs the project owner to accept its marketplace terms once."
    echo "   Open the verification URL shown above, accept, then re-run."
    exit 1
  }
fi
echo "   database schema is intentionally managed by a separate guarded command"

echo "== 5. production app environment"
verify_release_intent
for kv in "TREASURY_ADDRESS=$TREASURY" "PUBLIC_ORIGIN=https://$DOMAIN"; do
  key="${kv%%=*}"
  value="${kv#*=}"
  if ! printf '%s' "$value" | VC env add "$key" production --force >/dev/null 2>&1; then
    echo "!! failed to set required production setting $key; deploy stopped"
    exit 1
  fi
  echo "   set $key"
done

if [ "${PRESERVE_ENABLED_HOSTED_CHAT_SIGNIN:-}" = "REAL_CLIENT_GATES_ALREADY_PASSED" ]; then
  VC env ls production 2>/dev/null | grep -q HOSTED_CHAT_SIGNIN_ENABLED || {
    echo "!! production hosted-chat setting is absent; refusing to guess an enabled value"
    exit 1
  }
  echo "   preserving the established production hosted-chat setting"
else
  if ! printf '%s' 'false' | VC env add HOSTED_CHAT_SIGNIN_ENABLED production --force >/dev/null 2>&1; then
    echo "!! failed to force hosted-chat sign-in off; deploy stopped"
    exit 1
  fi
  echo "   forced HOSTED_CHAT_SIGNIN_ENABLED=false for this guarded production deploy"
fi

echo "== 6. deploy"
verify_release_intent
DEPLOY_URL=$(VC deploy --prod --yes | tail -1 | tr -d '\r')
echo "   $DEPLOY_URL"

echo "== 7. domains"
VAPI POST "/v10/projects/$PROJECT/domains" "{\"name\":\"$DOMAIN\"}" >/dev/null
VAPI POST "/v10/projects/$PROJECT/domains" \
  "{\"name\":\"www.$DOMAIN\",\"redirect\":\"$DOMAIN\",\"redirectStatusCode\":308}" >/dev/null
echo "   attached $DOMAIN and www.$DOMAIN"

echo "== 8. DNS at Porkbun"
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

echo "== 9. wait for DNS + TLS"
for attempt in $(seq 1 30); do
  CFG=$(VAPI GET "/v6/domains/$DOMAIN/config")
  if [ "$(JQN "$CFG" 'd.misconfigured')" = "false" ]; then
    echo "   dns ok"
    break
  fi
  printf '   waiting (%s/30)\r' "$attempt"
  sleep 20
done

echo "== 10. smoke checks"
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

Done. The application deployed atomically; no database migration was run.
Hosted-chat sign-in keeps its existing setting and defaults to off when first added.
EOF
