# usage: sh -eu prebuild.sh <script in $RECIPE_DIR>
# the *_DIR variables come from prebuild.ts

# for make and friends, like `make $JOBS`
export JOBS="-j$(nproc)"

# toolchains can put their bins here
TOOLCHAIN_BIN=/tmp/toolchain-bin
mkdir -p "$TOOLCHAIN_BIN"
export PATH="$TOOLCHAIN_BIN:$PATH"

# where libraries get installed to, so later steps can build against them
export PREFIX=/tmp/prefix
mkdir -p "$PREFIX"

for name in $TOOLCHAINS; do
    TOOLCHAIN="$TOOLCHAINS_DIR/$name"
    if [ -f "$SETUP_DIR/$name/setup.sh" ]; then
        . "$SETUP_DIR/$name/setup.sh"
    elif [ -d "$TOOLCHAIN/bin" ]; then
        export PATH="$TOOLCHAIN/bin:$PATH"
    else
        export PATH="$TOOLCHAIN:$PATH"
    fi
done

# now build
cd "$SOURCE_DIR"
. "$RECIPE_DIR/$1"
