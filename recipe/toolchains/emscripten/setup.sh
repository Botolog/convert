# the cache gets written on first use, so it can't live in the read-only toolchain
export EM_CACHE=/tmp/emscripten-cache
export EM_CONFIG=/tmp/emscripten-config
cat > "$EM_CONFIG" <<CONFIG
LLVM_ROOT = '$TOOLCHAIN/bin'
BINARYEN_ROOT = '$TOOLCHAIN'
NODE_JS = '$(command -v node)'
CONFIG
export PATH="$TOOLCHAIN/emscripten:$PATH"
