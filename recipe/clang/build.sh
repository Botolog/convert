TARGETS="WebAssembly;X86;ARM;AArch64;RISCV"
NATIVE="$PWD/native/bin"

cmake -G Ninja -S llvm -B native \
  -DCMAKE_BUILD_TYPE=Release \
  -DLLVM_TARGETS_TO_BUILD="$TARGETS" \
  -DLLVM_ENABLE_PROJECTS="clang;lld" \
  -DLLVM_INCLUDE_TESTS=OFF \
  -DLLVM_INCLUDE_BENCHMARKS=OFF \
  -DLLVM_INCLUDE_EXAMPLES=OFF \
  -DLLVM_ENABLE_ZLIB=OFF \
  -DLLVM_ENABLE_ZSTD=OFF \
  -DLLVM_ENABLE_LIBXML2=OFF
ninja -C native llvm-tblgen llvm-min-tblgen clang-tblgen clang lld llvm-ar llvm-ranlib llvm-nm \
  llvm-dlltool

# <directory> <output .tar.gz> <paths...>
pack() {
  dir="$1"
  out="$2"
  shift 2
  tar -C "$dir" --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --dereference \
    --mode=a+rX,u+w,go-w --format=gnu -cf - "$@" | gzip -9n > "$out"
}

# <triple> <cmake system name> <source> <install prefix> <cmake args...>
cross_cmake() {
  triple="$1"
  system="$2"
  source="$3"
  prefix="$4"
  shift 4
  cmake -G Ninja -S "$source" -B "build-$triple-${source##*/}" \
    -DCMAKE_BUILD_TYPE=MinSizeRel \
    -DCMAKE_SYSTEM_NAME="$system" \
    -DCMAKE_INSTALL_PREFIX="$prefix" \
    -DCMAKE_SYSROOT="$PWD/sysroots/$triple/sysroot" \
    -DCMAKE_C_COMPILER="$NATIVE/clang" \
    -DCMAKE_CXX_COMPILER="$NATIVE/clang++" \
    -DCMAKE_ASM_COMPILER="$NATIVE/clang" \
    -DCMAKE_C_COMPILER_TARGET="$triple" \
    -DCMAKE_CXX_COMPILER_TARGET="$triple" \
    -DCMAKE_ASM_COMPILER_TARGET="$triple" \
    -DCMAKE_AR="$NATIVE/llvm-ar" \
    -DCMAKE_RANLIB="$NATIVE/llvm-ranlib" \
    -DCMAKE_NM="$NATIVE/llvm-nm" \
    -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
    "$@"
  ninja -C "build-$triple-${source##*/}" install
}

# <triple> <cmake system name> <cmake args...>
builtins() {
  triple="$1"
  system="$2"
  shift 2
  cross_cmake "$triple" "$system" "$PWD/compiler-rt/lib/builtins" "$PWD/sysroots/$triple/resource" \
    -DLLVM_ENABLE_PER_TARGET_RUNTIME_DIR=ON \
    -DCOMPILER_RT_DEFAULT_TARGET_ONLY=ON \
    "$@"
}

# <triple> <cmake system name> <install prefix> <cmake args...>
libcxx() {
  triple="$1"
  system="$2"
  prefix="$3"
  shift 3
  cross_cmake "$triple" "$system" "$PWD/runtimes" "$prefix" \
    -DLLVM_ENABLE_RUNTIMES="libunwind;libcxxabi;libcxx" \
    -DLLVM_INCLUDE_TESTS=OFF \
    -DLIBUNWIND_ENABLE_SHARED=OFF \
    -DLIBUNWIND_USE_COMPILER_RT=ON \
    -DLIBCXXABI_ENABLE_SHARED=OFF \
    -DLIBCXXABI_USE_COMPILER_RT=ON \
    -DLIBCXXABI_USE_LLVM_UNWINDER=ON \
    -DLIBCXXABI_ENABLE_STATIC_UNWINDER=ON \
    -DLIBCXX_ENABLE_SHARED=OFF \
    -DLIBCXX_ENABLE_STATIC_ABI_LIBRARY=ON \
    -DLIBCXX_USE_COMPILER_RT=ON \
    -DLIBCXX_CXX_ABI=libcxxabi \
    -DLIBCXX_INCLUDE_BENCHMARKS=OFF \
    -DLIBCXX_INSTALL_MODULES=OFF \
    "$@"
}

# wasm32-unknown-wasip1, c++ with wasm exceptions
wasi() {
  triple=wasm32-unknown-wasip1
  sysroot="$PWD/sysroots/$triple/sysroot"
  builtins "$triple" Generic -DCOMPILER_RT_BAREMETAL_BUILD=ON
  make -C "$REQUIREMENTS_DIR/wasi-libc" $JOBS no-check-symbols CC="$NATIVE/clang" \
    AR="$NATIVE/llvm-ar" NM="$NATIVE/llvm-nm" TARGET_TRIPLE=wasm32-wasip1 SYSROOT="$sysroot" \
    OBJDIR="$PWD/build-$triple-wasi-libc" \
    BUILTINS_LIB="$PWD/sysroots/$triple/resource/lib/$triple/libclang_rt.builtins.a"
  libcxx "$triple" Generic "$sysroot" \
    -DCMAKE_C_FLAGS=-fwasm-exceptions \
    -DCMAKE_CXX_FLAGS=-fwasm-exceptions \
    -DLIBCXX_ENABLE_THREADS=OFF \
    -DLIBCXXABI_ENABLE_THREADS=OFF \
    -DLIBUNWIND_ENABLE_THREADS=OFF \
    -DLIBUNWIND_HIDE_SYMBOLS=ON \
    -DLIBCXX_HAS_MUSL_LIBC=ON \
    -DLIBCXX_INSTALL_LIBRARY_DIR=lib/wasm32-wasip1 \
    -DLIBCXXABI_INSTALL_LIBRARY_DIR=lib/wasm32-wasip1 \
    -DLIBUNWIND_INSTALL_LIBRARY_DIR=lib/wasm32-wasip1
}

# <triple> <kernel arch>
linux() {
  sysroot="$PWD/sysroots/$1/sysroot"
  make -C "$REQUIREMENTS_DIR/kernel-headers" ARCH="$2" prefix=/usr DESTDIR="$sysroot" install
  mkdir "build-$1-musl"
  (
    cd "build-$1-musl"
    "$REQUIREMENTS_DIR/musl/configure" --target="$1" --prefix=/usr --disable-shared \
      CC="$NATIVE/clang --target=$1" CROSS_COMPILE="$NATIVE/llvm-" CFLAGS=-Os
    make $JOBS install DESTDIR="$sysroot"
  )
  builtins "$1" Linux -DCOMPILER_RT_BUILD_CRT=ON
  libcxx "$1" Linux "$sysroot/usr" -DLIBCXX_HAS_MUSL_LIBC=ON
}

# <triple> <mingw-w64 arch> <mingw-w64 crt flag>
windows() {
  sysroot="$PWD/sysroots/$1/sysroot"
  mkdir "build-$1-mingw-headers" "build-$1-mingw-crt"
  (
    cd "build-$1-mingw-headers"
    "$REQUIREMENTS_DIR/mingw-w64/mingw-w64-headers/configure" --host="$2-w64-mingw32" \
      --prefix="$sysroot" --with-default-msvcrt=ucrt --with-default-win32-winnt=0x601
    make install
  )
  builtins "$1" Windows
  (
    cd "build-$1-mingw-crt"
    "$REQUIREMENTS_DIR/mingw-w64/mingw-w64-crt/configure" --host="$2-w64-mingw32" \
      --prefix="$sysroot" --with-default-msvcrt=ucrt \
      --disable-lib32 --disable-lib64 --disable-libarm32 --disable-libarm64 "--enable-$3" \
      CC="$NATIVE/clang --target=$1 --sysroot=$sysroot" AR="$NATIVE/llvm-ar" \
      RANLIB="$NATIVE/llvm-ranlib" DLLTOOL="$NATIVE/llvm-dlltool" CFLAGS=-Os
    make $JOBS
    make install
  )
  libcxx "$1" Windows "$sysroot"
}

wasi
linux x86_64-unknown-linux-musl x86
linux i686-unknown-linux-musl x86
linux armv7-unknown-linux-musleabihf arm
linux aarch64-unknown-linux-musl arm64
linux riscv64-unknown-linux-musl riscv
windows x86_64-w64-windows-gnu x86_64 lib64
windows i686-w64-windows-gnu i686 lib32
windows armv7-w64-windows-gnu armv7 libarm32
windows aarch64-w64-windows-gnu aarch64 libarm64

BUILD_TYPE=Release
OPT_FLAGS="-O3 -flto"
LINK_FLAGS="-O3 -flto"

emcmake cmake -G Ninja -S llvm -B build \
  -DCMAKE_BUILD_TYPE="$BUILD_TYPE" \
  -DCMAKE_C_FLAGS_DEBUG="$OPT_FLAGS" \
  -DCMAKE_CXX_FLAGS_DEBUG="$OPT_FLAGS" \
  -DCMAKE_C_FLAGS_RELEASE="$OPT_FLAGS" \
  -DCMAKE_CXX_FLAGS_RELEASE="$OPT_FLAGS" \
  -DCMAKE_EXE_LINKER_FLAGS="$LINK_FLAGS -sENVIRONMENT=web,worker,node -sMODULARIZE -sEXPORT_ES6 \
    -sINVOKE_RUN=0 -sEXPORTED_RUNTIME_METHODS=callMain,FS -sEXIT_RUNTIME=1 -sALLOW_MEMORY_GROWTH \
    -sINITIAL_MEMORY=128MB -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=8MB --emit-tsd llvm.d.ts" \
  -DLLVM_NATIVE_TOOL_DIR="$NATIVE" \
  -DLLVM_HOST_TRIPLE=wasm32-unknown-emscripten \
  -DLLVM_DEFAULT_TARGET_TRIPLE=wasm32-unknown-wasip1 \
  -DLLVM_TARGETS_TO_BUILD="$TARGETS" \
  -DLLVM_ENABLE_PROJECTS="clang;lld" \
  -DLLVM_TOOL_LLVM_DRIVER_BUILD=ON \
  -DLLVM_DISTRIBUTION_COMPONENTS="clang;lld" \
  -DLLVM_ENABLE_THREADS=OFF \
  -DLLVM_ENABLE_PIC=OFF \
  -DLLVM_ENABLE_PLUGINS=OFF \
  -DLLVM_ENABLE_BACKTRACES=OFF \
  -DLLVM_ENABLE_CRASH_OVERRIDES=OFF \
  -DLLVM_ENABLE_ZLIB=OFF \
  -DLLVM_ENABLE_ZSTD=OFF \
  -DLLVM_ENABLE_LIBXML2=OFF \
  -DLLVM_ENABLE_LIBEDIT=OFF \
  -DLLVM_ENABLE_LIBPFM=OFF \
  -DLLVM_INCLUDE_TESTS=OFF \
  -DLLVM_INCLUDE_BENCHMARKS=OFF \
  -DLLVM_INCLUDE_EXAMPLES=OFF \
  -DLLVM_INCLUDE_DOCS=OFF \
  -DLLVM_INCLUDE_UTILS=OFF \
  -DCLANG_PLUGIN_SUPPORT=OFF \
  -DCLANG_ENABLE_STATIC_ANALYZER=OFF \
  -DCLANG_ENABLE_OBJC_REWRITER=OFF
ninja -C build llvm-driver clang-resource-headers

cp build/bin/llvm.js build/bin/llvm.d.ts LICENSE.TXT "$OUT_DIR/"
gzip -9n < build/bin/llvm.wasm > "$OUT_DIR/llvm.wasm.gz"
pack build/lib/clang/* "$OUT_DIR/resources.tar.gz" .
mkdir "$OUT_DIR/sysroots"
for sysroot in sysroots/*; do
  find "$sysroot" -depth -type d \( -name share -o -name bin -o -name cmake -o -name pkgconfig \) \
    -exec rm -rf {} +
  pack "$sysroot" "$OUT_DIR/sysroots/${sysroot#sysroots/}.tar.gz" sysroot resource
done
