#!/usr/bin/env bash
set -euo pipefail

remote_root=${1:-}
token=${2:-}
base_commit=${3:-}
sync_extension=${4:-}
source_kind=${5:-}
origin_url=${6:-}
build_dev_package=${7:-0}
install_dev_package=${8:-0}

if [[ ! $remote_root =~ ^/[A-Za-z]/([^/]+/)*POPODevValidation$ ]]; then
  echo "Refusing unsafe Windows validation root: $remote_root" >&2
  exit 1
fi
if [[ ! $token =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}-[0-9]+$ ]]; then
  echo "Refusing invalid validation token: $token" >&2
  exit 1
fi
if [[ ! $base_commit =~ ^[0-9a-f]{40}$ ]]; then
  echo "Refusing invalid Git commit: $base_commit" >&2
  exit 1
fi
if [[ $sync_extension != 0 && $sync_extension != 1 ]]; then
  echo "Refusing invalid sync flag: $sync_extension" >&2
  exit 1
fi
if [[ $source_kind != origin && $source_kind != bundle ]]; then
  echo "Refusing invalid source kind: $source_kind" >&2
  exit 1
fi
if [[ ! $origin_url =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\.git$ ]]; then
  echo "Refusing unsupported origin URL: $origin_url" >&2
  exit 1
fi
if [[ $build_dev_package != 0 && $build_dev_package != 1 ]]; then
  echo "Refusing invalid Dev package flag: $build_dev_package" >&2
  exit 1
fi
if [[ $install_dev_package != 0 && $install_dev_package != 1 ]]; then
  echo "Refusing invalid Dev install flag: $install_dev_package" >&2
  exit 1
fi
if [[ $install_dev_package == 1 && $build_dev_package != 1 ]]; then
  echo "Refusing Dev install without a Dev package build." >&2
  exit 1
fi

incoming="$remote_root/incoming"
bundle="$incoming/$token.source.bundle"
patch="$incoming/$token.working-tree.patch"
untracked_archive="$incoming/$token.untracked-files.tar.gz"
run_root="$remote_root/runs/$token"
source_root="$run_root/source"

required_inputs=("$patch" "$untracked_archive")
if [[ $source_kind == bundle ]]; then
  required_inputs+=("$bundle")
fi
for required in "${required_inputs[@]}"; do
  if [[ ! -f $required ]]; then
    echo "Validation input is missing: $required" >&2
    exit 1
  fi
done
if [[ -e $run_root ]]; then
  echo "Refusing to replace an existing validation run: $run_root" >&2
  exit 1
fi

mkdir -p "$run_root"
if [[ $source_kind == origin ]]; then
  GIT_TERMINAL_PROMPT=0 git clone --quiet --no-checkout "$origin_url" "$source_root"
else
  git clone --quiet "$bundle" "$source_root"
fi
git -C "$source_root" checkout --quiet --detach "$base_commit"
if [[ -s $patch ]]; then
  git -C "$source_root" apply --whitespace=nowarn "$patch"
fi
tar -xzf "$untracked_archive" -C "$source_root"

repo_windows=$(cygpath -w "$source_root")
validator_windows=$(cygpath -w "$source_root/scripts/windows-dev-validate.ps1")
log_path="$run_root/validation.log"
validator_args=()
if [[ $sync_extension == 0 ]]; then
  validator_args+=("-NoSync")
fi
if [[ $build_dev_package == 1 ]]; then
  validator_args+=("-BuildDevPackage")
fi
if [[ $install_dev_package == 1 ]]; then
  validator_args+=("-InstallDevPackage")
fi

set +e
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$validator_windows" \
  -RepoRoot "$repo_windows" "${validator_args[@]}" 2>&1 | tee "$log_path"
status=${PIPESTATUS[0]}
set -e

rm -f "$bundle" "$patch" "$untracked_archive"
if [[ $status -ne 0 ]]; then
  echo "Windows validation failed. Remote evidence kept at: $run_root" >&2
  exit "$status"
fi

rm -rf "$run_root"
echo "Windows validation passed: $token"
