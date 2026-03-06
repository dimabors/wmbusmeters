#!/bin/bash
# Build wmbusmeters as a WebAssembly module using Emscripten.
# This script is meant to run in CI after setting up emsdk.
#
# Usage: ./wasm/build_wasm.sh
#
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$ROOT_DIR/build_wasm"

mkdir -p "$BUILD_DIR"

echo "=== Building wmbusmeters for WebAssembly ==="

# ---- Generate build headers (version.h, short_manual.h, authors.h) ----

COMMIT_HASH=$(git -C "$ROOT_DIR" log --pretty=format:'%H' -n 1 2>/dev/null || echo "unknown")
TAG=$(git -C "$ROOT_DIR" describe --tags 2>/dev/null || echo "dev")
BRANCH=$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")

if [ "$BRANCH" = "master" ]; then
    VERSION="$TAG"
else
    VERSION="${BRANCH}_${TAG}"
fi

cat > "$BUILD_DIR/version.h" <<EOF
#define VERSION "${VERSION} (wasm)"
#define COMMIT "${COMMIT_HASH}"
EOF

echo 'R"MANUAL(' > "$BUILD_DIR/short_manual.h"
sed -n '/wmbusmeters version/,/```/p' "$ROOT_DIR/README.md" \
    | grep -v 'wmbusmeters version' \
    | grep -v '```' >> "$BUILD_DIR/short_manual.h" || true
echo ')MANUAL";' >> "$BUILD_DIR/short_manual.h"

"$ROOT_DIR/scripts/generate_authors.sh" "$BUILD_DIR/authors.h" 2>/dev/null || \
    echo 'R"AUTHORS(wmbusmeters authors)AUTHORS";' > "$BUILD_DIR/authors.h"

# ---- Create rtlsdr stub ----

cat > "$BUILD_DIR/rtlsdr_stub.cc" << 'STUB'
// Stub for rtlsdr functions - not needed for analyze mode in WASM
#include <string>
#include <vector>

// Minimal forward declarations matching rtlsdr.h interface
namespace { struct Detected; }

#include "rtlsdr.h"

std::vector<std::string> listRtlSdrDevices() {
    return {};
}

int indexFromRtlSdrSerial(std::string) {
    return -1;
}

AccessCheck detectRTLSDR(std::string, Detected *) {
    return AccessCheck::NoSuchDevice;
}
STUB

# ---- Collect source files ----

# Core objects (match Makefile PROG_OBJS, minus rtlsdr.cc which we stub)
CORE_SOURCES=(
    address.cc
    aes.cc
    aescmac.cc
    bus.cc
    cmdline.cc
    config.cc
    drivers.cc
    dvparser.cc
    formula.cc
    mbus_rawtty.cc
    metermanager.cc
    meters.cc
    manufacturer_specificities.cc
    printer.cc
    serial.cc
    shell.cc
    sha256.cc
    threads.cc
    translatebits.cc
    util.cc
    units.cc
    wmbus.cc
    wmbus_amb8465.cc
    wmbus_im871a.cc
    wmbus_iu891a.cc
    wmbus_cul.cc
    wmbus_rtlwmbus.cc
    wmbus_rtl433.cc
    wmbus_simulator.cc
    wmbus_rawtty.cc
    wmbus_xmqtty.cc
    wmbus_rc1180.cc
    wmbus_utils.cc
    xmq.c
    lora_iu880b.cc
)

# Driver sources
DRIVER_SOURCES=($(ls "$ROOT_DIR"/src/driver_*.cc "$ROOT_DIR"/src/meter_*.cc 2>/dev/null))

# Main
MAIN_SOURCE="$ROOT_DIR/src/main.cc"

# Build the source file list with full paths
ALL_SOURCES=()
for f in "${CORE_SOURCES[@]}"; do
    ALL_SOURCES+=("$ROOT_DIR/src/$f")
done
for f in "${DRIVER_SOURCES[@]}"; do
    ALL_SOURCES+=("$f")
done
ALL_SOURCES+=("$MAIN_SOURCE")
ALL_SOURCES+=("$BUILD_DIR/rtlsdr_stub.cc")

echo "Compiling ${#ALL_SOURCES[@]} source files..."

# ---- Compile with Emscripten ----

# Flags:
# - MODULARIZE: export as a factory function
# - EXPORT_NAME: the factory function name
# - EXIT_RUNTIME: allow clean exit
# - ALLOW_MEMORY_GROWTH: dynamic memory
# - USE_PTHREADS + PROXY_TO_PTHREAD: threading support
#   (requires SharedArrayBuffer / COOP+COEP headers)
# - PTHREAD_POOL_SIZE: pre-create worker threads
# - EXPORTED_RUNTIME_METHODS: expose callMain and FS

# Note: We try with pthreads first. If SharedArrayBuffer is not available
# in the browser, we'll fall back gracefully.

EMCC_FLAGS=(
    -O2
    -std=c++11
    -I"$ROOT_DIR/src"
    -I"$BUILD_DIR"
    -DFUZZING=false
    -Wno-unused-function
    -sEXIT_RUNTIME=1
    -sALLOW_MEMORY_GROWTH=1
    -sINITIAL_MEMORY=67108864
    -sMODULARIZE=1
    -sEXPORT_NAME='createWmbusmeters'
    -sEXPORTED_RUNTIME_METHODS='["callMain","FS"]'
    -sINVOKE_RUN=0
    -sENVIRONMENT='web,worker'
    --use-port=libxml2
    -pthread
    -sPROXY_TO_PTHREAD=1
    -sPTHREAD_POOL_SIZE=4
)

echo "Running emcc..."
emcc "${EMCC_FLAGS[@]}" \
    "${ALL_SOURCES[@]}" \
    -o "$BUILD_DIR/wmbusmeters.js"

echo "=== WASM build complete ==="
echo "Output files:"
ls -la "$BUILD_DIR/wmbusmeters.js" "$BUILD_DIR/wmbusmeters.wasm" "$BUILD_DIR/wmbusmeters.worker.js" 2>/dev/null || true
