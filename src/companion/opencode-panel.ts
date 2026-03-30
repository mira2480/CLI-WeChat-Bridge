#!/usr/bin/env bun

import { spawn } from "node:child_process";
import path from "node:path";

import {
  OPENCODE_SERVER_HOST,
  buildCliEnvironment,
  resolveSpawnTarget,
} from "../bridge/bridge-adapters.shared.ts";
import { migrateLegacyChannelFiles } from "../wechat/channel-config.ts";
import {
  readLocalCompanionEndpoint,
  type LocalCompanionEndpoint,
} from "./local-companion-link.ts";

function log(message: string): void {
  process.stderr.write(`[opencode-panel] ${message}\n`);
}

type OpencodePanelCliOptions = {
  cwd: string;
};

export function parseCliArgs(argv: string[]): OpencodePanelCliOptions {
  let cwd = process.cwd();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: wechat-opencode [--cwd <path>]",
          "",
          'Starts the visible OpenCode panel and attaches it to the running "wechat-bridge-opencode" instance for the current directory.',
          'Use "wechat-opencode-start" when you want to bootstrap the bridge and panel together.',
          "",
        ].join("\n"),
      );
      process.exit(0);
    }

    if (arg === "--cwd") {
      if (!next) {
        throw new Error("--cwd requires a value");
      }
      cwd = path.resolve(next);
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { cwd };
}

export function resolveAttachUrl(endpoint: LocalCompanionEndpoint): string {
  if (typeof endpoint.serverUrl === "string" && endpoint.serverUrl) {
    return endpoint.serverUrl;
  }

  const port = endpoint.serverPort ?? endpoint.port;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(
      `The OpenCode bridge endpoint for ${endpoint.cwd} is missing a valid server port. Restart "wechat-bridge-opencode".`,
    );
  }

  return `http://${OPENCODE_SERVER_HOST}:${port}`;
}

export function resolveAttachSessionId(
  endpoint: LocalCompanionEndpoint,
): string | undefined {
  const sessionId = endpoint.sharedSessionId ?? endpoint.sharedThreadId;
  return typeof sessionId === "string" && sessionId.trim().length > 0
    ? sessionId
    : undefined;
}

export function buildAttachArgs(
  endpoint: LocalCompanionEndpoint,
): string[] {
  const args = ["attach", resolveAttachUrl(endpoint)];
  const sessionId = resolveAttachSessionId(endpoint);
  if (sessionId) {
    args.push("--session", sessionId);
  }
  return args;
}

type MinimalFetchResponse = {
  ok: boolean;
};

export async function resolveValidatedAttachSessionId(
  endpoint: LocalCompanionEndpoint,
  fetchImpl: (input: string) => Promise<MinimalFetchResponse> = (input) =>
    fetch(input) as Promise<MinimalFetchResponse>,
): Promise<string | undefined> {
  const sessionId = resolveAttachSessionId(endpoint);
  if (!sessionId) {
    return undefined;
  }

  try {
    const response = await fetchImpl(
      `${resolveAttachUrl(endpoint)}/session/${encodeURIComponent(sessionId)}`,
    );
    return response.ok ? sessionId : undefined;
  } catch {
    return undefined;
  }
}

export async function buildValidatedAttachArgs(
  endpoint: LocalCompanionEndpoint,
  fetchImpl?: (input: string) => Promise<MinimalFetchResponse>,
): Promise<string[]> {
  const args = ["attach", resolveAttachUrl(endpoint)];
  const sessionId = await resolveValidatedAttachSessionId(endpoint, fetchImpl);
  if (sessionId) {
    args.push("--session", sessionId);
  }
  return args;
}

async function main(): Promise<void> {
  migrateLegacyChannelFiles(log);
  const options = parseCliArgs(process.argv.slice(2));

  const endpoint = readLocalCompanionEndpoint(options.cwd);
  if (!endpoint || endpoint.kind !== "opencode") {
    throw new Error(
      `No active OpenCode bridge endpoint was found for ${options.cwd}. Start "wechat-bridge-opencode" in that directory first, or use "wechat-opencode-start" to bootstrap both.`,
    );
  }

  if (endpoint.renderMode && endpoint.renderMode !== "embedded") {
    throw new Error(
      `The OpenCode bridge endpoint for ${options.cwd} is not native yet (mode=${endpoint.renderMode}). Restart it from this workspace so the panel can attach cleanly.`,
    );
  }

  const env = buildCliEnvironment("opencode");
  const target = resolveSpawnTarget(endpoint.command, "opencode", { env });
  const requestedSessionId = resolveAttachSessionId(endpoint);
  const attachArgs = await buildValidatedAttachArgs(endpoint);
  if (requestedSessionId && !attachArgs.includes("--session")) {
    log(
      `Shared OpenCode session ${requestedSessionId} is no longer available. Attaching without an explicit session.`,
    );
  }
  const attachUrl = attachArgs[1] ?? resolveAttachUrl(endpoint);
  const child = spawn(target.file, [...target.args, ...attachArgs], {
    cwd: endpoint.cwd,
    env,
    stdio: "inherit",
    windowsHide: false,
  });

  child.once("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    log(`Failed to start opencode attach for ${attachUrl}: ${message}`);
    process.exit(1);
  });

  child.once("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

const isDirectRun = Boolean((import.meta as ImportMeta & { main?: boolean }).main);
if (isDirectRun) {
  main().catch((error) => {
    log(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
