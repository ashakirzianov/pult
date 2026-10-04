#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - a build script that reads and writes repo files.
//
// Renders every desktop and web icon Pult ships from the sources in
// assets/pult/: the app icons, the favicons and the Windows `.ico`, for prod
// and dev, plus the dev web icons in apps/pult/public.
//
//   vp run icons:export          write them
//   vp run icons:check           fail if a written icon differs from a fresh render
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import sharp, { type Sharp } from "sharp";

import { BRAND_ASSET_PATHS, DEVELOPMENT_PUBLIC_ICON_OVERRIDES } from "../lib/brand-assets.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "../lib/icon-export.ts";

const repoRoot = NodePath.join(import.meta.dirname, "..", "..");
const SOURCES = {
  icon: "assets/pult/icon.svg",
  smallIcon: "assets/pult/small-icon.png",
} as const;

// Renders at or below this size use small-icon.png, which reads better than the
// full icon's bars and staff lines there. Anton has not confirmed this reading
// of small-icon.png; this is the one place that makes it.
const SMALL_ICON_MAX_SIZE = 32;

// Dev is black and white: the icon's four coloured fills become white.
export function toDevIconSvg(svg: string): string {
  let replaced = 0;
  const dev = svg.replace(/fill:\s*#(?!fff;)[0-9a-f]{6};/gi, () => {
    replaced += 1;
    return "fill: #fff;";
  });
  if (replaced !== 4) {
    throw new Error(`Expected the icon to have 4 coloured fills, found ${replaced}.`);
  }
  return dev;
}

const png = (image: Sharp) => image.png({ compressionLevel: 9 }).toBuffer();

// icon.svg sits on a 1024 artboard with the macOS margin around its body,
// which is what the macOS icon wants as it is.
const renderMacos = (svg: string) => png(sharp(Buffer.from(svg), { density: 72 }).resize(1024));

// Everywhere else the body fills the canvas, as upstream's renditions do.
async function renderFullBleed(svg: string, size: number) {
  const body = await sharp(Buffer.from(svg), { density: 72 * 4 })
    .trim({ threshold: 0 })
    .toBuffer();
  return png(sharp(body).resize(size, size, { fit: "contain", kernel: "lanczos3" }));
}

async function renderSmall(isDevelopment: boolean, size: number) {
  let image = sharp(NodePath.join(repoRoot, SOURCES.smallIcon)).trim({ threshold: 0 });
  // Dev's P is solid black: a white face would vanish into the white body at
  // these sizes. Greys from the yellow's (about 177) down go to black, and the
  // ramp from there to white keeps antialiased edges smooth. The second band
  // is alpha, left as it is.
  if (isDevelopment) {
    image = image.grayscale().linear([255 / (255 - 177), 1], [(-177 * 255) / (255 - 177), 0]);
  }
  const body = await image.toBuffer();
  return png(sharp(body).resize(size, size, { fit: "contain", kernel: "lanczos3" }));
}

const renderAt = (svg: string, isDevelopment: boolean, size: number) =>
  size <= SMALL_ICON_MAX_SIZE ? renderSmall(isDevelopment, size) : renderFullBleed(svg, size);

async function renderVariant(isDevelopment: boolean) {
  const sourceSvg = NodeFS.readFileSync(NodePath.join(repoRoot, SOURCES.icon), "utf8");
  const svg = isDevelopment ? toDevIconSvg(sourceSvg) : sourceSvg;
  const ico = encodePngIco(
    await Promise.all(
      WINDOWS_ICON_SIZES.map(async (size) => ({
        size,
        contents: await renderAt(svg, isDevelopment, size),
      })),
    ),
  );
  const paths = isDevelopment
    ? {
        macos: BRAND_ASSET_PATHS.developmentDesktopIconPng,
        universal: BRAND_ASSET_PATHS.developmentUniversalIconPng,
        windowsIco: BRAND_ASSET_PATHS.developmentWindowsIconIco,
        faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
        favicon16: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
        favicon32: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
        appleTouch: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
      }
    : {
        macos: BRAND_ASSET_PATHS.productionMacIconPng,
        universal: BRAND_ASSET_PATHS.productionLinuxIconPng,
        windowsIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
        faviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
        favicon16: BRAND_ASSET_PATHS.productionWebFavicon16Png,
        favicon32: BRAND_ASSET_PATHS.productionWebFavicon32Png,
        appleTouch: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
      };
  return new Map<string, Buffer>([
    [paths.macos, await renderMacos(svg)],
    [paths.universal, await renderFullBleed(svg, 1024)],
    [paths.windowsIco, ico],
    [paths.faviconIco, ico],
    [paths.favicon16, await renderAt(svg, isDevelopment, 16)],
    [paths.favicon32, await renderAt(svg, isDevelopment, 32)],
    [paths.appleTouch, await renderAt(svg, isDevelopment, 180)],
  ]);
}

export async function renderPultIcons(): Promise<Map<string, Buffer>> {
  const outputs = new Map([...(await renderVariant(false)), ...(await renderVariant(true))]);
  // The dev client serves its icons from public/, like upstream's apps/web.
  for (const override of DEVELOPMENT_PUBLIC_ICON_OVERRIDES) {
    const contents = outputs.get(override.sourceRelativePath);
    if (!contents) throw new Error(`No render for ${override.sourceRelativePath}.`);
    outputs.set(override.targetRelativePath, contents);
  }
  return outputs;
}

if (import.meta.main) {
  const checkOnly = process.argv.includes("--check");
  const stale: Array<string> = [];
  for (const [relativePath, contents] of await renderPultIcons()) {
    const target = NodePath.join(repoRoot, relativePath);
    const current = NodeFS.existsSync(target) ? NodeFS.readFileSync(target) : null;
    if (current?.equals(contents)) continue;
    if (checkOnly) {
      stale.push(relativePath);
    } else {
      NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
      NodeFS.writeFileSync(target, contents);
      console.log(`wrote ${relativePath}`);
    }
  }
  if (stale.length > 0) {
    console.error(`Stale icons; run vp run icons:export:\n${stale.join("\n")}`);
    process.exitCode = 1;
  }
}
