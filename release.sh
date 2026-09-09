#!/usr/bin/env bash
#
# release.sh — full release pipeline for browser-ai-engine.
#
#   ./release.sh [patch|minor|major|X.Y.Z] [--dry-run] [--otp=CODE]
#
# 2FA: if your npm account requires a one-time password, pass it explicitly
# (`--otp=123456`) or via the NPM_OTP environment variable. The script never
# prompts — it fails fast instead.
#
# What it does (in order, stops on first failure):
#   1. Preflight: git clean tree, gh + npm auth, node_modules present.
#   2. Checks: typecheck, tests, build, docs build.
#   3. Version: bump package.json (patch/minor/major/X.Y.Z) or keep current.
#   4. CHANGELOG.md: prepend a new section from commits since the last tag.
#   5. Commit + annotated tag vX.Y.Z (skipped in --dry-run).
#   6. Push branch + tag to origin.
#   7. npm publish --access public.
#   8. GitHub release via gh (notes = CHANGELOG section).
#
# Non-interactive: safe to run from CI or by an agent. No prompts, no force-push.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

BUMP=""
DRY_RUN=0
NPM_OTP="${NPM_OTP:-}"
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --otp=*) NPM_OTP="${arg#--otp=}" ;;
    patch|minor|major) BUMP="$arg" ;;
    [0-9]*.[0-9]*.[0-9]*) BUMP="exact:$arg" ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *) echo "error: unknown argument '$arg' (see --help)" >&2; exit 1 ;;
  esac
done

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "error: '$1' not found in PATH" >&2; exit 1; }
}
need git
need node
need npm
need gh

# -- preflight ---------------------------------------------------------------

if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree is not clean — commit or stash first:" >&2
  git status --short >&2
  exit 1
fi

BRANCH="$(git branch --show-current)"
echo "==> branch: $BRANCH"

gh auth status >/dev/null 2>&1 || { echo "error: 'gh auth status' failed — run 'gh auth login'" >&2; exit 1; }
echo "==> gh auth: ok ($(gh api user -q .login 2>/dev/null || echo '?'))"

NPM_USER="$(npm whoami 2>/dev/null || true)"
[ -n "$NPM_USER" ] || { echo "error: npm not logged in — run 'npm login'" >&2; exit 1; }
echo "==> npm auth: ok ($NPM_USER)"

[ -d node_modules ] || { echo "error: node_modules missing — run 'npm ci'" >&2; exit 1; }

# -- checks -------------------------------------------------------------------

echo "==> typecheck"; npm run -s typecheck
echo "==> tests"; npm run -s test
echo "==> build"; npm run -s build
echo "==> docs build"; npm run -s docs:build

# -- version --------------------------------------------------------------------

CURRENT="$(node -p "require('./package.json').version")"
if [ -z "$BUMP" ]; then
  VERSION="$CURRENT"
  echo "==> version: keeping $VERSION (no bump argument)"
elif [[ "$BUMP" == exact:* ]]; then
  VERSION="${BUMP#exact:}"
  npm version --no-git-tag-version "$VERSION" >/dev/null
  echo "==> version: $CURRENT -> $VERSION"
else
  VERSION="$(npm version --no-git-tag-version "$BUMP" | sed 's/^v//')"
  echo "==> version: $CURRENT -> $VERSION"
fi
TAG="v$VERSION"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "error: tag $TAG already exists" >&2
  exit 1
fi

# -- changelog --------------------------------------------------------------------

LAST_TAG="$(git describe --tags --abbrev=0 2>/dev/null || true)"
if [ -n "$LAST_TAG" ]; then RANGE="$LAST_TAG..HEAD"; else RANGE="HEAD"; fi
COMMITS="$(git log "$RANGE" --pretty=format:'- %s (%h)' --no-merges || true)"
[ -n "$COMMITS" ] || COMMITS="- Maintenance."

TODAY="$(date +%Y-%m-%d)"
SECTION="## [$VERSION] - $TODAY"$'\n'"$COMMITS"$'\n'

if [ ! -f CHANGELOG.md ]; then
  printf '# Changelog\n\n%s' "$SECTION" > CHANGELOG.md
elif grep -q "^## \[$VERSION\]" CHANGELOG.md; then
  echo "==> CHANGELOG already has [$VERSION], leaving it"
else
  TMP="$(mktemp)"
  {
    sed -n '1p' CHANGELOG.md
    echo
    printf '%s' "$SECTION"
    tail -n +2 CHANGELOG.md
  } > "$TMP"
  mv "$TMP" CHANGELOG.md
fi
echo "==> CHANGELOG.md updated"

NOTES_FILE="$(mktemp)"
awk -v ver="$VERSION" '
  $0 ~ "^## \\[" ver "\\]" { in_section=1; next }
  in_section && /^## / { exit }
  in_section { print }
' CHANGELOG.md | sed '/^[[:space:]]*$/d' > "$NOTES_FILE"
[ -s "$NOTES_FILE" ] || echo "- Release $VERSION." > "$NOTES_FILE"

# -- commit + tag -------------------------------------------------------------------

if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -m "chore(release): $TAG" >/dev/null
  echo "==> committed: chore(release): $TAG"
else
  echo "==> nothing new to commit"
fi
git tag -a "$TAG" -m "Release $TAG"
echo "==> tagged $TAG"

if [ "$DRY_RUN" = 1 ]; then
  echo "==> --dry-run: deleting local tag, stopping before push/publish"
  git tag -d "$TAG" >/dev/null
  git reset --soft HEAD~1 >/dev/null 2>&1 || true
  echo "DRY RUN OK (release notes preview):"
  cat "$NOTES_FILE"
  exit 0
fi

# -- push / publish / release ----------------------------------------------------------

echo "==> git push origin $BRANCH"
git push origin "$BRANCH"
echo "==> git push origin $TAG"
git push origin "$TAG"

echo "==> npm publish"
if [ -n "$NPM_OTP" ]; then
  npm publish --access public --otp="$NPM_OTP"
else
  npm publish --access public
fi

echo "==> gh release create $TAG"
gh release create "$TAG" --title "$TAG" --notes-file "$NOTES_FILE"

rm -f "$NOTES_FILE"
echo "RELEASED $TAG 🎉"
echo "  npm:    https://www.npmjs.com/package/browser-ai-engine"
echo "  github: https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/tag/$TAG"
