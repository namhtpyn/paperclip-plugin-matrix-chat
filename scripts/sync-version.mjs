// sync PLUGIN_VERSION in src/manifest.ts from package.json (single source of truth)
import { readFileSync, writeFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const path = new URL("../src/manifest.ts", import.meta.url);
const src = readFileSync(path, "utf8");
const out = src.replace(
  /export const PLUGIN_VERSION = "[^"]*";/,
  `export const PLUGIN_VERSION = "${pkg.version}";`
);
if (out === src && !src.includes(`PLUGIN_VERSION = "${pkg.version}"`)) {
  console.error("sync-version: PLUGIN_VERSION line not found in src/manifest.ts");
  process.exit(1);
}
writeFileSync(path, out);
console.log(`sync-version: manifest PLUGIN_VERSION -> ${pkg.version}`);
