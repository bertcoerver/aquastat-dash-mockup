#!/usr/bin/env bash
# Build the site for GitHub Pages and publish it as the gh-pages branch (one commit,
# force-pushed, so the branch never grows a history of builds).
#
#   deploy-pages.sh           the working tree as it is, uncommitted changes included
#   deploy-pages.sh <commit>  that commit (what the pre-push hook does)
#
# Built here rather than on GitHub because the tiles and the model output are not
# committed (see .gitignore): it publishes those from public/ on this machine.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(git -C "$ROOT" rev-parse --show-toplevel)"
REMOTE="$(git -C "$ROOT" remote get-url origin)"
# The site is served from https://<owner>.github.io/<repo>/
REPO="$(basename "$REMOTE" .git)"
COMMIT="${1:-}"

TMP="$(mktemp -d)"
cleanup() {
  [ -n "$COMMIT" ] && git -C "$REPO_ROOT" worktree remove --force "$TMP/src" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

if [ -n "$COMMIT" ]; then
  # A clean checkout of the commit, with this machine's dependencies and uncommitted data
  git -C "$REPO_ROOT" worktree add -q --detach "$TMP/src" "$COMMIT"
  BUILD="$TMP/src/${ROOT#"$REPO_ROOT"/}"
  ln -s "$ROOT/node_modules" "$BUILD/node_modules"
  ln -s "$ROOT/public/tiles" "$BUILD/public/tiles"
  ln -s "$ROOT/public/data/model" "$BUILD/public/data/model"
  LABEL="$(git -C "$REPO_ROOT" rev-parse --short "$COMMIT")"
else
  BUILD="$ROOT"
  LABEL="$(git -C "$ROOT" rev-parse --short HEAD)$(git -C "$ROOT" diff --quiet HEAD || echo '+changes')"
fi

DIST="$TMP/dist"
(cd "$BUILD" && npm run build -- --base="/$REPO/" --outDir="$DIST" --emptyOutDir)
# No Jekyll: serve the files as they are
touch "$DIST/.nojekyll"

export GIT_DIR="$TMP/git" GIT_WORK_TREE="$DIST"
git init -q -b gh-pages
git add -A
git -c user.name="$(git -C "$ROOT" config user.name)" -c user.email="$(git -C "$ROOT" config user.email)" \
  commit -q -m "Deploy $LABEL"
git push -q -f "$REMOTE" gh-pages

echo "Published $LABEL: https://$(basename "$(dirname "$REMOTE")" | sed 's/.*://').github.io/$REPO/"
