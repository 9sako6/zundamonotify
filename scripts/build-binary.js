#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const outfile = "./dist/zundamonotify-macos-arm64";

execFileSync(
  "bun",
  [
    "build",
    "./bin/bun-entry.js",
    "--compile",
    "--target=bun-darwin-arm64",
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
