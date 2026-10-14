import { expect, test } from "bun:test";
import Formats from "../../src/Formats.js";
import vectordrawableHandler from "../../src/handlers/vectordrawable.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const vdFormat = Formats.VECTORDRAWABLE.builder("vectordrawable").fromTo();
const svgFormat = Formats.SVG.builder("svg").fromTo();

const SMALL_VD = `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <group
        android:name="scaled"
        android:scaleX="0.86"
        android:scaleY="0.86"
        android:pivotX="12"
        android:pivotY="12">
        <path
            android:name="bg"
            android:fillColor="#FFFFFFFF"
            android:pathData="M0,0h24v24H0z" />
        <path
            android:fillColor="#80FF0000"
            android:fillType="evenOdd"
            android:strokeColor="@color/accent"
            android:strokeWidth="1"
            android:strokeLineCap="round"
            android:pathData="M1,1h2v2H1z" />
    </group>
</vector>`;

async function convert(text: string, name: string, from: typeof vdFormat, to: typeof vdFormat) {
  const handler = new vectordrawableHandler();
  await handler.init();
  const [output] = await handler.doConvert([{ name, bytes: encoder.encode(text) }], from, to);
  return output;
}

test("vectordrawable handler maps viewport, colors, groups and strokes to SVG", async () => {
  const output = await convert(SMALL_VD, "icon.xml", vdFormat, svgFormat);

  expect(output.name).toBe("icon.svg");
  const svg = decoder.decode(output.bytes);
  expect(svg).toContain(`xmlns="http://www.w3.org/2000/svg"`);
  expect(svg).toContain(`viewBox="0 0 24 24"`);
  expect(svg).toContain(`width="24"`);
  // Group pivot/scale becomes a pivot-centered SVG transform.
  expect(svg).toContain(`transform="translate(12 12) scale(0.86 0.86) translate(-12 -12)"`);
  // #FFFFFFFF keeps full opacity, #80FF0000 splits off its alpha channel.
  expect(svg).toContain(`fill="#FFFFFF"`);
  expect(svg).toContain(`fill="#FF0000"`);
  expect(svg).toContain(`fill-opacity="0.502"`);
  expect(svg).toContain(`fill-rule="evenodd"`);
  // Unresolvable @color references pass through untouched.
  expect(svg).toContain(`stroke="@color/accent"`);
  expect(svg).toContain(`stroke-width="1"`);
  expect(svg).toContain(`stroke-linecap="round"`);
  expect(svg).toContain(`id="scaled"`);
  expect(svg).toContain(`d="M0,0h24v24H0z"`);
});

test("vectordrawable handler converts the bundled issue #770 sample", async () => {
  const file = Bun.file(`${import.meta.dir}/../resources/vectordrawable.xml`);
  const sample = await file.text();

  const output = await convert(sample, "ic_no_song_cover.xml", vdFormat, svgFormat);

  expect(output.name).toBe("ic_no_song_cover.svg");
  const svg = decoder.decode(output.bytes);
  expect(svg).toContain(`viewBox="0 0 24 24"`);
  expect(svg).toContain(`fill="#FFFFFF"`);
  expect(svg).toContain(`fill="#757575"`);
  expect(svg).toContain(`fill-rule="evenodd"`);
  expect((svg.match(/<path /g) ?? []).length).toBe(2);
});

test("vectordrawable handler converts SVG back to VectorDrawable XML", async () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
  <g transform="translate(12 12) scale(0.86 0.86) translate(-12 -12)">
    <path d="M0,0h24v24H0z" fill="#FFFFFF"/>
    <path d="M1,1h2v2H1z" fill="#FF0000" fill-opacity="0.5" fill-rule="evenodd" stroke-width="2"/>
  </g>
</svg>`;

  const output = await convert(svg, "icon.svg", svgFormat, vdFormat);

  expect(output.name).toBe("icon.xml");
  const vd = decoder.decode(output.bytes);
  expect(vd).toContain(`xmlns:android="http://schemas.android.com/apk/res/android"`);
  expect(vd).toContain(`android:width="24dp"`);
  expect(vd).toContain(`android:viewportWidth="24"`);
  expect(vd).toContain(`android:pathData="M0,0h24v24H0z"`);
  expect(vd).toContain(`android:fillColor="#FFFFFF"`);
  expect(vd).toContain(`android:fillColor="#FF0000"`);
  expect(vd).toContain(`android:fillAlpha="0.5"`);
  expect(vd).toContain(`android:fillType="evenOdd"`);
  expect(vd).toContain(`android:scaleX="0.86"`);
});

test("vectordrawable handler round-trips pathData losslessly", async () => {
  const svg = decoder.decode((await convert(SMALL_VD, "icon.xml", vdFormat, svgFormat)).bytes);
  const vd = decoder.decode((await convert(svg, "icon.svg", svgFormat, vdFormat)).bytes);

  expect(vd).toContain(`android:pathData="M0,0h24v24H0z"`);
  expect(vd).toContain(`android:pathData="M1,1h2v2H1z"`);
  expect(vd).toContain(`android:strokeColor="@color/accent"`);
});

test("vectordrawable handler does not mutate its input bytes", async () => {
  const handler = new vectordrawableHandler();
  await handler.init();
  const bytes = encoder.encode(SMALL_VD);
  const snapshot = bytes.slice();

  await handler.doConvert([{ name: "icon.xml", bytes }], vdFormat, svgFormat);

  expect(Array.from(bytes)).toEqual(Array.from(snapshot));
});

test("vectordrawable handler rejects non-vector input", async () => {
  const handler = new vectordrawableHandler();
  await handler.init();

  expect(
    handler.doConvert(
      [{ name: "plain.xml", bytes: encoder.encode(`<resources></resources>`) }],
      vdFormat,
      svgFormat,
    ),
  ).rejects.toThrow();

  expect(
    handler.doConvert(
      [{ name: "plain.svg", bytes: encoder.encode(`<html></html>`) }],
      svgFormat,
      vdFormat,
    ),
  ).rejects.toThrow();
});
