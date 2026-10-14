import { DOMParser } from "@xmldom/xmldom";

import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";
import Formats from "src/Formats.ts";
import { changeExt, decode, encode } from "src/common/index.ts";

// Reimplements the mapping from RohanTalip/VectorDrawable2Svg (logic only)
// in TypeScript: viewport -> viewBox, dp dimensions, group pivots/scales,
// pathData, ARGB colors, evenOdd fill types and @color references.

const ANDROID_NS = "http://schemas.android.com/apk/res/android";

// Element type of documents produced by @xmldom/xmldom (structurally close to
// DOM Element, but a distinct type, so it gets its own alias).
type XmlElement = NonNullable<
  ReturnType<InstanceType<typeof DOMParser>["parseFromString"]>["documentElement"]
>;

function vdAttr(el: XmlElement, name: string): string | undefined {
  const namespaced = el.getAttribute(`android:${name}`);
  if (namespaced !== null && namespaced !== "") return namespaced;
  const plain = el.getAttribute(name);
  if (plain !== null && plain !== "") return plain;
  return undefined;
}

function svgAttr(el: XmlElement, style: Record<string, string>, name: string): string | undefined {
  const direct = el.getAttribute(name);
  if (direct !== null && direct !== "") return direct;
  const fromStyle = style[name];
  if (fromStyle !== undefined && fromStyle !== "") return fromStyle;
  return undefined;
}

function parseStyle(el: XmlElement): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = el.getAttribute("style");
  if (raw === null || raw === "") return out;
  for (const declaration of raw.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;
    const key = declaration.slice(0, colon).trim();
    const value = declaration.slice(colon + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtNum(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(Math.round(value * 10000) / 10000);
}

function fmtOpacity(value: number): string {
  const clamped = Math.min(1, Math.max(0, value));
  return String(Math.round(clamped * 10000) / 10000);
}

function parseNum(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function alphaByteToOpacity(hex: string): number {
  return parseInt(hex, 16) / 255;
}

function opacityToAlphaByte(opacity: number): string {
  return Math.round(Math.min(1, Math.max(0, opacity)) * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
}

interface SvgPaint {
  color: string;
  opacity: number;
}

/// Splits an Android color (`#RGB`, `#ARGB`, `#RRGGBB`, `#AARRGGBB`,
/// `@color/name` or `?attr/name`) into an SVG color plus opacity.
/// Unresolvable `@color/` / `?attr/` references are passed through untouched.
function vdColorToSvg(value: string, alpha: number): SvgPaint {
  if (value.startsWith("@") || value.startsWith("?")) return { color: value, opacity: alpha };
  const match = value.match(/^#([0-9a-fA-F]+)$/);
  if (!match) return { color: value, opacity: alpha };
  const hex = match[1];
  if (hex.length === 3) {
    return {
      color: `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`,
      opacity: alpha,
    };
  }
  if (hex.length === 4) {
    return {
      color: `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`,
      opacity: alpha * alphaByteToOpacity(hex[0] + hex[0]),
    };
  }
  if (hex.length === 6) return { color: `#${hex}`, opacity: alpha };
  if (hex.length === 8) {
    return {
      color: `#${hex.slice(2)}`,
      opacity: alpha * alphaByteToOpacity(hex.slice(0, 2)),
    };
  }
  return { color: value, opacity: alpha };
}

interface VdPaint {
  color?: string;
  alpha?: number;
}

/// Splits an SVG fill/stroke plus opacity into an Android color and an
/// optional `fillAlpha`/`strokeAlpha`. `none` maps to no color.
function svgColorToVd(color: string | undefined, opacity: number): VdPaint {
  if (color === undefined || color === "none") return {};
  const hexMatch = color.match(/^#([0-9a-fA-F]+)$/);
  if (hexMatch) {
    const hex = hexMatch[1];
    if (hex.length === 3) {
      const expanded = `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
      return opacity >= 0.9999
        ? { color: `#${expanded}` }
        : { color: `#${expanded}`, alpha: opacity };
    }
    if (hex.length === 6) {
      return opacity >= 0.9999 ? { color: `#${hex}` } : { color: `#${hex}`, alpha: opacity };
    }
    if (hex.length === 8) {
      // SVG #RRGGBBAA -> Android #AARRGGBB, multiplied by the opacity.
      const combined = opacity * alphaByteToOpacity(hex.slice(6));
      return { color: `#${opacityToAlphaByte(combined)}${hex.slice(0, 6)}` };
    }
  }
  // Named colors, rgb()/hsl() functions and @color/?attr references that
  // survived a round-trip are kept verbatim; opacity goes to a *_alpha attr.
  return opacity >= 0.9999 ? { color } : { color, alpha: opacity };
}

function childElements(el: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  for (let i = 0; i < el.childNodes.length; i++) {
    const node = el.childNodes.item(i);
    if (node !== null && node.nodeType === 1) out.push(node as unknown as XmlElement);
  }
  return out;
}

function localName(el: XmlElement): string {
  const tag = el.tagName ?? "";
  const colon = tag.indexOf(":");
  return colon === -1 ? tag : tag.slice(colon + 1);
}

function findFirst(el: XmlElement, name: string): XmlElement | undefined {
  if (localName(el) === name) return el;
  for (const child of childElements(el)) {
    const found = findFirst(child, name);
    if (found) return found;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// VectorDrawable -> SVG
// ---------------------------------------------------------------------------

let clipIdCounter = 0;

function convertVdPath(path: XmlElement, indent: string): string {
  const pathData = vdAttr(path, "pathData");
  if (pathData === undefined) return "";

  const name = vdAttr(path, "name");
  const attrs: string[] = [`d="${esc(pathData)}"`];

  const fillRaw = vdAttr(path, "fillColor");
  const fillAlpha = parseNum(vdAttr(path, "fillAlpha"), 1);
  if (fillRaw !== undefined) {
    const { color, opacity } = vdColorToSvg(fillRaw, fillAlpha);
    attrs.push(`fill="${esc(color)}"`);
    if (opacity < 0.9999) attrs.push(`fill-opacity="${fmtOpacity(opacity)}"`);
  } else {
    attrs.push(`fill="none"`);
  }

  const fillType = vdAttr(path, "fillType");
  if (fillType !== undefined && fillType.toLowerCase() === "evenodd") {
    attrs.push(`fill-rule="evenodd"`);
  }

  const strokeRaw = vdAttr(path, "strokeColor");
  const strokeAlpha = parseNum(vdAttr(path, "strokeAlpha"), 1);
  if (strokeRaw !== undefined) {
    const { color, opacity } = vdColorToSvg(strokeRaw, strokeAlpha);
    attrs.push(`stroke="${esc(color)}"`);
    if (opacity < 0.9999) attrs.push(`stroke-opacity="${fmtOpacity(opacity)}"`);
  }

  const strokeWidth = vdAttr(path, "strokeWidth");
  if (strokeWidth !== undefined) attrs.push(`stroke-width="${esc(strokeWidth)}"`);
  const lineCap = vdAttr(path, "strokeLineCap");
  if (lineCap !== undefined) attrs.push(`stroke-linecap="${esc(lineCap)}"`);
  const lineJoin = vdAttr(path, "strokeLineJoin");
  if (lineJoin !== undefined) attrs.push(`stroke-linejoin="${esc(lineJoin)}"`);
  const miterLimit = vdAttr(path, "strokeMiterLimit");
  if (miterLimit !== undefined) attrs.push(`stroke-miterlimit="${esc(miterLimit)}"`);

  if (name !== undefined) attrs.unshift(`id="${esc(name)}"`);
  return `${indent}<path ${attrs.join(" ")}/>`;
}

/// Builds the SVG transform for a VectorDrawable group. Android applies the
/// pivot-centered scale/rotation first, then the translation.
function vdGroupTransform(group: XmlElement): string {
  const translateX = parseNum(vdAttr(group, "translateX"), 0);
  const translateY = parseNum(vdAttr(group, "translateY"), 0);
  const pivotX = parseNum(vdAttr(group, "pivotX"), 0);
  const pivotY = parseNum(vdAttr(group, "pivotY"), 0);
  const scaleX = parseNum(vdAttr(group, "scaleX"), 1);
  const scaleY = parseNum(vdAttr(group, "scaleY"), 1);
  const rotation = parseNum(vdAttr(group, "rotation"), 0);

  const parts: string[] = [];
  if (translateX !== 0 || translateY !== 0) {
    parts.push(`translate(${fmtNum(translateX)} ${fmtNum(translateY)})`);
  }
  const hasPivot = pivotX !== 0 || pivotY !== 0;
  const hasPivotTransform = scaleX !== 1 || scaleY !== 1 || rotation !== 0;
  if (hasPivot && hasPivotTransform) parts.push(`translate(${fmtNum(pivotX)} ${fmtNum(pivotY)})`);
  if (rotation !== 0) parts.push(`rotate(${fmtNum(rotation)})`);
  if (scaleX !== 1 || scaleY !== 1) parts.push(`scale(${fmtNum(scaleX)} ${fmtNum(scaleY)})`);
  if (hasPivot && hasPivotTransform) {
    parts.push(`translate(${fmtNum(-pivotX)} ${fmtNum(-pivotY)})`);
  }
  return parts.join(" ");
}

function convertVdGroup(group: XmlElement, indent: string): string {
  const lines: string[] = [];
  const children = childElements(group).filter(
    (c) => localName(c) === "group" || localName(c) === "path" || localName(c) === "clip-path",
  );

  // VectorDrawable clip-paths clip the rest of their group; map them to an
  // SVG clipPath referenced from the group.
  const clips = children.filter((c) => localName(c) === "clip-path");
  let clipAttr = "";
  if (clips.length > 0) {
    const id = `vd-clip-${clipIdCounter++}`;
    const clipPaths = clips
      .map((c) => vdAttr(c, "pathData"))
      .filter((d): d is string => d !== undefined)
      .map((d) => `${indent}    <path d="${esc(d)}"/>`)
      .join("\n");
    if (clipPaths) {
      lines.push(`${indent}<clipPath id="${id}">`);
      lines.push(clipPaths);
      lines.push(`${indent}</clipPath>`);
      clipAttr = ` clip-path="url(#${id})"`;
    }
  }

  const transform = vdGroupTransform(group);
  const name = vdAttr(group, "name");
  const openAttrs =
    (name !== undefined ? ` id="${esc(name)}"` : "") +
    (transform ? ` transform="${transform}"` : "") +
    clipAttr;

  const inner: string[] = [];
  for (const child of children) {
    const tag = localName(child);
    if (tag === "group") inner.push(convertVdGroup(child, `${indent}  `));
    else if (tag === "path") {
      const converted = convertVdPath(child, `${indent}  `);
      if (converted) inner.push(converted);
    }
  }

  if (inner.length === 0 && lines.length === 0) return "";
  lines.push(`${indent}<g${openAttrs}>`);
  lines.push(...inner);
  lines.push(`${indent}</g>`);
  return lines.join("\n");
}

function vectorDrawableToSvg(text: string): string {
  clipIdCounter = 0;
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (!doc.documentElement) throw new Error("Not an Android VectorDrawable: invalid XML.");
  const vector = findFirst(doc.documentElement, "vector");
  if (!vector) throw new Error("Not an Android VectorDrawable: missing <vector> root element.");

  const viewportWidth = parseNum(vdAttr(vector, "viewportWidth") ?? vdAttr(vector, "width"), 24);
  const viewportHeight = parseNum(vdAttr(vector, "viewportHeight") ?? vdAttr(vector, "height"), 24);
  if (!(viewportWidth > 0) || !(viewportHeight > 0)) {
    throw new Error("Invalid Android VectorDrawable: bad viewport dimensions.");
  }
  const width = parseNum(vdAttr(vector, "width"), viewportWidth);
  const height = parseNum(vdAttr(vector, "height"), viewportHeight);

  const lines: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmtNum(width)}" height="${fmtNum(height)}" viewBox="0 0 ${fmtNum(viewportWidth)} ${fmtNum(viewportHeight)}">`,
  ];
  for (const child of childElements(vector)) {
    const tag = localName(child);
    if (tag === "group") {
      const converted = convertVdGroup(child, "  ");
      if (converted) lines.push(converted);
    } else if (tag === "path") {
      const converted = convertVdPath(child, "  ");
      if (converted) lines.push(converted);
    }
  }
  lines.push(`</svg>`);
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// SVG -> VectorDrawable
// ---------------------------------------------------------------------------

interface VdGroupAttrs {
  translateX?: number;
  translateY?: number;
  scaleX?: number;
  scaleY?: number;
  rotation?: number;
  pivotX?: number;
  pivotY?: number;
}

/// Decomposes an SVG transform list into nested VectorDrawable groups.
/// SVG applies transforms left-to-right, which nests exactly like groups.
function svgTransformToGroups(transform: string): VdGroupAttrs[] {
  const groups: VdGroupAttrs[] = [];
  const funcPattern = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  let consumed = false;
  while ((match = funcPattern.exec(transform)) !== null) {
    consumed = true;
    const kind = match[1].toLowerCase();
    const args = match[2]
      .split(/[\s,]+/)
      .filter((s) => s.length > 0)
      .map(Number);
    if (args.some((a) => !Number.isFinite(a))) {
      throw new Error(`Unsupported SVG transform: "${transform}".`);
    }
    if (kind === "translate") {
      groups.push({ translateX: args[0] ?? 0, translateY: args[1] ?? 0 });
    } else if (kind === "scale") {
      groups.push({ scaleX: args[0] ?? 1, scaleY: args[1] ?? args[0] ?? 1 });
    } else if (kind === "rotate") {
      groups.push({
        rotation: args[0] ?? 0,
        ...(args.length >= 3 ? { pivotX: args[1], pivotY: args[2] } : {}),
      });
    } else if (kind === "matrix") {
      if (args.length !== 6) throw new Error(`Unsupported SVG transform: "${transform}".`);
      const [a, b, c, d, e, f] = args;
      // Only diagonal matrices (scale + translate) map onto VectorDrawables.
      if (b === 0 && c === 0) {
        if (e !== 0 || f !== 0) groups.push({ translateX: e, translateY: f });
        if (a !== 1 || d !== 1) groups.push({ scaleX: a, scaleY: d });
      } else {
        throw new Error(`Unsupported SVG transform: "${transform}".`);
      }
    } else {
      throw new Error(`Unsupported SVG transform: "${transform}".`);
    }
  }
  if (!consumed && transform.trim() !== "") {
    throw new Error(`Unsupported SVG transform: "${transform}".`);
  }
  return groups;
}

function openVdGroup(attrs: VdGroupAttrs, name: string | undefined, indent: string): string {
  const parts: string[] = [];
  if (name !== undefined) parts.push(`android:name="${esc(name)}"`);
  if (attrs.rotation !== undefined && attrs.rotation !== 0) {
    parts.push(`android:rotation="${fmtNum(attrs.rotation)}"`);
  }
  if (attrs.pivotX !== undefined && attrs.pivotX !== 0) {
    parts.push(`android:pivotX="${fmtNum(attrs.pivotX)}"`);
  }
  if (attrs.pivotY !== undefined && attrs.pivotY !== 0) {
    parts.push(`android:pivotY="${fmtNum(attrs.pivotY)}"`);
  }
  if (attrs.scaleX !== undefined && attrs.scaleX !== 1) {
    parts.push(`android:scaleX="${fmtNum(attrs.scaleX)}"`);
  }
  if (attrs.scaleY !== undefined && attrs.scaleY !== 1) {
    parts.push(`android:scaleY="${fmtNum(attrs.scaleY)}"`);
  }
  if (attrs.translateX !== undefined && attrs.translateX !== 0) {
    parts.push(`android:translateX="${fmtNum(attrs.translateX)}"`);
  }
  if (attrs.translateY !== undefined && attrs.translateY !== 0) {
    parts.push(`android:translateY="${fmtNum(attrs.translateY)}"`);
  }
  return `${indent}<group${parts.length > 0 ? ` ${parts.join(" ")}` : ""}>`;
}

function convertSvgPath(
  path: XmlElement,
  style: Record<string, string>,
  inheritedOpacity: number,
  indent: string,
): string {
  const d = svgAttr(path, style, "d");
  if (d === undefined) return "";

  const elementOpacity = parseNum(svgAttr(path, style, "opacity"), 1);
  const opacity = inheritedOpacity * elementOpacity;

  const attrs: string[] = [`android:pathData="${esc(d)}"`];
  const name = path.getAttribute("id");
  if (name !== null && name !== "") attrs.unshift(`android:name="${esc(name)}"`);

  const fillRaw = svgAttr(path, style, "fill");
  const fillOpacity = parseNum(svgAttr(path, style, "fill-opacity"), 1) * opacity;
  if (fillRaw !== undefined && fillRaw !== "none") {
    const { color, alpha } = svgColorToVd(fillRaw, fillOpacity);
    if (color !== undefined) attrs.push(`android:fillColor="${esc(color)}"`);
    if (alpha !== undefined && alpha < 0.9999) {
      attrs.push(`android:fillAlpha="${fmtOpacity(alpha)}"`);
    }
  }

  const fillRule = svgAttr(path, style, "fill-rule") ?? svgAttr(path, style, "fillRule");
  if (fillRule !== undefined && fillRule.toLowerCase() === "evenodd") {
    attrs.push(`android:fillType="evenOdd"`);
  }

  const strokeRaw = svgAttr(path, style, "stroke");
  const strokeOpacity = parseNum(svgAttr(path, style, "stroke-opacity"), 1) * opacity;
  if (strokeRaw !== undefined && strokeRaw !== "none") {
    const { color, alpha } = svgColorToVd(strokeRaw, strokeOpacity);
    if (color !== undefined) attrs.push(`android:strokeColor="${esc(color)}"`);
    if (alpha !== undefined && alpha < 0.9999) {
      attrs.push(`android:strokeAlpha="${fmtOpacity(alpha)}"`);
    }
  }
  const strokeWidth = svgAttr(path, style, "stroke-width");
  if (strokeWidth !== undefined) attrs.push(`android:strokeWidth="${esc(strokeWidth)}"`);
  const lineCap = svgAttr(path, style, "stroke-linecap");
  if (lineCap !== undefined) attrs.push(`android:strokeLineCap="${esc(lineCap)}"`);
  const lineJoin = svgAttr(path, style, "stroke-linejoin");
  if (lineJoin !== undefined) attrs.push(`android:strokeLineJoin="${esc(lineJoin)}"`);
  const miterLimit = svgAttr(path, style, "stroke-miterlimit");
  if (miterLimit !== undefined) attrs.push(`android:strokeMiterLimit="${esc(miterLimit)}"`);

  return `${indent}<path ${attrs.join(" ")}/>`;
}

function convertSvgChildren(el: XmlElement, inheritedOpacity: number, indent: string): string[] {
  const lines: string[] = [];
  for (const child of childElements(el)) {
    const tag = localName(child).toLowerCase();
    if (tag === "defs" || tag === "metadata" || tag === "title" || tag === "desc") continue;
    if (tag === "clippath" || tag === "mask") continue;
    if (tag === "g" || tag === "svg" || tag === "a" || tag === "symbol") {
      lines.push(...convertSvgGroup(child, inheritedOpacity, indent));
    } else if (tag === "path") {
      const converted = convertSvgPath(child, parseStyle(child), inheritedOpacity, indent);
      if (converted) lines.push(converted);
    }
    // Other SVG shapes (rect/circle/...) have no VectorDrawable equivalent
    // and are skipped; paths carry the artwork.
  }
  return lines;
}

function convertSvgGroup(el: XmlElement, inheritedOpacity: number, indent: string): string[] {
  const style = parseStyle(el);
  const elementOpacity = parseNum(svgAttr(el, style, "opacity"), 1);
  const opacity = inheritedOpacity * elementOpacity;

  const name = el.getAttribute("id");
  const groupName = name !== null && name !== "" ? name : undefined;

  const transform = el.getAttribute("transform");
  let wrappers: VdGroupAttrs[] = [];
  if (transform !== null && transform.trim() !== "") {
    try {
      wrappers = svgTransformToGroups(transform);
    } catch {
      // Unrepresentable transforms (skew/general matrix) are dropped; the
      // artwork itself is still converted.
      wrappers = [];
    }
  }

  const isGroup = localName(el).toLowerCase() === "g";
  // A plain <g> with no transform flattens away, unless it carries a name
  // worth preserving as android:name.
  if (isGroup && wrappers.length === 0 && groupName !== undefined) wrappers = [{}];

  const innerIndent = wrappers.length > 0 ? `${indent}${"  ".repeat(wrappers.length)}` : indent;
  const inner = convertSvgChildren(el, opacity, innerIndent);
  if (inner.length === 0) return [];
  if (wrappers.length === 0) return inner;

  const lines: string[] = [];
  wrappers.forEach((attrs, i) => {
    lines.push(openVdGroup(attrs, i === 0 ? groupName : undefined, `${indent}${"  ".repeat(i)}`));
  });
  lines.push(...inner);
  for (let i = wrappers.length - 1; i >= 0; i--) {
    lines.push(`${indent}${"  ".repeat(i)}</group>`);
  }
  return lines;
}

function svgToVectorDrawable(text: string): string {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  if (!doc.documentElement) throw new Error("Not an SVG image: invalid XML.");
  const svg = findFirst(doc.documentElement, "svg");
  if (!svg) throw new Error("Not an SVG image: missing <svg> root element.");

  const viewBox = svg.getAttribute("viewBox") ?? "";
  const viewBoxNums = viewBox
    .split(/[\s,]+/)
    .filter((s) => s.length > 0)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  const widthAttr = svg.getAttribute("width");
  const heightAttr = svg.getAttribute("height");

  let viewportWidth = 24;
  let viewportHeight = 24;
  if (viewBoxNums.length >= 4) {
    viewportWidth = viewBoxNums[2];
    viewportHeight = viewBoxNums[3];
  } else {
    if (widthAttr !== null) viewportWidth = parseNum(widthAttr, viewportWidth);
    if (heightAttr !== null) viewportHeight = parseNum(heightAttr, viewportHeight);
  }
  if (!(viewportWidth > 0) || !(viewportHeight > 0)) {
    throw new Error("Invalid SVG: bad viewport dimensions.");
  }
  const width = widthAttr !== null ? parseNum(widthAttr, viewportWidth) : viewportWidth;
  const height = heightAttr !== null ? parseNum(heightAttr, viewportHeight) : viewportHeight;

  const lines: string[] = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<vector xmlns:android="${ANDROID_NS}"`,
    `    android:width="${fmtNum(width)}dp"`,
    `    android:height="${fmtNum(height)}dp"`,
    `    android:viewportWidth="${fmtNum(viewportWidth)}"`,
    `    android:viewportHeight="${fmtNum(viewportHeight)}">`,
  ];

  // A transform on the root svg element itself maps onto an outer group.
  const rootTransform = svg.getAttribute("transform");
  let rootWrappers: VdGroupAttrs[] = [];
  if (rootTransform !== null && rootTransform.trim() !== "") {
    try {
      rootWrappers = svgTransformToGroups(rootTransform);
    } catch {
      rootWrappers = [];
    }
  }

  const rootOpacity = parseNum(svg.getAttribute("opacity") ?? undefined, 1);
  const rootIndent = rootWrappers.length > 0 ? `    ${"  ".repeat(rootWrappers.length)}` : "    ";
  const inner = convertSvgChildren(svg, rootOpacity, rootIndent);
  rootWrappers.forEach((attrs, i) => {
    lines.push(openVdGroup(attrs, undefined, `    ${"  ".repeat(i)}`));
  });
  lines.push(...inner);
  for (let i = rootWrappers.length - 1; i >= 0; i--) {
    lines.push(`    ${"  ".repeat(i)}</group>`);
  }
  lines.push(`</vector>`);
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

class vectorDrawableHandler implements FormatHandler {
  public readonly name = "vectorDrawable";
  public supportedFormats = [
    Formats.VECTORDRAWABLE.builder("vectordrawable").fromTo(),
    Formats.SVG.builder("svg").fromTo(),
  ];
  public ready = false;

  async init() {
    this.ready = true;
  }

  async doConvert(
    inputFiles: FileData[],
    inputFormat: FileFormat,
    outputFormat: FileFormat,
  ): Promise<FileData[]> {
    const outputFiles: FileData[] = [];
    for (const inputFile of inputFiles) {
      const text = decode(inputFile.bytes);
      let converted: string;
      if (inputFormat.internal === "vectordrawable" && outputFormat.internal === "svg") {
        converted = vectorDrawableToSvg(text);
      } else if (inputFormat.internal === "svg" && outputFormat.internal === "vectordrawable") {
        converted = svgToVectorDrawable(text);
      } else {
        throw new TypeError(
          `Unsupported conversion: ${inputFormat.internal} -> ${outputFormat.internal}`,
        );
      }
      outputFiles.push({
        name: changeExt(inputFile.name, outputFormat.extension),
        bytes: encode(converted),
      });
    }
    return outputFiles;
  }
}

export default vectorDrawableHandler;
