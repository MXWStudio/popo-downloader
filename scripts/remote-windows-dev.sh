#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "Run this command from inside the POPO Git working tree." >&2
  exit 1
}

host=${POPO_WINDOWS_HOST:-edy-main}
remote_root=${POPO_WINDOWS_REMOTE_ROOT:-/d/POPODevValidation}
sync_extension=1
build_dev_package=${POPO_WINDOWS_BUILD_DEV_PACKAGE:-0}
install_dev_package=${POPO_WINDOWS_INSTALL_DEV_PACKAGE:-0}
source_mode=${POPO_WINDOWS_SOURCE_MODE:-auto}
dev_target='D:\POPODevDownloader\Extension'
base_commit=$(git -C "$repo_root" rev-parse HEAD)
dirty_changes=NO
if [[ -n $(git -C "$repo_root" status --porcelain --untracked-files=normal) ]]; then
  dirty_changes=YES
fi
scratch=""
remote_log=""

print_summary() {
  local status=$1
  local verify_status=FAIL
  local windows_tests=FAIL
  local dev_sync='NOT RUN'
  local dev_install='NOT REQUESTED'
  if [[ $status -eq 0 ]]; then verify_status=PASS; fi
  if [[ -n $remote_log && -f $remote_log ]] && grep -q 'POPO_WINDOWS_TESTS=PASS' "$remote_log"; then
    windows_tests=PASS
  fi
  if [[ $sync_extension -eq 0 ]]; then
    dev_sync='NOT REQUESTED'
  elif [[ -n $remote_log && -f $remote_log ]] && grep -q 'POPO_DEV_SYNC=PASS' "$remote_log"; then
    dev_sync=PASS
  elif [[ $windows_tests == PASS ]]; then
    dev_sync=FAIL
  fi
  if [[ $install_dev_package == 1 ]]; then
    dev_install=FAIL
    if [[ -n $remote_log && -f $remote_log ]] && grep -q 'POPO_DEV_INSTALL=PASS' "$remote_log"; then
      dev_install=PASS
    fi
  fi

  echo
  echo "WINDOWS VERIFY: $verify_status"
  echo "SOURCE: Mac working tree"
  echo "MAC COMMIT: $base_commit"
  echo "DIRTY CHANGES: $dirty_changes"
  echo "WINDOWS TESTS: $windows_tests"
  echo "DEV PACKAGE INSTALL: $dev_install"
  echo "DEV SYNC: $dev_sync"
  echo "DEV TARGET: $dev_target"
  echo "STABLE TOUCHED: NO"
  echo
  echo "NEXT:"
  if [[ $dev_sync == PASS ]]; then
    echo 'Reload "POPO Dev 下载助手" in chrome://extensions'
    echo 'Refresh the POPO page, then run: npm run smoke:windows'
  elif [[ $dev_sync == 'NOT REQUESTED' && $verify_status == PASS ]]; then
    echo 'No Dev reload is required because --no-sync was used.'
  else
    echo 'Review the failure above; Dev was not partially synchronized.'
  fi
}

finish() {
  local status=$?
  trap - EXIT
  print_summary "$status"
  if [[ -n $scratch && -d $scratch ]]; then rm -rf "$scratch"; fi
  exit "$status"
}
trap finish EXIT

if [[ ${1:-} == "--no-sync" ]]; then
  sync_extension=0
  shift
fi
if [[ $# -ne 0 ]]; then
  echo "Usage: npm run verify:windows:remote -- [--no-sync]" >&2
  exit 1
fi
if [[ $build_dev_package != 0 && $build_dev_package != 1 ]]; then
  echo "POPO_WINDOWS_BUILD_DEV_PACKAGE must be 0 or 1." >&2
  exit 1
fi
if [[ $install_dev_package != 0 && $install_dev_package != 1 ]]; then
  echo "POPO_WINDOWS_INSTALL_DEV_PACKAGE must be 0 or 1." >&2
  exit 1
fi
if [[ $install_dev_package == 1 && $build_dev_package != 1 ]]; then
  echo "POPO_WINDOWS_INSTALL_DEV_PACKAGE=1 requires POPO_WINDOWS_BUILD_DEV_PACKAGE=1." >&2
  exit 1
fi
if [[ $source_mode != auto && $source_mode != bundle ]]; then
  echo "POPO_WINDOWS_SOURCE_MODE must be auto or bundle." >&2
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
remote_log="$scratch/windows-validation.log"
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
if [[ $source_mode == bundle ]] ||
  ! git -C "$repo_root" for-each-ref --format='%(refname)' --contains "$base_commit" refs/remotes/origin/ | grep -q .; then
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
  bash -s -- "$remote_root" "$token" "$base_commit" "$sync_extension" "$source_kind" "$origin_url" "$build_dev_package" "$install_dev_package" \
  <"$repo_root/scripts/windows-remote-runner.sh" | tee "$remote_log"
