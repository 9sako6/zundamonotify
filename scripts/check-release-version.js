#!/usr/bin/env node

import { readFileSync } from "node:fs";

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const expectedTag = `v${version}`;

if (!tag) {
  console.error("release tag を指定するのだ");
  process.exit(1);
}

if (tag !== expectedTag) {
  console.error(`release tag は ${expectedTag} にするのだ: got ${tag}`);
  process.exit(1);
}
