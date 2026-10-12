mkdir -p "$PREFIX/include" "$PREFIX/lib"

# everything linked into ffmpeg has to be built with -pthread
export CFLAGS="-O3 -pthread"
export CXXFLAGS="$CFLAGS"
export LDFLAGS="-O3 -pthread -L$PREFIX/lib"
export CPPFLAGS="-I$PREFIX/include -D_LARGEFILE64_SOURCE"

# ====== Compression ======

(
    cd "$REQUIREMENTS_DIR/zlib"
    emconfigure ./configure --prefix="$PREFIX" --static
    emmake make $JOBS install
)

# ====== Audio ======

(
    cd "$REQUIREMENTS_DIR/lame"
    em_autotools --disable-frontend --disable-analyzer-hooks --disable-gtktest --disable-decoder
)

(
    cd "$REQUIREMENTS_DIR/ogg"
    em_autotools
)

(
    cd "$REQUIREMENTS_DIR/vorbis"
    em_autotools --disable-oggtest --disable-examples --disable-docs
)

(
    cd "$REQUIREMENTS_DIR/opus"
    em_autotools --disable-doc --disable-extra-programs --disable-asm --disable-rtcd \
        --disable-intrinsics
)

(
    cd "$REQUIREMENTS_DIR/speex"
    em_autotools --disable-binaries
)

(
    cd "$REQUIREMENTS_DIR/opencore-amr"
    em_autotools --disable-examples
)

(
    cd "$REQUIREMENTS_DIR/vo-amrwbenc"
    em_autotools --disable-example
)

(
    cd "$REQUIREMENTS_DIR/gsm"
    emmake make $JOBS CC=emcc AR=emar RANLIB=emranlib \
        CCFLAGS="$CFLAGS -c -DNeedFunctionPrototypes=1" lib/libgsm.a
    cp lib/libgsm.a "$PREFIX/lib/"
    cp inc/gsm.h "$PREFIX/include/"
)

(
    cd "$REQUIREMENTS_DIR/ilbc"
    em_cmake
)

(
    cd "$REQUIREMENTS_DIR/codec2"
    # these two function names clash with speex
    CFLAGS="$CFLAGS -Dlpc_to_lsp=codec2_lpc_to_lsp -Dlsp_to_lpc=codec2_lsp_to_lpc" \
        em_cmake -DUNITTEST=OFF -DINSTALL_EXAMPLES=OFF
)

# ====== Video and images ======

(
    cd "$REQUIREMENTS_DIR/theora"
    em_autotools --disable-examples --disable-asm --disable-doc --disable-oggtest \
        --disable-vorbistest --disable-spec
)

(
    cd "$REQUIREMENTS_DIR/vpx"
    emconfigure ./configure --prefix="$PREFIX" --target=generic-gnu --enable-vp9-highbitdepth \
        --disable-install-bins --disable-examples --disable-tools --disable-docs \
        --disable-unit-tests --disable-dependency-tracking
    emmake make $JOBS
    emmake make install
)

(
    cd "$REQUIREMENTS_DIR/x264"
    emconfigure ./configure --host=i686-gnu --prefix="$PREFIX" --enable-static --disable-cli \
        --disable-asm
    emmake make $JOBS
    emmake make install-lib-static
)

(
    cd "$REQUIREMENTS_DIR/x265"
    cd source
    em_cmake -DEMSCRIPTEN_SYSTEM_PROCESSOR=wasm32 \
        -DENABLE_LIBNUMA=OFF -DENABLE_SHARED=OFF -DENABLE_CLI=OFF -DENABLE_ASSEMBLY=OFF
)

(
    cd "$REQUIREMENTS_DIR/vvenc"
    em_cmake -DVVENC_LIBRARY_ONLY=ON -DVVENC_ENABLE_LINK_TIME_OPT=OFF \
        -DVVENC_ENABLE_X86_SIMD=OFF -DVVENC_ENABLE_WERROR=OFF
)

(
    cd "$REQUIREMENTS_DIR/aom"
    em_cmake -DAOM_TARGET_CPU=generic -DCONFIG_RUNTIME_CPU_DETECT=0 -DCONFIG_WEBM_IO=0 \
        -DENABLE_DOCS=0 -DENABLE_TESTS=0 -DENABLE_EXAMPLES=0 -DENABLE_TOOLS=0
)

(
    cd "$REQUIREMENTS_DIR/dav1d"
    em_meson -Denable_asm=false -Denable_tools=false -Denable_tests=false
)

(
    cd "$REQUIREMENTS_DIR/webp"
    em_cmake -DWEBP_ENABLE_SIMD=OFF -DWEBP_BUILD_ANIM_UTILS=OFF -DWEBP_BUILD_CWEBP=OFF \
        -DWEBP_BUILD_DWEBP=OFF -DWEBP_BUILD_GIF2WEBP=OFF -DWEBP_BUILD_IMG2WEBP=OFF \
        -DWEBP_BUILD_VWEBP=OFF -DWEBP_BUILD_WEBPINFO=OFF -DWEBP_BUILD_WEBPMUX=OFF \
        -DWEBP_BUILD_EXTRAS=OFF
)

# ====== FFmpeg ======

# thanks to ffmpeg.wasm for providing (most) of the ffmpeg flags
# https://github.com/ffmpegwasm/ffmpeg.wasm
export LDFLAGS_EMCC="-sENVIRONMENT=web,worker,node -sEXPORT_ES6 -sMODULARIZE -sINVOKE_RUN=0 \
    -sEXPORTED_RUNTIME_METHODS=callMain,FS -sEXPORTED_FUNCTIONS=_main,_emscripten_force_exit \
    -sEXIT_RUNTIME=1 -sINITIAL_MEMORY=32MB -sALLOW_MEMORY_GROWTH -sPROXY_TO_PTHREAD \
    -sSTACK_SIZE=4MB -sDEFAULT_PTHREAD_STACK_SIZE=2MB --emit-tsd ffmpeg-core.d.ts"

emconfigure ./configure \
    --target-os=none --arch=x86_32 --enable-cross-compile \
    --cc=emcc --cxx=em++ --ld=em++ --nm=emnm --ar=emar --ranlib=emranlib \
    --pkg-config-flags=--static \
    --disable-asm --disable-stripping --disable-debug --disable-runtime-cpudetect \
    --disable-autodetect --disable-doc --disable-ffplay --disable-ffprobe --enable-lto \
    --enable-gpl --enable-version3 \
    --enable-zlib \
    --enable-libmp3lame --enable-libvorbis --enable-libopus --enable-libspeex \
    --enable-libopencore-amrnb --enable-libopencore-amrwb --enable-libvo-amrwbenc \
    --enable-libgsm --enable-libilbc --enable-libcodec2 \
    --enable-libtheora --enable-libvpx --enable-libx264 --enable-libx265 --enable-libvvenc \
    --enable-libaom --enable-libdav1d --enable-libwebp
emmake make $JOBS ffmpeg-core.js
cp ffmpeg-core.js ffmpeg-core.wasm ffmpeg-core.d.ts "$OUT_DIR/"
