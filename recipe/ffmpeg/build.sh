# thanks to ffmpeg.wasm for providing (most) of these flags
# https://github.com/ffmpegwasm/ffmpeg.wasm
export LDFLAGS_EMCC="-sENVIRONMENT=web,worker -sEXPORT_ES6 -sMODULARIZE -sINVOKE_RUN=0 \
    -sEXPORTED_RUNTIME_METHODS=callMain,FS -sEXPORTED_FUNCTIONS=_main,_emscripten_force_exit \
    -sEXIT_RUNTIME=1 -sINITIAL_MEMORY=32MB -sALLOW_MEMORY_GROWTH \
    -sPROXY_TO_PTHREAD --emit-tsd ffmpeg-core.d.ts"
emconfigure ./configure \
    --target-os=none --arch=x86_32 --enable-cross-compile \
    --cc=emcc --cxx=em++ --objcc=emcc --dep-cc=emcc \
    --nm=emnm --ar=emar --ranlib=emranlib \
    --disable-asm --disable-stripping --disable-debug --disable-runtime-cpudetect \
    --disable-autodetect --disable-doc --disable-ffplay --disable-ffprobe \
    --extra-cflags='-O3 -pthread' --extra-ldflags='-O3 -pthread'
emmake make $JOBS ffmpeg-core.js
cp ffmpeg-core.js ffmpeg-core.wasm ffmpeg-core.d.ts "$OUT_DIR/"
