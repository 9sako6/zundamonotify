#!/usr/bin/env bun

import { installBundledAssetFiles } from "../src/bundled-assets.js";
import { main } from "../src/cli.js";

await main({ filesByEvent: installBundledAssetFiles() });
