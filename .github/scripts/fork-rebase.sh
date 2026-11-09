#!/usr/bin/env bash
# Fork-only. Rebase the checked-out branch onto $1 (e.g. upstream/main).
#
# A conflict confined to pnpm-lock.yaml is resolved by regenerating the
# lockfile: keep the side already rebased (upstream plus the fork commits
# replayed so far), then let pnpm re-resolve it against the replayed commit's
# package.json and pnpm-workspace.yaml (where the fork's overrides live).
# Any other conflict aborts the rebase.
#
# Exit status: 0 rebased, 1 aborted on a conflict pnpm cannot settle.
# Conflicted paths of an aborted rebase are written to $CONFLICT_FILES when set.
set -euo pipefail

onto="$1"

lockfile_only_conflict() {
  [ "$(git diff --name-only --diff-filter=U)" = "pnpm-lock.yaml" ]
}

if git rebase "$onto"; then
  exit 0
fi

while true; do
  if ! lockfile_only_conflict; then
    if [ -n "${CONFLICT_FILES:-}" ]; then
      git diff --name-only --diff-filter=U > "$CONFLICT_FILES"
    fi
    git rebase --abort || true
    exit 1
  fi

  echo "Regenerating pnpm-lock.yaml for $(git log -1 --format='%h %s' REBASE_HEAD)"
  git checkout --ours -- pnpm-lock.yaml
  pnpm install --lockfile-only --ignore-scripts
  git add pnpm-lock.yaml

  if git diff --cached --quiet; then
    # The replayed commit changed nothing beyond what upstream already has.
    step=(git rebase --skip)
  else
    step=(git -c core.editor=true rebase --continue)
  fi
  if "${step[@]}"; then
    exit 0
  fi
  # Stopped again on a later commit; loop to inspect its conflict. A failure
  # that left no rebase in progress is not something this script understands.
  if [ ! -d "$(git rev-parse --git-path rebase-merge)" ] &&
    [ ! -d "$(git rev-parse --git-path rebase-apply)" ]; then
    exit 1
  fi
done
