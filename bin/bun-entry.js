#!/usr/bin/env bun

import { installBundledAssetFiles } from "../src/bundled-assets.js";

process.env.ZUNDAMONOTIFY_BUN_ENTRY = "1";
installBundledAssetFiles();

const { main } = await import("./cli.js");
await main();
