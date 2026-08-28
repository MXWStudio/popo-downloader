#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "Run this command from inside the POPO Git working tree." >&2
  exit 1
}

host=${POPO_WINDOWS_HOST:-edy-main}
remote_root=${POPO_WINDOWS_REMOTE_ROOT:-/d/POPODevValidation}
sync_extension=1

if [[ ${1:-} == "--no-sync" ]]; then
  sync_extension=0
  shift
fi
if [[ $# -ne 0 ]]; then
  echo "Usage: npm run verify:windows:remote -- [--no-sync]" >&2
  exit 1
fi
if [[ ! $remote_root =~ ^/[A-Za-z]/([^/]+/)*POPODevValidation$ ]]; then
  echo "Refusing unsafe Windows validation root: $remote_root" >&2
  echo "The path must be a drive-scoped directory named POPODevValidation." >&2
  exit 1
fi
if [[ -n $(git -C "$repo_root" diff --name-only --diff-filter=U) ]]; then
  echo "Refusing to snapshot a working tree with unresolved conflicts." >&2
  exit 1
fi

scratch=$(mktemp -d "${TMPDIR:-/tmp}/popo-windows-validation.XXXXXX")
cleanup() {
  rm -rf "$scratch"
}
trap cleanup EXIT

base_commit=$(git -C "$repo_root" rev-parse HEAD)
token="$(date -u +%Y%m%dT%H%M%SZ)-${base_commit:0:12}-$RANDOM"
bundle="$scratch/source.bundle"
patch="$scratch/working-tree.patch"
untracked_list="$scratch/untracked-files"
untracked_archive="$scratch/untracked-files.tar.gz"
origin_url=$(git -C "$repo_root" remote get-url origin)
source_kind=origin

if [[ ! $origin_url =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\.git$ ]]; then
  echo "Refusing unsupported origin URL for remote validation: $origin_url" >&2
  exit 1
fi
if ! git -C "$repo_root" for-each-ref --format='%(refname)' --contains "$base_commit" refs/remotes/origin/ | grep -q .; then
  source_kind=bundle
  git -C "$repo_root" bundle create "$bundle" HEAD
fi
git -C "$repo_root" diff --binary --full-index HEAD -- . >"$patch"
git -C "$repo_root" ls-files --others --exclude-standard -z >"$untracked_list"
if [[ -s $untracked_list ]]; then
  COPYFILE_DISABLE=1 tar --format ustar --no-xattrs -C "$repo_root" --null -czf "$untracked_archive" -T "$untracked_list"
else
  COPYFILE_DISABLE=1 tar --format ustar --no-xattrs -czf "$untracked_archive" --files-from /dev/null
fi

echo "Preparing isolated Windows validation snapshot: $token"
ssh -o BatchMode=yes "$host" \
  "mkdir -p '$remote_root/incoming' && test ! -e '$remote_root/incoming/$token.working-tree.patch'"
ssh -o BatchMode=yes "$host" \
  "cat > '$remote_root/incoming/$token.working-tree.patch'" <"$patch"
ssh -o BatchMode=yes "$host" \
  "cat > '$remote_root/incoming/$token.untracked-files.tar.gz'" <"$untracked_archive"
if [[ $source_kind == bundle ]]; then
  ssh -o BatchMode=yes "$host" \
    "cat > '$remote_root/incoming/$token.source.bundle'" <"$bundle"
fi

ssh -o BatchMode=yes "$host" \
  bash -s -- "$remote_root" "$token" "$base_commit" "$sync_extension" "$source_kind" "$origin_url" \
  <"$repo_root/scripts/windows-remote-runner.sh"
