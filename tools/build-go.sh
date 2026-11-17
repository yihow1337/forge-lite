#!/bin/bash
# tools/build-go.sh -- build the forge binary main.ts launches, and check it against the rules.
#
# The entry runs from a read-only mount with no toolchain and no network, so the binary is built
# here and committed. The rules allow exactly that ("a statically linked Linux amd64 binary you
# commit runs from your repository as vendored source") and cap one file at 8 MiB, so this script
# refuses to leave a binary that would be rejected.
#
#   tools/build-go.sh            build, verify, report the size
#   tools/build-go.sh --check    verify the committed binary matches the sources, build nothing
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$REPO/bin/forge"
MAX_BYTES=$((8 * 1024 * 1024))

GO=${GO:-/usr/local/bin/go}
command -v "$GO" >/dev/null 2>&1 || GO=go
command -v "$GO" >/dev/null 2>&1 || { echo "build-go: no go toolchain on PATH" >&2; exit 1; }

cd "$REPO/go"
"$GO" vet ./... >/dev/null
test -z "$(gofmt -l .)" || { echo "build-go: gofmt wants changes in: $(gofmt -l .)" >&2; exit 1; }

if [[ "${1:-}" == "--check" ]]; then
  TMP="$(mktemp /tmp/forge-check.XXXX)"
  trap 'rm -f "$TMP"' EXIT
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 "$GO" build -trimpath -ldflags="-s -w" -o "$TMP" .
  if cmp -s "$TMP" "$OUT"; then
    echo "build-go: bin/forge is up to date ($(stat -c %s "$OUT") bytes)"
  else
    echo "build-go: bin/forge is stale -- run tools/build-go.sh" >&2
    exit 1
  fi
  exit 0
fi

mkdir -p "$REPO/bin"
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 "$GO" build -trimpath -ldflags="-s -w" -o "$OUT" .
chmod 755 "$OUT"

SIZE="$(stat -c %s "$OUT")"
if (( SIZE > MAX_BYTES )); then
  echo "build-go: bin/forge is $SIZE bytes, past the ${MAX_BYTES}-byte per-file limit" >&2
  exit 1
fi

# A dynamically linked binary would not run in the trial pod; CGO_ENABLED=0 should rule it out,
# but the check costs nothing and the failure mode is a zero score. `file` is not everywhere, so
# this reads the ELF magic and looks for the dynamic loader a linked binary would name.
head -c 4 "$OUT" | LC_ALL=C grep -q $'\x7fELF' || { echo "build-go: bin/forge is not an ELF binary" >&2; exit 1; }
if LC_ALL=C grep -qa 'ld-linux' "$OUT"; then
  echo "build-go: bin/forge names a dynamic loader, so it is not statically linked" >&2
  exit 1
fi

echo "build-go: bin/forge $SIZE bytes ($(( (MAX_BYTES - SIZE) / 1024 )) KiB of headroom)"
