bun ci
bun run build-node-prod
cp -r dist/. "$OUT_DIR/"
cp "$RECIPE_DIR/packager.d.ts" "$OUT_DIR/packager.d.ts"
