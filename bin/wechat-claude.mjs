#!/usr/bin/env node

import { runTsEntry } from "./_run-entry.mjs";

runTsEntry("local-companion.ts", ["--adapter", "claude"]);
