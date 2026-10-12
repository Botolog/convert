./configure --prefix=/ --disable-shared --enable-static
make $JOBS
mkdir "$OUT_DIR/bin"
cp pkgconf "$OUT_DIR/bin/pkgconf"
ln -s pkgconf "$OUT_DIR/bin/pkg-config"
