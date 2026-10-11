LDFLAGS="-sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP16" \
  emmake make $JOBS CONFIG=emscripten EMSCRIPTEN_TARGET=wasm bin/libopenmpt.js
cp bin/libopenmpt.js bin/libopenmpt.wasm LICENSE "$OUT_DIR/"
