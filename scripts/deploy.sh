#!/usr/bin/env bash
# This helper prepares a pushed branch for review. It cannot deploy anything.
# Production releases come only from merging GitHub main into the linked Vercel project.
# Database migrations remain separate, explicitly named commands in package.json.

set -euo pipefail
cd "$(dirname "$0")/.."

show_guidance() {
  cat <<'EOF'
Manual production deployment is disabled.

Run scripts/deploy.sh --prepare on a clean branch that is already pushed to origin.
Then open a GitHub pull request and merge it into main. Vercel's GitHub integration
builds and ships that exact main commit; this helper never uploads a local folder.
EOF
}

if [ "$#" -ne 1 ] || [ "$1" != "--prepare" ]; then
  show_guidance
  exit 2
fi

verify_pushed_candidate() {
  local branch commit upstream remote_commit worktree_state origin_url

  branch=$(git symbolic-ref --quiet --short HEAD) || {
    echo "!! preparation requires a branch, not a detached checkout"
    return 1
  }
  [ "$branch" != "main" ] || {
    echo "!! prepare a review branch; main ships automatically after a GitHub merge"
    return 1
  }

  worktree_state=$(git status --porcelain=v1 --untracked-files=all) || {
    echo "!! could not verify the candidate worktree"
    return 1
  }
  [ -z "$worktree_state" ] || {
    echo "!! preparation worktree must be clean, including untracked files"
    return 1
  }

  upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null) || {
    echo "!! branch must be pushed to origin before preparation"
    return 1
  }
  [ "$upstream" = "origin/$branch" ] || {
    echo "!! branch must track its matching origin branch"
    return 1
  }

  origin_url=$(git remote get-url origin 2>/dev/null) || {
    echo "!! origin is missing"
    return 1
  }
  [ -n "$origin_url" ] || {
    echo "!! origin is missing"
    return 1
  }

  commit=$(git rev-parse --verify HEAD)
  remote_commit=$(git ls-remote --exit-code origin "refs/heads/$branch" 2>/dev/null |
    awk 'NR == 1 { print $1 }') || {
      echo "!! could not prove that this branch is pushed to origin"
      return 1
    }
  [ "$remote_commit" = "$commit" ] || {
    echo "!! the exact candidate commit must be pushed to origin before preparation"
    return 1
  }

  echo "   clean branch verified at its exact pushed origin commit"
}

echo "== 1. verify pushed release candidate"
verify_pushed_candidate

echo "== 2. run local release gates"
[ -d node_modules ] || npm ci --no-audit --no-fund
npm test
npm run typecheck
npm run test:postgres
npm run test:e2e

echo "== 3. prove the tested commit did not move"
verify_pushed_candidate

cat <<'EOF'

Prepared only; this helper did not deploy or change a provider.
Next: open the GitHub pull request, review its preview, and merge it into main.
Vercel then builds the exact GitHub main commit.
EOF
