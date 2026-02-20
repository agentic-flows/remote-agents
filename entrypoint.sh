#!/bin/bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Container entrypoint for remote opencode agents
#
# Required env vars:
#   REPO_URL        — git clone URL (e.g. https://github.com/org/repo.git)
#   BRANCH_NAME     — branch to checkout or create
#
# Optional env vars:
#   ISSUE_ID        — lb issue ID to claim (e.g. AGE-42)
#   OPENCODE_PORT   — port for opencode serve (default: 4096)
#   GH_TOKEN        — GitHub personal access token for gh auth + git push
#   LINEAR_API_KEY  — Linear API key for lb sync
#   GIT_AUTHOR_NAME — git commit author name
#   GIT_AUTHOR_EMAIL— git commit author email
# ---------------------------------------------------------------------------

OPENCODE_PORT="${OPENCODE_PORT:-4096}"
WORKSPACE="/home/user/workspace"

echo "[entrypoint] Starting container setup..."

# ---------------------------------------------------------------------------
# 1. Configure git identity
# ---------------------------------------------------------------------------
if [[ -n "${GIT_AUTHOR_NAME:-}" ]]; then
  git config --global user.name "$GIT_AUTHOR_NAME"
  echo "[entrypoint] git user.name = $GIT_AUTHOR_NAME"
fi

if [[ -n "${GIT_AUTHOR_EMAIL:-}" ]]; then
  git config --global user.email "$GIT_AUTHOR_EMAIL"
  echo "[entrypoint] git user.email = $GIT_AUTHOR_EMAIL"
fi

# Allow git to operate in the workspace directory
git config --global --add safe.directory "$WORKSPACE"

# ---------------------------------------------------------------------------
# 2. Authenticate gh with GH_TOKEN
# ---------------------------------------------------------------------------
if [[ -n "${GH_TOKEN:-}" ]]; then
  echo "[entrypoint] Authenticating gh..."
  echo "$GH_TOKEN" | gh auth login --with-token
  gh auth status
else
  echo "[entrypoint] WARNING: GH_TOKEN not set — gh auth skipped"
fi

# ---------------------------------------------------------------------------
# 3. Clone the repository
# ---------------------------------------------------------------------------
if [[ -z "${REPO_URL:-}" ]]; then
  echo "[entrypoint] ERROR: REPO_URL is required" >&2
  exit 1
fi

echo "[entrypoint] Cloning $REPO_URL..."
if [[ -n "${GH_TOKEN:-}" ]]; then
  # Embed token into URL for HTTPS auth
  AUTHED_URL="${REPO_URL/https:\/\//https:\/\/$GH_TOKEN@}"
  git clone "$AUTHED_URL" "$WORKSPACE" || {
    echo "[entrypoint] ERROR: git clone failed" >&2
    exit 1
  }
else
  git clone "$REPO_URL" "$WORKSPACE" || {
    echo "[entrypoint] ERROR: git clone failed" >&2
    exit 1
  }
fi

cd "$WORKSPACE"
echo "[entrypoint] Cloned successfully"

# ---------------------------------------------------------------------------
# 4. Checkout or create the branch
# ---------------------------------------------------------------------------
if [[ -n "${BRANCH_NAME:-}" ]]; then
  echo "[entrypoint] Setting up branch: $BRANCH_NAME"
  if git ls-remote --exit-code --heads origin "$BRANCH_NAME" &>/dev/null; then
    # Branch exists on remote — check it out
    git checkout -b "$BRANCH_NAME" "origin/$BRANCH_NAME"
    echo "[entrypoint] Checked out existing branch: $BRANCH_NAME"
  else
    # Branch doesn't exist — create it
    git checkout -b "$BRANCH_NAME"
    echo "[entrypoint] Created new branch: $BRANCH_NAME"
  fi
else
  echo "[entrypoint] WARNING: BRANCH_NAME not set — staying on default branch"
fi

# ---------------------------------------------------------------------------
# 5. Set up lb and sync issues (if LINEAR_API_KEY is set)
# ---------------------------------------------------------------------------
if [[ -n "${LINEAR_API_KEY:-}" ]]; then
  echo "[entrypoint] Setting up lb..."
  export LINEAR_API_KEY

  # Run lb onboard non-interactively (config.jsonc already in repo)
  if [[ -f ".lb/config.jsonc" ]]; then
    echo "[entrypoint] Found .lb/config.jsonc — running lb onboard"
    lb onboard --non-interactive 2>/dev/null || lb onboard || true
  else
    echo "[entrypoint] WARNING: .lb/config.jsonc not found — skipping lb onboard"
  fi

  echo "[entrypoint] Running lb sync..."
  lb sync 2>&1 || {
    echo "[entrypoint] WARNING: lb sync failed — continuing anyway (outbox will retry)"
  }

  # Claim the issue if ISSUE_ID is provided
  if [[ -n "${ISSUE_ID:-}" ]]; then
    echo "[entrypoint] Claiming issue $ISSUE_ID..."
    lb update "$ISSUE_ID" --status in_progress 2>&1 || {
      echo "[entrypoint] WARNING: Failed to claim $ISSUE_ID — continuing"
    }
  fi
else
  echo "[entrypoint] WARNING: LINEAR_API_KEY not set — lb setup skipped"
fi

# ---------------------------------------------------------------------------
# 6. Start opencode serve
# ---------------------------------------------------------------------------
echo "[entrypoint] Starting opencode serve on port $OPENCODE_PORT..."
exec opencode serve --port "$OPENCODE_PORT" --hostname 0.0.0.0
