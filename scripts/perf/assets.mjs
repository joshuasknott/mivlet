import { gzipSync } from "node:zlib";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";

/**
 * Deterministic asset collection + logical chunking for performance budgets.
 * - Ignores Vite content hash suffixes via logicalChunkId so budgets are stable across rebuilds.
 * - Normalizes all relative paths to POSIX "/" separators for cross-platform (win/posix) consistency.
 * - Only size budgets (raw bytes preferred) are used as hard gates; timings/memory remain informational.
 * - See budget.test.mjs for coverage of missing dist, path seps, etc.
 */

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function formatKiB(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

export function formatMs(ms) {
  return `${Math.round(ms)} ms`;
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

export async function collectAssets(distDir, repoRoot) {
  const files = await walk(distDir);
  const assets = [];
  for (const file of files) {
    const extension = extname(file).toLowerCase();
    if (extension !== ".js" && extension !== ".css") continue;
    const info = await stat(file);
    const data = await readFile(file);
    assets.push({
      path: relative(repoRoot, file).replaceAll("\\", "/"),
      fileName: file.split(/[/\\]/).at(-1),
      type: extension.slice(1),
      bytes: info.size,
      gzipBytes: gzipSync(data).byteLength
    });
  }
  return assets.sort((left, right) => right.bytes - left.bytes);
}

/**
 * Map a hashed Vite asset name to a stable logical chunk id.
 * Hash suffixes are ignored so budgets stay stable across builds.
 * Supports real chunk names that contain hyphens and dots before the final hash suffix,
 * e.g. 'react-vendor-*.js', 'WarningCircle.es-*.js', 'index-*.js'.
 * Non .js/.css or non-matching (e.g. font files with full hashes) return undefined.
 */
export function logicalChunkId(fileName) {
  // Extract the logical base name before the final -hash.(js|css) suffix.
  // Supports hyphenated known chunks (react-vendor) and handles cases where the hash suffix itself
  // contains '-' (e.g. "SettingsPage-BD-qQMfd.js" must yield "SettingsPage", not "SettingsPage-BD").
  const match = /^(.+)-[A-Za-z0-9_-]+\.(js|css)$/.exec(fileName);
  if (!match) return undefined;
  const name = match[1];
  // Preserve the one known hyphenated vendor chunk name produced by manualChunks in vite.config.
  if (name === 'react-vendor' || name.endsWith('-vendor')) {
    return name;
  }
  // For everything else (routes like *Page, index, vendor, icon chunks), the logical id is the
  // segment before the first '-'. This correctly drops embedded '-' in hash portions.
  const firstDash = name.indexOf('-');
  if (firstDash > 0) {
    return name.slice(0, firstDash);
  }
  return name;
}

export function summarizeBundle(assets) {
  const jsAssets = assets.filter((asset) => asset.type === "js");
  const cssAssets = assets.filter((asset) => asset.type === "css");
  const sum = (items, key) => items.reduce((total, item) => total + item[key], 0);

  const totalJs = sum(jsAssets, "bytes");
  const totalCss = sum(cssAssets, "bytes");
  const totalJsGzip = sum(jsAssets, "gzipBytes");
  const totalCssGzip = sum(cssAssets, "gzipBytes");

  const initialEntryJs = jsAssets.find((asset) => logicalChunkId(asset.fileName) === "index");
  const routeChunks = {};
  for (const asset of jsAssets) {
    const chunkId = logicalChunkId(asset.fileName);
    if (!chunkId || chunkId === "index" || chunkId === "react-vendor" || chunkId === "vendor") {
      continue;
    }
    if (chunkId.endsWith("Page") || chunkId === "ApprovalPanel") {
      routeChunks[chunkId] = { rawBytes: asset.bytes, gzipBytes: asset.gzipBytes, path: asset.path };
    }
  }

  return {
    totalJsCss: {
      rawBytes: totalJs + totalCss,
      gzipBytes: totalJsGzip + totalCssGzip
    },
    css: {
      rawBytes: totalCss,
      gzipBytes: totalCssGzip
    },
    initialEntryJs: initialEntryJs
      ? { rawBytes: initialEntryJs.bytes, gzipBytes: initialEntryJs.gzipBytes, path: initialEntryJs.path }
      : undefined,
    routeChunks
  };
}
