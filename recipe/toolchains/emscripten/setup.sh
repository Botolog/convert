# the cache gets written on first use, so it can't live in the read-only toolchain
export EM_CACHE=/tmp/emscripten-cache
export EM_CONFIG=/tmp/emscripten-config
cat > "$EM_CONFIG" <<CONFIG
LLVM_ROOT = '$TOOLCHAIN/bin'
BINARYEN_ROOT = '$TOOLCHAIN'
NODE_JS = '$(command -v node)'
CONFIG
export PATH="$TOOLCHAIN/emscripten:$PATH"
# so libraries built into $PREFIX can find each other, emconfigure and emmake
# replace PKG_CONFIG_PATH with EM_PKG_CONFIG_PATH so both are needed
export EM_PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig:$PREFIX/share/pkgconfig"
export PKG_CONFIG_PATH="$EM_PKG_CONFIG_PATH"

EMSCRIPTEN_CROSS_FILE=/tmp/emscripten.ini
cat > "$EMSCRIPTEN_CROSS_FILE" <<CROSS
[binaries]
c = 'emcc'
cpp = 'em++'
ar = 'emar'
ranlib = 'emranlib'
pkg-config = 'pkg-config'

[host_machine]
system = 'emscripten'
cpu_family = 'wasm32'
cpu = 'wasm32'
endian = 'little'
CROSS

em_autotools() {
    emconfigure ./configure --host=wasm32-unknown-linux --prefix="$PREFIX" \
        --enable-static --disable-shared "$@"
    emmake make $JOBS
    emmake make install
}

em_cmake() {
    emcmake cmake -S . -B _build \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX="$PREFIX" \
        -DCMAKE_PREFIX_PATH="$PREFIX" \
        -DCMAKE_FIND_ROOT_PATH="$PREFIX" \
        -DBUILD_SHARED_LIBS=OFF \
        -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
        "$@"
    cmake --build _build $JOBS
    cmake --install _build
}

# needs the meson toolchain
em_meson() {
    meson setup _build --cross-file "$EMSCRIPTEN_CROSS_FILE" --prefix="$PREFIX" --libdir=lib \
        --buildtype=release --default-library=static "$@"
    ninja -C _build
    ninja -C _build install
}
