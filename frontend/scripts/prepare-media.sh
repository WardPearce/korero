#!/usr/bin/env bash
set -euo pipefail

if [[ $(uname -sm) != 'Linux x86_64' ]]; then
  echo 'The prepared native media SDK currently targets Linux x86_64.' >&2
  exit 1
fi

root=$(cd "$(dirname "$0")/.." && pwd)
sdk=${KORERO_MEDIA_SDK:-"$root/.native/m140-linux-x86_64"}
if [[ ${1:-} == --if-needed ]] &&
  [[ -f $sdk/lib/libmediasoupclient.a && -f $sdk/lib/libsdptransform.a &&
     -f $sdk/lib/libwebrtc.a && -f $sdk/field_trials.cc &&
     -f $sdk/libcxx-config/__config_site && -f $sdk/libcxx-config/__assertion_handler &&
     -f $sdk/libcxx/include/__config && -f $sdk/libsdptransform/include/json.hpp &&
     -f $sdk/libmediasoupclient/include/mediasoupclient.hpp &&
     -f $sdk/webrtc/include/api/peer_connection_interface.h ]]; then
  exit 0
fi

compiler=${CXX:-clang++}
if [[ -z ${CXX:-} && -x $root/.native/toolchain/bin/clang++ ]]; then
  compiler="$root/.native/toolchain/bin/clang++"
fi
if ! command -v "$compiler" >/dev/null; then
  printf 'Clang C++ compiler not found (%s). Install Clang or set CXX to its path.\n' "$compiler" >&2
  exit 1
fi

mkdir -p "$sdk/lib" "$sdk/webrtc" "$sdk/libcxx-config"
sdk=$(cd "$sdk" && pwd)

fetch() {
  local url=$1 output=$2 checksum=$3
  if ! printf '%s  %s\n' "$checksum" "$output" | sha256sum --check --status; then
    curl --fail --location --retry 2 "$url" -o "$output.partial"
    printf '%s  %s\n' "$checksum" "$output.partial" | sha256sum --check --status
    mv "$output.partial" "$output"
  fi
}

checkout() {
  local url=$1 revision=$2 path=$3
  if [[ ! -d $path/.git ]]; then git init -q "$path"; fi
  if ! git -C "$path" cat-file -e "$revision^{commit}" 2>/dev/null; then
    git -C "$path" fetch --quiet --depth 1 "$url" "$revision"
  fi
  git -C "$path" checkout --quiet --detach "$revision"
}

fetch https://github.com/shiguredo-webrtc-build/webrtc-build/releases/download/m140.7339.2.4/webrtc.ubuntu-24.04_x86_64.tar.gz \
  "$sdk/webrtc.tar.gz" b348a534358e970b61090752b5d358ed22a6bd1858e72b124c9e1e9034ea04d5
if [[ ! -f $sdk/webrtc/lib/libwebrtc.a ]]; then
  tar -xzf "$sdk/webrtc.tar.gz" --strip-components=1 -C "$sdk/webrtc"
fi
checkout https://github.com/versatica/libmediasoupclient.git e345bc4720b8d7cf679e95bde93913969c9cd01d "$sdk/libmediasoupclient"
checkout https://github.com/ibc/libsdptransform.git e33aba7005c563286b19a8c90b9520a4384cc259 "$sdk/libsdptransform"
checkout https://chromium.googlesource.com/external/github.com/llvm/llvm-project/libcxx.git adbb4a5210ae2a8a4e27fa6199221156c02a9b1a "$sdk/libcxx"

# The baseline archive omits this optional implementation used by the client.
if ! printf '%s  %s\n' b5f82993430c8a1365e5416036b8a2f5dfaa6bf2709e2e2764812927fe358b3c "$sdk/field_trials.cc" | sha256sum --check --status; then
  curl --fail --location --retry 2 "https://webrtc.googlesource.com/src/+/36ea4535a500ac137dbf1f577ce40dc1aaa774ef/api/field_trials.cc?format=TEXT" | base64 -d > "$sdk/field_trials.cc.partial"
  printf '%s  %s\n' b5f82993430c8a1365e5416036b8a2f5dfaa6bf2709e2e2764812927fe358b3c "$sdk/field_trials.cc.partial" | sha256sum --check --status
  mv "$sdk/field_trials.cc.partial" "$sdk/field_trials.cc"
fi

chromium_config='https://chromium.googlesource.com/chromium/src/buildtools/+/0c4bbb0f8a874de0a2a15d196031c7303d04fbb3/third_party/libc++'
for item in __config_site __assertion_handler; do
  case $item in
    __config_site) checksum=01151ecd23942afea02e2570582dd7608be9bb97434aa94a56c1f2759015666a ;;
    __assertion_handler) checksum=430223844faa87a7fc0bc00745f514f875ffb261b2a12d35d2b3cf474a3799ee ;;
  esac
  if ! printf '%s  %s\n' "$checksum" "$sdk/libcxx-config/$item" | sha256sum --check --status; then
    curl --fail --location --retry 2 "$chromium_config/$item?format=TEXT" | base64 -d > "$sdk/libcxx-config/$item.partial"
    printf '%s  %s\n' "$checksum" "$sdk/libcxx-config/$item.partial" | sha256sum --check --status
    mv "$sdk/libcxx-config/$item.partial" "$sdk/libcxx-config/$item"
  fi
done

cxx_flags="-nostdinc++ -isystem \"$sdk/libcxx-config\" -isystem \"$sdk/libcxx/include\""
cxx_flags+=" -D_LIBCPP_DISABLE_VISIBILITY_ANNOTATIONS -D_LIBCPP_INSTRUMENTED_WITH_ASAN=0"
cxx_flags+=" -D_LIBCPP_HARDENING_MODE_DEFAULT=_LIBCPP_HARDENING_MODE_NONE ${CXXFLAGS:-}"
cmake -S "$sdk/libmediasoupclient" -B "$sdk/build" -G Ninja \
  -DCMAKE_CXX_COMPILER="$compiler" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON "-DCMAKE_CXX_FLAGS=$cxx_flags" \
  "-DLIBWEBRTC_INCLUDE_PATH=$sdk/webrtc/include" "-DLIBWEBRTC_BINARY_PATH=$sdk/webrtc/lib" \
  "-DFETCHCONTENT_SOURCE_DIR_LIBSDPTRANSFORM=$sdk/libsdptransform"
cmake --build "$sdk/build" --target mediasoupclient --parallel "${KORERO_BUILD_JOBS:-6}"
ln -sfn ../build/libmediasoupclient.a "$sdk/lib/libmediasoupclient.a"
ln -sfn ../build/_deps/libsdptransform-build/libsdptransform.a "$sdk/lib/libsdptransform.a"
ln -sfn ../webrtc/lib/libwebrtc.a "$sdk/lib/libwebrtc.a"
printf '\nNative media SDK ready at %s\n' "$sdk"
