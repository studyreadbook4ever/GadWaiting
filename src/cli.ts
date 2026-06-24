#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

interface AnyConfig {
  check?: {
    endpoint?: string;
    timeoutMs?: number;
  };
  slots: Array<{
    id: string;
    mount: string;
    size: {
      width: number;
      height: number;
    };
    provider: {
      client: string;
      slot: string;
      scriptUrl?: string;
    };
    fallback: {
      assets: Array<{
        src: string;
        width: number;
        height: number;
      }>;
    };
  }>;
}

interface ImageSize {
  width: number;
  height: number;
  type: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const configPath = join(projectRoot, "gadwaiting.config.json");
const publicDir = join(projectRoot, "public");
const defaultFallbackHref = "https://eff0rtchung.kr/";
const commonFallbackAssets = [
  { src: "/house-ads/local-300x250.svg", width: 300, height: 250 },
  { src: "/house-ads/local-336x280.svg", width: 336, height: 280 },
  { src: "/house-ads/local-728x90.svg", width: 728, height: 90 },
  { src: "/house-ads/local-970x90.svg", width: 970, height: 90 },
  { src: "/house-ads/local-970x250.svg", width: 970, height: 250 },
  { src: "/house-ads/local-320x50.svg", width: 320, height: 50 },
  { src: "/house-ads/local-320x100.svg", width: 320, height: 100 },
  { src: "/house-ads/local-300x600.svg", width: 300, height: 600 },
  { src: "/house-ads/local-160x600.svg", width: 160, height: 600 }
];

const defaultConfig = {
  check: {
    intervalMs: 60000,
    timeoutMs: 2500,
    consecutiveFailures: 1,
    consecutiveSuccesses: 1,
    startHealthy: false
  },
  render: {
    reserveSpace: true,
    className: "gadwaiting"
  },
  slots: [
    {
      id: "sidebar-rectangle",
      mount: "#ad-sidebar",
      size: { width: 300, height: 250 },
      provider: {
        client: "ca-pub-1234567890123456",
        slot: "1234567890",
        format: "auto",
        fullWidthResponsive: true
      },
      fallback: {
        href: defaultFallbackHref,
        target: "_self",
        label: "Advertisement",
        alt: "GadWaiting fallback advertisement",
        assets: commonFallbackAssets
      }
    },
    {
      id: "top-leaderboard",
      mount: "#ad-leaderboard",
      size: { width: 728, height: 90 },
      provider: {
        client: "ca-pub-1234567890123456",
        slot: "2345678901",
        format: "auto",
        fullWidthResponsive: true
      },
      fallback: {
        href: defaultFallbackHref,
        target: "_self",
        label: "Advertisement",
        alt: "GadWaiting fallback advertisement",
        assets: commonFallbackAssets
      }
    }
  ]
};

async function main(): Promise<void> {
  const [command = "doctor", ...args] = process.argv.slice(2);

  switch (command) {
    case "init":
      await initProject(args.includes("--force"));
      return;
    case "doctor":
      await doctor();
      return;
    case "probe":
      await probe(args[0]);
      return;
    case "build":
      await build();
      return;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exitCode = 1;
  }
}

async function initProject(force: boolean): Promise<void> {
  await mkdir(join(publicDir, "house-ads"), { recursive: true });

  await writeIfMissing(configPath, `${JSON.stringify(defaultConfig, null, 2)}\n`, force);
  for (const asset of commonFallbackAssets) {
    await writeIfMissing(
      join(publicDir, asset.src),
      createPlaceholderSvg(asset.width, asset.height),
      force
    );
  }

  console.log("Initialized gadwaiting files.");
  await doctor();
}

async function writeIfMissing(path: string, content: string, force: boolean): Promise<void> {
  if (!force && existsSync(path)) {
    console.log(`kept ${relativePath(path)}`);
    return;
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  console.log(`wrote ${relativePath(path)}`);
}

async function doctor(): Promise<void> {
  const config = await readConfig();
  const requirements = collectRequirements(config);
  console.log(`Warning: if the ad provider script is not HTTP 200, times out, or returns an unfilled ad unit, GadWaiting will show your local fallback creative. Required assets: ${requirements}`);

  let hasProblem = false;
  const validatedAssets = new Set<string>();

  for (const slot of config.slots) {
    if (!slot.provider.client) {
      hasProblem = true;
      console.warn(`[warn] ${slot.id}: provider.client is required`);
    }

    if (!slot.provider.slot) {
      hasProblem = true;
      console.warn(`[warn] ${slot.id}: provider.slot is required`);
    }

    for (const asset of slot.fallback.assets) {
      const assetPath = resolveAssetPath(asset.src);
      const assetKey = `${asset.src}:${asset.width}x${asset.height}`;

      if (validatedAssets.has(assetKey)) {
        continue;
      }

      validatedAssets.add(assetKey);

      if (!assetPath) {
        console.log(`[skip] external asset ${asset.src}`);
        continue;
      }

      try {
        const info = await stat(assetPath);
        if (!info.isFile()) {
          hasProblem = true;
          console.warn(`[warn] ${relativePath(assetPath)} is not a file`);
          continue;
        }

        const size = await readImageSize(assetPath);
        if (!size) {
          hasProblem = true;
          console.warn(`[warn] ${relativePath(assetPath)} exists but its dimensions could not be read`);
          continue;
        }

        const matches = size.width === asset.width && size.height === asset.height;
        const prefix = matches ? "[ok]" : "[warn]";
        hasProblem = hasProblem || !matches;
        console.log(
          `${prefix} ${relativePath(assetPath)} ${size.width}x${size.height} ${size.type}, expected ${asset.width}x${asset.height}`
        );
      } catch {
        hasProblem = true;
        console.warn(`[warn] missing ${relativePath(assetPath)} (${asset.width}x${asset.height})`);
      }
    }
  }

  process.exitCode = hasProblem ? 1 : 0;
}

async function probe(urlArg: string | undefined): Promise<void> {
  const config = await readConfig();
  const url = urlArg ?? config.check?.endpoint ?? buildScriptUrl(config.slots[0].provider);
  const timeoutMs = config.check?.timeoutMs ?? 2500;
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal
    });
    const elapsed = Math.round(performance.now() - started);
    const ok = response.status === 200;
    console.log(`${ok ? "OK" : "FAIL"} HTTP ${response.status} in ${elapsed}ms: ${url}`);
    process.exitCode = ok ? 0 : 1;
  } catch (error) {
    const elapsed = Math.round(performance.now() - started);
    const reason = error instanceof Error ? error.message : String(error);
    console.log(`FAIL ${reason} in ${elapsed}ms: ${url}`);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
}

async function build(): Promise<void> {
  const sourcePath = join(projectRoot, "src", "gadwaiting.ts");
  const outputPath = join(projectRoot, "dist", "gadwaiting.js");
  const source = await readFile(sourcePath, "utf8");
  const output = stripTypeScriptTypes(source, {
    mode: "strip",
    sourceUrl: "gadwaiting.ts"
  });

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, output, "utf8");
  console.log(`built ${relativePath(outputPath)}`);
}

async function readConfig(): Promise<AnyConfig> {
  const raw = await readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as AnyConfig;

  if (!Array.isArray(parsed.slots) || parsed.slots.length === 0) {
    throw new Error("gadwaiting.config.json requires a non-empty slots array");
  }

  return parsed;
}

function collectRequirements(config: AnyConfig): string {
  const seen = new Set<string>();
  const parts: string[] = [];

  for (const slot of config.slots) {
    for (const asset of slot.fallback.assets) {
      const assetPath = resolveAssetPath(asset.src);
      const displayPath = assetPath ? relativePath(assetPath) : asset.src;
      const key = `${displayPath}:${asset.width}x${asset.height}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      parts.push(`${displayPath}: one ${asset.width}x${asset.height} image`);
    }
  }

  return parts.join(", ");
}

function buildScriptUrl(provider: { client: string; scriptUrl?: string }): string {
  const url = new URL(provider.scriptUrl ?? "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js");
  if (!url.searchParams.has("client")) {
    url.searchParams.set("client", provider.client);
  }
  return url.toString();
}

function resolveAssetPath(src: string): string | null {
  if (/^https?:\/\//i.test(src) || src.startsWith("data:")) {
    return null;
  }

  if (isAbsolute(src)) {
    return join(publicDir, src.slice(1));
  }

  if (src.startsWith(`public/`)) {
    return join(projectRoot, src);
  }

  return join(publicDir, src);
}

async function readImageSize(path: string): Promise<ImageSize | null> {
  const ext = extname(path).toLowerCase();

  if (ext === ".svg") {
    const text = await readFile(path, "utf8");
    return readSvgSize(text);
  }

  const buffer = await readFile(path);

  if (isPng(buffer)) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
      type: "png"
    };
  }

  if (isGif(buffer)) {
    return {
      width: buffer.readUInt16LE(6),
      height: buffer.readUInt16LE(8),
      type: "gif"
    };
  }

  if (isJpeg(buffer)) {
    return readJpegSize(buffer);
  }

  if (isWebp(buffer)) {
    return readWebpSize(buffer);
  }

  return null;
}

function readSvgSize(text: string): ImageSize | null {
  const width = readSvgLength(text, "width");
  const height = readSvgLength(text, "height");

  if (width && height) {
    return { width, height, type: "svg" };
  }

  const viewBox = text.match(/\bviewBox=["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*["']/i);
  if (!viewBox) {
    return null;
  }

  return {
    width: Math.round(Number(viewBox[1])),
    height: Math.round(Number(viewBox[2])),
    type: "svg"
  };
}

function readSvgLength(text: string, attr: "width" | "height"): number | null {
  const match = text.match(new RegExp(`\\b${attr}=["']\\s*([\\d.]+)(?:px)?\\s*["']`, "i"));
  return match ? Math.round(Number(match[1])) : null;
}

function readJpegSize(buffer: Buffer): ImageSize | null {
  let offset = 2;

  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1];
    offset += 2;

    if (marker === 0xd8 || marker === 0xd9) {
      continue;
    }

    const length = buffer.readUInt16BE(offset);
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);

    if (isStartOfFrame) {
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
        type: "jpeg"
      };
    }

    offset += length;
  }

  return null;
}

function readWebpSize(buffer: Buffer): ImageSize | null {
  const chunk = buffer.subarray(12, 16).toString("ascii");

  if (chunk === "VP8X" && buffer.length >= 30) {
    return {
      width: readUInt24LE(buffer, 24) + 1,
      height: readUInt24LE(buffer, 27) + 1,
      type: "webp"
    };
  }

  if (chunk === "VP8 " && buffer.length >= 30) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
      type: "webp"
    };
  }

  if (chunk === "VP8L" && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
      type: "webp"
    };
  }

  return null;
}

function readUInt24LE(buffer: Buffer, offset: number): number {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function isPng(buffer: Buffer): boolean {
  return buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

function isGif(buffer: Buffer): boolean {
  return buffer.length >= 10 && buffer.subarray(0, 3).toString("ascii") === "GIF";
}

function isJpeg(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8;
}

function isWebp(buffer: Buffer): boolean {
  return buffer.length >= 16 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
}

function createPlaceholderSvg(width: number, height: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#2563eb"/>
  <text x="20" y="${Math.max(32, Math.round(height / 2))}" fill="#fff" font-family="Arial, sans-serif" font-size="18" font-weight="700">GadWaiting... ${width}x${height}</text>
</svg>
`;
}

function relativePath(path: string): string {
  return path.startsWith(projectRoot) ? path.slice(projectRoot.length + 1) : path;
}

function printHelp(): void {
  console.log(`gadwaiting

Usage:
  npm run init              create config and sample fallback images
  npm run doctor            validate local fallback assets
  npm run probe [url]       check that an ad script returns HTTP 200
  npm run build             emit dist/gadwaiting.js
  npm run demo              start the local demo server
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
