#!/usr/bin/env node

import { runTsEntry } from "./_run-entry.mjs";

runTsEntry("wechat-bridge.ts", ["--adapter", "claude"]);
