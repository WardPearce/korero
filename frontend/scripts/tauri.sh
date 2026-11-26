#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

if [[ $(uname -s) == Linux ]]; then
  # cef-dll-sys copies the runtime beside the executable using Cargo's legacy layout.
  export __CARGO_TEMPORARY_BUILD_DIR_NEW_LAYOUT_OPT_OUT=1

  local_gtk_lib="$root/.native/gtk4-fedora/usr/lib64"
  if [[ -f $local_gtk_lib/pkgconfig/gtk4.pc ]] && ! pkg-config --exists 'gtk4 >= 4.14'; then
    export PKG_CONFIG_PATH="$local_gtk_lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
    export LIBRARY_PATH="$local_gtk_lib${LIBRARY_PATH:+:$LIBRARY_PATH}"
  fi
fi

case ${1:-} in
  dev|build)
    if [[ $(uname -sm) == 'Linux x86_64' ]]; then
      bash scripts/prepare-media.sh --if-needed
    fi
    if [[ $(uname -s) == Linux && $1 == dev ]]; then
      bun run build:browser-media
    fi
    ;;
esac

if [[ $(uname -s) == Linux && ${1:-} =~ ^(build|bundle)$ ]]; then
  for option in "$@"; do
    case $option in
      --no-bundle|-h|--help|-V|--version) exec ./node_modules/.bin/tauri "$@" ;;
    esac
  done

  # Tauri #16338 removes the ANGLE files that the published alpha bundler still expects.
  revision=6620118f0fe85472abfdccea8d99fd0ec9447c3f
  cli_dir="$root/.native/tauri-cli-$revision"
  if [[ ! -x $cli_dir/bin/cargo-tauri ]]; then
    source_dir=$(mktemp -d)
    trap 'rm -rf "$source_dir"' EXIT
    curl --fail --location --retry 2 \
      "https://codeload.github.com/tauri-apps/tauri/tar.gz/$revision" -o "$source_dir/tauri.tar.gz"
    printf '%s  %s\n' 25e10acaa86ecd96d8ae65c2cfb8ed073b7609221822e7c1a8b969e5f7d6e6b8 "$source_dir/tauri.tar.gz" |
      sha256sum --check --status
    tar -xzf "$source_dir/tauri.tar.gz" --strip-components=1 -C "$source_dir"
    cargo install --locked --path "$source_dir/crates/tauri-cli" --root "$cli_dir"
    rm -rf "$source_dir"
    trap - EXIT
  fi

  # Tauri #16204. quick-sharun still uses two helpers removed from its upstream branch.
  sharun_tools=https://raw.githubusercontent.com/pkgforge-dev/Anylinux-AppImages/5e76c43e12c20ccb2f705c6098ca141b2fd368f8/useful-tools
  export ANYLINUX_LIB_SOURCE="${ANYLINUX_LIB_SOURCE:-$sharun_tools/lib/anylinux.c}"
  export GTK_CLASS_FIX_SOURCE="${GTK_CLASS_FIX_SOURCE:-$sharun_tools/lib/gtk-class-fix.c}"
  # quick-sharun's default /usr/lib misses the dynamic loader on Fedora.
  if [[ -z ${LIB_DIR:-} ]] && gtk_libdir=$(pkg-config --variable=libdir gtk4); then
    export LIB_DIR="$gtk_libdir"
  fi
  exec "$cli_dir/bin/cargo-tauri" "$@"
fi

exec ./node_modules/.bin/tauri "$@"
