#!/usr/bin/env bun

import { installBundledAssetFiles } from "../src/bundled-assets.js";
import { main } from "./cli.js";

installBundledAssetFiles();
await main();
