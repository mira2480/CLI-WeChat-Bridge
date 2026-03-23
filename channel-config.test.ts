import path from "node:path";

import { describe, expect, test } from "bun:test";

import {
  buildWorkspaceKey,
  getWorkspaceChannelPaths,
  normalizeWorkspacePath,
} from "./channel-config.ts";

describe("workspace channel paths", () => {
  test("normalizes a workspace path to an absolute path", () => {
    const resolved = normalizeWorkspacePath(".");
    expect(path.isAbsolute(resolved)).toBe(true);
  });

  test("builds a stable workspace key for the same cwd", () => {
    const cwd = path.join("C:\\", "Users", "unlin", "Desktop", "Github", "repo");

    expect(buildWorkspaceKey(cwd)).toBe(buildWorkspaceKey(cwd));
  });

  test("builds different workspace paths for different cwd values", () => {
    const repoA = path.join("C:\\", "Users", "unlin", "Desktop", "Github", "repo-a");
    const repoB = path.join("C:\\", "Users", "unlin", "Desktop", "Github", "repo-b");

    const pathsA = getWorkspaceChannelPaths(repoA);
    const pathsB = getWorkspaceChannelPaths(repoB);

    expect(pathsA.workspaceDir).not.toBe(pathsB.workspaceDir);
    expect(pathsA.stateFile.endsWith("bridge-state.json")).toBe(true);
    expect(pathsA.endpointFile.endsWith("codex-panel-endpoint.json")).toBe(true);
  });
});
