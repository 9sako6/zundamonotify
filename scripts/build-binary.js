#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const outfile = "./dist/zundamonotify-macos-arm64";
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
process.env.ZUNDAMONOTIFY_VERSION = version;

execFileSync(
  "bun",
  [
    "build",
    "./bin/bun-entry.js",
    "--compile",
    "--target=bun-darwin-arm64",
    "--env",
    "ZUNDAMONOTIFY_*",
    "--outfile",
    outfile,
  ],
  { stdio: "inherit" },
);

if (process.platform === "darwin") {
  try {
    execFileSync("codesign", ["--remove-signature", outfile], { stdio: "ignore" });
  } catch {
    // Bun の出力に署名がない場合はそのまま ad-hoc 署名するのだ
  }
  execFileSync("codesign", ["--force", "--sign", "-", outfile], { stdio: "inherit" });
}
