#!/usr/bin/env bash
# Freehold installer — designed to be piped to bash:
#
#   curl -fsSL https://raw.githubusercontent.com/yourbuddyconner/freehold/main/install.sh | bash
#
# Downloads the prebuilt freehold release for this machine from GitHub
# Releases and installs it. The release is a tarball containing the
# single-file binary plus its PGlite sidecar files; they are unpacked to
# a lib directory and a small wrapper goes on your PATH.
#
# Configuration (env vars):
#   FREEHOLD_VERSION      Release tag to install (default: latest).
#                         "0.1.0" is accepted as shorthand for "v0.1.0".
#   FREEHOLD_BIN_DIR      Where the `freehold` wrapper goes
#                         (default: ~/.local/bin).
#   FREEHOLD_LIB_DIR      Where the binary + sidecars live
#                         (default: ~/.local/share/freehold).
#
# Non-interactive by design: no prompts (stdin belongs to the pipe).
set -euo pipefail

REPO="yourbuddyconner/freehold"
TAG="${FREEHOLD_VERSION:-latest}"
BIN_DIR="${FREEHOLD_BIN_DIR:-$HOME/.local/bin}"
LIB_DIR="${FREEHOLD_LIB_DIR:-$HOME/.local/share/freehold}"

# Accept "0.1.0" as shorthand for "v0.1.0".
case "$TAG" in
  latest|v*) ;;
  [0-9]*) TAG="v${TAG}" ;;
esac

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *)
    echo "error: unsupported OS '$(uname -s)' — Freehold ships macOS and Linux binaries." >&2
    echo "       On Windows, run the linux-x64 binary under WSL." >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *)
    echo "error: unsupported architecture '$(uname -m)'." >&2
    exit 1
    ;;
esac

asset="freehold-${os}-${arch}.tar.gz"
if [ "$TAG" = "latest" ]; then
  url="https://github.com/${REPO}/releases/latest/download/${asset}"
else
  url="https://github.com/${REPO}/releases/download/${TAG}/${asset}"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading ${asset} (${TAG})..."
if ! curl -fL --progress-bar -o "${tmp}/${asset}" "$url"; then
  echo "error: download failed: $url" >&2
  echo "       Check that release '${TAG}' exists and has a ${asset} asset:" >&2
  echo "       https://github.com/${REPO}/releases" >&2
  exit 1
fi

mkdir -p "${tmp}/pkg"
tar -xzf "${tmp}/${asset}" -C "${tmp}/pkg"
chmod +x "${tmp}/pkg/freehold"

# Sanity-check before installing: the binary must at least run --version.
if ! version="$("${tmp}/pkg/freehold" --version 2>/dev/null)"; then
  echo "error: downloaded binary failed to execute on this machine." >&2
  exit 1
fi

# Install the binary + sidecars, replacing any previous version.
rm -rf "$LIB_DIR"
mkdir -p "$LIB_DIR"
mv "${tmp}/pkg/"* "$LIB_DIR/"

# The binary finds its sidecar files next to itself, so PATH gets a
# wrapper that execs the real binary from the lib directory.
mkdir -p "$BIN_DIR"
cat > "${BIN_DIR}/freehold" <<WRAPPER
#!/bin/sh
exec "${LIB_DIR}/freehold" "\$@"
WRAPPER
chmod +x "${BIN_DIR}/freehold"

echo "Installed ${version} (${TAG}) to ${LIB_DIR}"
echo "Command: ${BIN_DIR}/freehold"

case ":$PATH:" in
  *":${BIN_DIR}:"*) ;;
  *)
    echo ""
    echo "note: ${BIN_DIR} is not on your PATH. Add it, e.g.:"
    echo "  export PATH=\"${BIN_DIR}:\$PATH\""
    ;;
esac

echo ""
echo "Get started:  freehold serve"
