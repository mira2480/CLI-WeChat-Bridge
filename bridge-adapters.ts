import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn as spawnChild } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn as spawnPty } from "node-pty";
import type { IPty } from "node-pty";

import type {
  ApprovalRequest,
  BridgeAdapter,
  BridgeAdapterKind,
  BridgeAdapterState,
  BridgeEvent,
} from "./bridge-types.ts";
import {
  detectCliApproval,
  isHighRiskShellCommand,
  normalizeOutput,
  nowIso,
  truncatePreview,
} from "./bridge-utils.ts";

type AdapterOptions = {
  kind: BridgeAdapterKind;
  command: string;
  cwd: string;
  profile?: string;
};

type EventSink = (event: BridgeEvent) => void;

type SpawnTarget = {
  file: string;
  args: string[];
};

type ResolveSpawnTargetOptions = {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  forwardArgs?: string[];
};

type CodexRpcRequestId = string | number;

type CodexRpcPendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

type CodexQueuedNotification = {
  method: string;
  params: Record<string, unknown>;
};

type CodexPendingApprovalRequest = {
  requestId: CodexRpcRequestId;
  method: "item/commandExecution/requestApproval" | "item/fileChange/requestApproval";
};

export type CodexSessionMeta = {
  id?: string;
  timestamp?: string;
  cwd?: string;
  source?: string;
};

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const WINDOWS_DIRECT_EXECUTABLE_EXTENSIONS = [".exe", ".cmd", ".bat", ".com"];
const WINDOWS_POWERSHELL_EXTENSION = ".ps1";
const CODEX_SESSION_POLL_INTERVAL_MS = 500;
const CODEX_SESSION_MATCH_WINDOW_MS = 120_000;
const CODEX_RECENT_SESSION_KEY_LIMIT = 64;
const INTERRUPT_SETTLE_DELAY_MS = 1_500;
const CODEX_STARTUP_WARMUP_MS = 1_200;
const CODEX_APP_SERVER_HOST = "127.0.0.1";
const CODEX_APP_SERVER_SESSION_SOURCE = "wechat_bridge";
const CODEX_APP_SERVER_READY_TIMEOUT_MS = 10_000;
const CODEX_APP_SERVER_LOG_LIMIT = 12_000;
const CODEX_RPC_CONNECT_RETRY_MS = 150;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getCodexRpcRequestId(value: unknown): CodexRpcRequestId | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function getNotificationThreadId(params: unknown): string | null {
  if (!isRecord(params)) {
    return null;
  }

  if (typeof params.threadId === "string") {
    return params.threadId;
  }

  if (isRecord(params.thread) && typeof params.thread.id === "string") {
    return params.thread.id;
  }

  return null;
}

function getNotificationTurnId(params: unknown): string | null {
  if (!isRecord(params)) {
    return null;
  }

  if (typeof params.turnId === "string") {
    return params.turnId;
  }

  if (isRecord(params.turn) && typeof params.turn.id === "string") {
    return params.turn.id;
  }

  return null;
}

function describeUnknownError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function normalizeCodexRpcError(error: unknown): string {
  if (isRecord(error)) {
    const message =
      typeof error.message === "string"
        ? error.message
        : typeof error.code === "number"
          ? `RPC error ${error.code}`
          : "";
    const data =
      typeof error.data === "string"
        ? error.data
        : typeof error.details === "string"
          ? error.details
          : "";
    const combined = [message, data].filter(Boolean).join(": ");
    if (combined) {
      return combined;
    }
  }

  return describeUnknownError(error);
}

function coerceWebSocketMessageData(data: unknown): string | null {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }

  return null;
}

export function buildCodexApprovalRequest(
  method: string,
  params: unknown,
): ApprovalRequest | null {
  if (!isRecord(params)) {
    return null;
  }

  if (method === "item/commandExecution/requestApproval") {
    const command = typeof params.command === "string" ? params.command : "";
    const cwd = typeof params.cwd === "string" ? params.cwd : "";
    const reason = typeof params.reason === "string" ? params.reason : "";
    const preview =
      command && cwd
        ? `${command} (${cwd})`
        : command || reason || "Command execution approval requested.";

    return {
      source: "cli",
      summary: reason
        ? `Codex needs approval before running a command: ${truncatePreview(reason, 160)}`
        : "Codex needs approval before running a command.",
      commandPreview: truncatePreview(preview, 180),
    };
  }

  if (method === "item/fileChange/requestApproval") {
    const grantRoot = typeof params.grantRoot === "string" ? params.grantRoot : "";
    const reason = typeof params.reason === "string" ? params.reason : "";
    const preview = grantRoot || reason || "File change approval requested.";

    return {
      source: "cli",
      summary: reason
        ? `Codex needs approval before applying a file change: ${truncatePreview(reason, 160)}`
        : "Codex needs approval before applying a file change.",
      commandPreview: truncatePreview(preview, 180),
    };
  }

  return null;
}

export function extractCodexFinalTextFromItem(item: unknown): string | null {
  if (!isRecord(item) || item.type !== "agentMessage" || item.phase !== "final_answer") {
    return null;
  }

  const text = typeof item.text === "string" ? normalizeOutput(item.text).trim() : "";
  return text || null;
}

function getEnvValue(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const direct = env[key];
  if (direct !== undefined) {
    return direct;
  }

  const matchedKey = Object.keys(env).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  return matchedKey ? env[matchedKey] : undefined;
}

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isPathLikeCommand(command: string): boolean {
  return (
    path.isAbsolute(command) ||
    command.startsWith(".") ||
    command.includes("/") ||
    command.includes("\\")
  );
}

function getWindowsCommandExtensions(
  env: Record<string, string | undefined>,
): string[] {
  const configured = (getEnvValue(env, "PATHEXT") ?? "")
    .split(";")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  const ordered = [...WINDOWS_DIRECT_EXECUTABLE_EXTENSIONS, "", WINDOWS_POWERSHELL_EXTENSION];
  for (const extension of configured) {
    if (!ordered.includes(extension)) {
      ordered.push(extension);
    }
  }
  return ordered;
}

function expandCommandCandidates(
  command: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): string[] {
  if (platform !== "win32") {
    return [command];
  }

  if (path.extname(command)) {
    return [command];
  }

  return getWindowsCommandExtensions(env).map((extension) => `${command}${extension}`);
}

function resolvePathLikeCommand(
  command: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): string | undefined {
  const absoluteCommand = path.resolve(command);
  for (const candidate of expandCommandCandidates(absoluteCommand, platform, env)) {
    if (fileExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function findCommandOnPath(
  command: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): string | undefined {
  const pathEntries = (getEnvValue(env, "PATH") ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const candidates = expandCommandCandidates(command, platform, env);
  for (const directory of pathEntries) {
    for (const candidate of candidates) {
      const candidatePath = path.join(directory, candidate);
      if (fileExists(candidatePath)) {
        return candidatePath;
      }
    }
  }

  return undefined;
}

function resolveCommandPath(
  command: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): string | undefined {
  if (isPathLikeCommand(command)) {
    return resolvePathLikeCommand(command, platform, env);
  }

  return findCommandOnPath(command, platform, env);
}

function resolveCmdExe(env: Record<string, string | undefined>): string {
  const systemRoot = getEnvValue(env, "SystemRoot") ?? getEnvValue(env, "SYSTEMROOT");
  const configured =
    getEnvValue(env, "ComSpec") ??
    getEnvValue(env, "COMSPEC") ??
    (systemRoot ? `${systemRoot.replace(/[\\/]$/, "")}\\System32\\cmd.exe` : undefined);

  return configured || "cmd.exe";
}

function quoteForCmd(argument: string): string {
  if (!argument) {
    return '""';
  }

  if (!/[\s"]/u.test(argument)) {
    return argument;
  }

  return `"${argument.replace(/"/g, '""')}"`;
}

function wrapWithCmdExe(
  scriptPath: string,
  extraArgs: string[],
  env: Record<string, string | undefined>,
): SpawnTarget {
  const commandLine = [quoteForCmd(scriptPath), ...extraArgs.map(quoteForCmd)].join(" ");
  return {
    file: resolveCmdExe(env),
    args: ["/d", "/s", "/c", commandLine],
  };
}

function resolveBundledWindowsExe(
  kind: Extract<BridgeAdapterKind, "codex" | "claude">,
  launcherPath: string,
): string | undefined {
  const launcherDirectory = path.dirname(launcherPath);
  const openAiDirectory = path.join(launcherDirectory, "node_modules", "@openai");
  if (!fs.existsSync(openAiDirectory)) {
    return undefined;
  }

  const vendorSegments = [
    "vendor",
    "x86_64-pc-windows-msvc",
    kind,
    `${kind}.exe`,
  ];

  const directCandidate = path.join(
    openAiDirectory,
    `${kind}-win32-x64`,
    ...vendorSegments,
  );
  if (fileExists(directCandidate)) {
    return directCandidate;
  }

  const packageCandidate = path.join(
    openAiDirectory,
    kind,
    "node_modules",
    "@openai",
    `${kind}-win32-x64`,
    ...vendorSegments,
  );
  if (fileExists(packageCandidate)) {
    return packageCandidate;
  }

  const dirEntries = fs.readdirSync(openAiDirectory, { withFileTypes: true });
  for (const entry of dirEntries) {
    if (!entry.isDirectory() || !entry.name.startsWith(`.${kind}-`)) {
      continue;
    }

    const nestedCandidate = path.join(
      openAiDirectory,
      entry.name,
      "node_modules",
      "@openai",
      `${kind}-win32-x64`,
      ...vendorSegments,
    );
    if (fileExists(nestedCandidate)) {
      return nestedCandidate;
    }
  }

  return undefined;
}

function buildCliEnvironment(kind: BridgeAdapterKind): Record<string, string> {
  if (kind === "codex" || kind === "claude") {
    const env: Record<string, string> = {
      TERM: process.env.TERM || "xterm-256color",
    };

    const keys = [
      "PATH",
      "PATHEXT",
      "ComSpec",
      "COMSPEC",
      "SystemRoot",
      "SYSTEMROOT",
      "USERPROFILE",
      "HOME",
      "APPDATA",
      "LOCALAPPDATA",
      "TEMP",
      "TMP",
      "OS",
      "ProgramFiles",
      "ProgramFiles(x86)",
      "CommonProgramFiles",
      "CommonProgramFiles(x86)",
    ] as const;

    for (const key of keys) {
      const value = process.env[key];
      if (value) {
        env[key] = value;
      }
    }

    if (!env.HOME && env.USERPROFILE) {
      env.HOME = env.USERPROFILE;
    }

    return env;
  }

  return {
    ...process.env,
    TERM: process.env.TERM || "xterm-256color",
  } as Record<string, string>;
}

async function reserveLocalPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, CODEX_APP_SERVER_HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not reserve a local Codex app-server port.")));
        return;
      }

      const { port } = address;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForTcpPort(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host, port });
      const finish = (value: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(value);
      };

      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
      socket.setTimeout(500);
    });

    if (connected) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error(`Timed out waiting for Codex app-server on ${host}:${port}.`);
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function appendBoundedLog(existing: string, chunk: string): string {
  const next = existing ? `${existing}${chunk}` : chunk;
  if (next.length <= CODEX_APP_SERVER_LOG_LIMIT) {
    return next;
  }
  return next.slice(next.length - CODEX_APP_SERVER_LOG_LIMIT);
}

function normalizeComparablePath(filePath: string): string {
  return path.resolve(filePath).replace(/\//g, "\\").toLowerCase();
}

function buildCodexSessionDayPath(date: Date): string | null {
  const homeDirectory = process.env.USERPROFILE ?? process.env.HOME;
  if (!homeDirectory) {
    return null;
  }

  return path.join(
    homeDirectory,
    ".codex",
    "sessions",
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  );
}

function readCodexSessionMeta(filePath: string): CodexSessionMeta | null {
  try {
    const firstLine = fs.readFileSync(filePath, "utf8").split(/\r?\n/, 1)[0]?.trim();
    if (!firstLine) {
      return null;
    }

    const parsed = JSON.parse(firstLine) as {
      type?: string;
      payload?: CodexSessionMeta;
    };
    if (parsed.type !== "session_meta" || !parsed.payload) {
      return null;
    }

    return parsed.payload;
  } catch {
    return null;
  }
}

export function matchesCodexSessionMeta(
  meta: CodexSessionMeta | null | undefined,
  options: {
    cwd: string;
    startedAtMs: number;
    sessionSource?: string;
  },
): boolean {
  if (!meta?.cwd) {
    return false;
  }

  if (normalizeComparablePath(meta.cwd) !== normalizeComparablePath(options.cwd)) {
    return false;
  }

  if (options.sessionSource && meta.source !== options.sessionSource) {
    return false;
  }

  const sessionStartedAtMs = meta.timestamp ? Date.parse(meta.timestamp) : Number.NaN;
  if (
    Number.isFinite(sessionStartedAtMs) &&
    sessionStartedAtMs < options.startedAtMs - CODEX_SESSION_MATCH_WINDOW_MS
  ) {
    return false;
  }

  return true;
}

function findCodexSessionFile(
  cwd: string,
  startedAtMs: number,
  sessionSource?: string,
): string | null {
  const dayDirectories = [new Date(), new Date(startedAtMs), new Date(startedAtMs - 86_400_000)]
    .map(buildCodexSessionDayPath)
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index)
    .filter((directory) => fs.existsSync(directory));

  const candidates: Array<{
    filePath: string;
    modifiedAtMs: number;
    sessionStartedAtMs: number;
  }> = [];

  for (const directory of dayDirectories) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      const filePath = path.join(directory, entry.name);
      const stats = fs.statSync(filePath);
      if (stats.mtimeMs < startedAtMs - CODEX_SESSION_MATCH_WINDOW_MS) {
        continue;
      }

      const meta = readCodexSessionMeta(filePath);
      if (!matchesCodexSessionMeta(meta, { cwd, startedAtMs, sessionSource })) {
        continue;
      }

      const sessionStartedAtMs = meta?.timestamp ? Date.parse(meta.timestamp) : Number.NaN;
      candidates.push({
        filePath,
        modifiedAtMs: stats.mtimeMs,
        sessionStartedAtMs,
      });
    }
  }

  candidates.sort((left, right) => {
    const leftDistance = Number.isFinite(left.sessionStartedAtMs)
      ? Math.abs(left.sessionStartedAtMs - startedAtMs)
      : Number.POSITIVE_INFINITY;
    const rightDistance = Number.isFinite(right.sessionStartedAtMs)
      ? Math.abs(right.sessionStartedAtMs - startedAtMs)
      : Number.POSITIVE_INFINITY;

    if (leftDistance !== rightDistance) {
      return leftDistance - rightDistance;
    }
    return right.modifiedAtMs - left.modifiedAtMs;
  });

  return candidates[0]?.filePath ?? null;
}

export function resolveSpawnTarget(
  command: string,
  kind: BridgeAdapterKind,
  options: ResolveSpawnTargetOptions = {},
): SpawnTarget {
  const trimmed = command.trim();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const forwardArgs = options.forwardArgs ?? [];

  if (!trimmed) {
    return { file: trimmed, args: [...forwardArgs] };
  }

  const resolved = resolveCommandPath(trimmed, platform, env) ?? trimmed;
  if (platform !== "win32" || (kind !== "codex" && kind !== "claude")) {
    return { file: resolved, args: [...forwardArgs] };
  }

  const bundledExe = resolveBundledWindowsExe(kind, resolved);
  if (bundledExe) {
    return { file: bundledExe, args: [...forwardArgs] };
  }

  const extension = path.extname(resolved).toLowerCase();
  if (WINDOWS_DIRECT_EXECUTABLE_EXTENSIONS.includes(extension)) {
    if (extension === ".cmd" || extension === ".bat") {
      return wrapWithCmdExe(resolved, forwardArgs, env);
    }
    return { file: resolved, args: [...forwardArgs] };
  }

  if (extension === WINDOWS_POWERSHELL_EXTENSION) {
    const siblingCmd = resolved.slice(0, -extension.length) + ".cmd";
    if (fileExists(siblingCmd)) {
      return wrapWithCmdExe(siblingCmd, forwardArgs, env);
    }
  }

  return { file: resolved, args: [...forwardArgs] };
}

abstract class AbstractPtyAdapter implements BridgeAdapter {
  protected readonly options: AdapterOptions;
  protected pty: IPty | null = null;
  protected eventSink: EventSink = () => undefined;
  protected completionTimer: ReturnType<typeof setTimeout> | null = null;
  protected state: BridgeAdapterState;
  protected hasAcceptedInput = false;
  protected shuttingDown = false;
  protected currentPreview = "(idle)";
  protected pendingApproval: ApprovalRequest | null = null;

  constructor(options: AdapterOptions) {
    this.options = options;
    this.state = {
      kind: options.kind,
      status: "stopped",
      cwd: options.cwd,
      command: options.command,
      profile: options.profile,
    };
  }

  setEventSink(sink: EventSink): void {
    this.eventSink = sink;
  }

  async start(): Promise<void> {
    if (this.pty) {
      return;
    }

    this.setStatus("starting", `Starting ${this.options.kind} adapter...`);

    let spawnTarget: SpawnTarget | null = null;
    try {
      spawnTarget = resolveSpawnTarget(this.options.command, this.options.kind);
      const ptyProcess = spawnPty(
        spawnTarget.file,
        [...spawnTarget.args, ...this.buildSpawnArgs()],
        {
          name: "xterm-color",
          cols: DEFAULT_COLS,
          rows: DEFAULT_ROWS,
          cwd: this.options.cwd,
          env: this.buildEnv(),
          useConpty: true,
        },
      );

      this.pty = ptyProcess;
      this.shuttingDown = false;
      this.hasAcceptedInput = false;
      this.state.pid = ptyProcess.pid;
      this.state.startedAt = nowIso();
      this.state.status = "idle";
      this.state.pendingApproval = null;

      ptyProcess.onData((data) => this.handleData(data));
      ptyProcess.onExit(({ exitCode }) => this.handleExit(exitCode));

      this.afterStart();
      this.setStatus("idle", `${this.options.kind} adapter is ready.`);
    } catch (err) {
      this.state.status = "error";
      this.emit({
        type: "fatal_error",
        message: `Failed to start ${this.options.kind}${spawnTarget ? ` (${spawnTarget.file})` : ""}: ${String(err)}`,
        timestamp: nowIso(),
      });
      throw err;
    }
  }

  async sendInput(text: string): Promise<void> {
    if (!this.pty) {
      throw new Error(`${this.options.kind} adapter is not running.`);
    }

    this.hasAcceptedInput = true;
    this.currentPreview = truncatePreview(text);
    this.state.lastInputAt = nowIso();
    this.pendingApproval = null;
    this.state.pendingApproval = null;
    this.writeToPty(this.prepareInput(text));
    this.setStatus("busy");
    this.scheduleTaskComplete(this.defaultCompletionDelayMs());
  }

  async interrupt(): Promise<boolean> {
    if (!this.pty) {
      return false;
    }

    this.writeToPty("\u0003");
    this.scheduleTaskComplete(INTERRUPT_SETTLE_DELAY_MS);
    this.emit({
      type: "status",
      status: this.state.status,
      message: "Interrupt signal sent to the worker.",
      timestamp: nowIso(),
    });
    return true;
  }

  async reset(): Promise<void> {
    await this.dispose();
    await this.start();
  }

  async resolveApproval(action: "confirm" | "deny"): Promise<boolean> {
    if (!this.pendingApproval) {
      return false;
    }

    const handled = await this.applyApproval(action, this.pendingApproval);
    if (!handled) {
      return false;
    }

    this.pendingApproval = null;
    this.state.pendingApproval = null;
    return true;
  }

  async dispose(): Promise<void> {
    this.clearCompletionTimer();
    this.pendingApproval = null;
    this.state.pendingApproval = null;

    if (!this.pty) {
      this.state.status = "stopped";
      return;
    }

    this.shuttingDown = true;
    try {
      this.pty.kill();
    } catch {
      // Best effort shutdown.
    }
    this.pty = null;
    this.state.status = "stopped";
    this.state.pid = undefined;
  }

  getState(): BridgeAdapterState {
    return JSON.parse(JSON.stringify(this.state)) as BridgeAdapterState;
  }

  protected abstract buildSpawnArgs(): string[];

  protected afterStart(): void {
    // Optional hook.
  }

  protected prepareInput(text: string): string {
    return `${text.replace(/\r?\n/g, "\r")}\r`;
  }

  protected defaultCompletionDelayMs(): number {
    return 5_000;
  }

  protected async applyApproval(
    action: "confirm" | "deny",
    pendingApproval: ApprovalRequest,
  ): Promise<boolean> {
    if (!this.pty) {
      return false;
    }

    const input =
      action === "confirm"
        ? pendingApproval.confirmInput ?? "y\r"
        : pendingApproval.denyInput ?? "n\r";
    this.setStatus("busy");
    this.writeToPty(input);
    this.scheduleTaskComplete(this.defaultCompletionDelayMs());
    return true;
  }

  protected buildEnv(): Record<string, string> {
    return buildCliEnvironment(this.options.kind);
  }

  protected emit(event: BridgeEvent): void {
    this.eventSink(event);
  }

  protected setStatus(
    status: BridgeAdapterState["status"],
    message?: string,
  ): void {
    this.state.status = status;
    this.emit({
      type: "status",
      status,
      message,
      timestamp: nowIso(),
    });
  }

  protected scheduleTaskComplete(delayMs: number): void {
    if (!this.hasAcceptedInput || this.state.status !== "busy") {
      return;
    }

    this.clearCompletionTimer();
    this.completionTimer = setTimeout(() => {
      this.completionTimer = null;
      if (this.state.status !== "busy") {
        return;
      }
      this.setStatus("idle");
      this.emit({
        type: "task_complete",
        summary: this.currentPreview,
        timestamp: nowIso(),
      });
    }, delayMs);
  }

  protected clearCompletionTimer(): void {
    if (!this.completionTimer) {
      return;
    }
    clearTimeout(this.completionTimer);
    this.completionTimer = null;
  }

  protected writeToPty(data: string): void {
    this.pty?.write(data);
  }

  protected handleData(rawText: string): void {
    const text = normalizeOutput(rawText);
    if (!text) {
      return;
    }

    this.state.lastOutputAt = nowIso();
    if (!this.hasAcceptedInput) {
      return;
    }

    if (!this.pendingApproval) {
      const approval = detectCliApproval(text);
      if (approval) {
        this.pendingApproval = approval;
        this.state.pendingApproval = approval;
        this.setStatus("awaiting_approval", "CLI approval is required.");
        this.emit({
          type: "approval_required",
          request: approval,
          timestamp: nowIso(),
        });
        return;
      }
    }

    this.emit({
      type: "stdout",
      text,
      timestamp: nowIso(),
    });

    if (this.state.status === "busy") {
      this.scheduleTaskComplete(this.defaultCompletionDelayMs());
    }
  }

  protected handleExit(exitCode: number | undefined): void {
    this.clearCompletionTimer();
    const expectedShutdown = this.shuttingDown;
    this.shuttingDown = false;
    this.pty = null;
    this.state.status = "stopped";
    this.state.pid = undefined;
    this.pendingApproval = null;
    this.state.pendingApproval = null;

    if (expectedShutdown) {
      this.emit({
        type: "status",
        status: "stopped",
        message: `${this.options.kind} worker stopped.`,
        timestamp: nowIso(),
      });
      return;
    }

    const exitLabel =
      typeof exitCode === "number" ? `code ${exitCode}` : "an unknown code";
    this.emit({
      type: "fatal_error",
      message: `${this.options.kind} worker exited unexpectedly with ${exitLabel}.`,
      timestamp: nowIso(),
    });
  }
}

class CodexPtyAdapter extends AbstractPtyAdapter {
  private appServer: ChildProcessWithoutNullStreams | null = null;
  private appServerPort: number | null = null;
  private appServerShuttingDown = false;
  private appServerLog = "";
  private rpcSocket: WebSocket | null = null;
  private rpcShuttingDown = false;
  private rpcRequestCounter = 0;
  private pendingRpcRequests = new Map<string, CodexRpcPendingRequest>();
  private currentThreadId: string | null = null;
  private currentTurnId: string | null = null;
  private pendingTurnStart = false;
  private interruptPendingTurnStart = false;
  private pendingApprovalRequest: CodexPendingApprovalRequest | null = null;
  private queuedTurnNotifications: CodexQueuedNotification[] = [];
  private queuedTurnServerRequests: Array<{
    requestId: CodexRpcRequestId;
    method: CodexPendingApprovalRequest["method"];
    params: Record<string, unknown>;
  }> = [];
  private currentTurnFinalMessages = new Map<string, string>();
  private currentTurnDeltaByItem = new Map<string, string>();
  private currentTurnError: string | null = null;
  private startupBlocker: string | null = null;
  private warmupUntilMs = 0;
  private localInputListener: ((chunk: string | Buffer) => void) | null = null;
  private interruptTimer: ReturnType<typeof setTimeout> | null = null;

  override async start(): Promise<void> {
    if (this.pty) {
      return;
    }

    await this.startAppServer();
    await this.connectRpcClient();

    try {
      await super.start();
    } catch (err) {
      await this.disconnectRpcClient();
      await this.stopAppServer();
      throw err;
    }
  }

  protected buildSpawnArgs(): string[] {
    if (!this.appServerPort) {
      throw new Error("Codex app-server is not ready.");
    }

    const args = [
      "--enable",
      "tui_app_server",
      "--remote",
      `ws://${CODEX_APP_SERVER_HOST}:${this.appServerPort}`,
      "--no-alt-screen",
    ];
    if (this.options.profile) {
      args.push("--profile", this.options.profile);
    }
    return args;
  }

  protected override afterStart(): void {
    this.warmupUntilMs = Date.now() + CODEX_STARTUP_WARMUP_MS;
    this.attachLocalInputForwarding();
  }

  override async sendInput(text: string): Promise<void> {
    if (!this.pty || !this.rpcSocket) {
      throw new Error("codex adapter is not running.");
    }
    if (this.state.status === "busy") {
      throw new Error("codex is still working. Wait for the current reply or use /stop.");
    }
    if (this.pendingApproval) {
      throw new Error("A Codex approval request is pending. Reply with /confirm <code> or /deny.");
    }
    if (this.startupBlocker) {
      throw new Error("Codex is waiting for local terminal input before the session can continue.");
    }

    await delay(this.warmupUntilMs - Date.now());
    if (!this.pty) {
      throw new Error("codex adapter is not running.");
    }
    if (this.startupBlocker) {
      throw new Error("Codex is waiting for local terminal input before the session can continue.");
    }

    this.clearInterruptTimer();
    this.hasAcceptedInput = true;
    this.currentPreview = truncatePreview(text);
    this.state.lastInputAt = nowIso();
    this.setStatus("busy");

    this.resetCurrentTurnState({ preserveThread: true });

    try {
      const threadId = await this.ensureThreadStarted();
      this.pendingTurnStart = true;

      const response = await this.sendRpcRequest("turn/start", {
        threadId,
        input: [
          {
            type: "text",
            text,
            text_elements: [],
          },
        ],
        cwd: this.options.cwd,
      });

      const turnId = this.extractTurnIdFromResponse(response);
      if (!turnId) {
        throw new Error("Codex did not return a turn id for this request.");
      }

      this.bindCurrentTurn(turnId);
      if (this.interruptPendingTurnStart) {
        await this.requestActiveTurnInterrupt();
      }
    } catch (err) {
      this.resetCurrentTurnState({ preserveThread: true });
      this.setStatus("idle");
      throw err;
    }
  }

  override async interrupt(): Promise<boolean> {
    if (!this.rpcSocket || !this.currentThreadId) {
      return false;
    }

    if (this.pendingTurnStart && !this.currentTurnId) {
      this.interruptPendingTurnStart = true;
      this.armInterruptFallback();
      return true;
    }

    if (!this.currentTurnId) {
      return false;
    }

    this.pendingApproval = null;
    this.state.pendingApproval = null;
    this.pendingApprovalRequest = null;
    this.interruptPendingTurnStart = false;
    await this.requestActiveTurnInterrupt();
    this.armInterruptFallback();
    return true;
  }

  override async resolveApproval(action: "confirm" | "deny"): Promise<boolean> {
    if (!this.pendingApproval || !this.pendingApprovalRequest || !this.rpcSocket) {
      return false;
    }

    const request = this.pendingApprovalRequest;
    await this.respondToApprovalRequest(request, action);
    this.pendingApprovalRequest = null;
    this.pendingApproval = null;
    this.state.pendingApproval = null;
    this.setStatus("busy");
    return true;
  }

  override async dispose(): Promise<void> {
    this.resetCurrentTurnState({ preserveThread: false });
    this.detachLocalInputForwarding();
    await this.disconnectRpcClient();
    await super.dispose();
    await this.stopAppServer();
  }

  protected override handleData(rawText: string): void {
    this.renderLocalOutput(rawText);

    const text = normalizeOutput(rawText);
    if (!text) {
      return;
    }

    this.state.lastOutputAt = nowIso();
    const approval = detectCliApproval(text);

    if (this.hasAcceptedInput) {
      return;
    }

    if (approval) {
      this.startupBlocker = approval.commandPreview;
      if (this.state.status !== "awaiting_approval") {
        this.setStatus("awaiting_approval", "Codex is waiting for local terminal input.");
      }
      return;
    }

    if (this.startupBlocker) {
      this.startupBlocker = null;
      if (this.state.status === "awaiting_approval") {
        this.setStatus("idle", "codex adapter is ready.");
      }
    }
  }

  protected override handleExit(exitCode: number | undefined): void {
    this.resetCurrentTurnState({ preserveThread: false });
    this.detachLocalInputForwarding();
    void this.disconnectRpcClient();
    void this.stopAppServer();
    super.handleExit(exitCode);
  }

  private async startAppServer(): Promise<void> {
    if (this.appServer) {
      return;
    }

    const port = await reserveLocalPort();
    const env = this.buildEnv();
    const spawnTarget = resolveSpawnTarget(this.options.command, "codex");
    const child = spawnChild(
      spawnTarget.file,
      [
        ...spawnTarget.args,
        "app-server",
        "--listen",
        `ws://${CODEX_APP_SERVER_HOST}:${port}`,
        "--session-source",
        CODEX_APP_SERVER_SESSION_SOURCE,
      ],
      {
        cwd: this.options.cwd,
        env,
        stdio: "pipe",
        windowsHide: true,
      },
    );

    this.appServer = child;
    this.appServerPort = port;
    this.appServerShuttingDown = false;
    this.appServerLog = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.appServerLog = appendBoundedLog(this.appServerLog, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      this.appServerLog = appendBoundedLog(this.appServerLog, chunk);
    });
    child.on("exit", (code, signal) => {
      const expectedShutdown = this.appServerShuttingDown;
      this.appServer = null;
      this.appServerPort = null;
      this.appServerShuttingDown = false;

      if (expectedShutdown) {
        return;
      }

      const exitLabel =
        signal ? `signal ${signal}` : `code ${typeof code === "number" ? code : "unknown"}`;
      const details = this.describeAppServerLog();
      this.emit({
        type: "fatal_error",
        message: `codex app-server exited unexpectedly with ${exitLabel}.${details}`,
        timestamp: nowIso(),
      });

      if (this.pty) {
        this.shuttingDown = true;
        try {
          this.pty.kill();
        } catch {
          // Best effort cleanup after app-server failure.
        }
      }
    });

    try {
      await waitForTcpPort(
        CODEX_APP_SERVER_HOST,
        port,
        CODEX_APP_SERVER_READY_TIMEOUT_MS,
      );
    } catch (err) {
      await this.stopAppServer();
      const details = this.describeAppServerLog();
      throw new Error(`Failed to start Codex app-server: ${String(err)}${details}`);
    }
  }

  private async connectRpcClient(): Promise<void> {
    if (this.rpcSocket) {
      return;
    }
    if (!this.appServerPort) {
      throw new Error("Codex app-server is not ready.");
    }
    if (typeof WebSocket !== "function") {
      throw new Error("Global WebSocket is unavailable in this runtime.");
    }

    const url = `ws://${CODEX_APP_SERVER_HOST}:${this.appServerPort}`;
    const deadline = Date.now() + CODEX_APP_SERVER_READY_TIMEOUT_MS;
    let lastError = "Timed out before the websocket became ready.";

    while (Date.now() < deadline) {
      try {
        const socket = await this.openRpcSocket(url, deadline - Date.now());
        this.attachRpcSocket(socket);
        await this.initializeRpcClient();
        return;
      } catch (err) {
        lastError = describeUnknownError(err);
        await this.disconnectRpcClient();
        await delay(CODEX_RPC_CONNECT_RETRY_MS);
      }
    }

    throw new Error(`Failed to connect to Codex app-server websocket: ${lastError}`);
  }

  private async openRpcSocket(url: string, timeoutMs: number): Promise<WebSocket> {
    return await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(url);
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          socket.close();
        } catch {
          // Best effort cleanup after timeout.
        }
        reject(new Error(`Timed out opening Codex websocket ${url}.`));
      }, Math.max(500, timeoutMs));

      const cleanup = () => {
        clearTimeout(timer);
      };

      socket.addEventListener(
        "open",
        () => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          resolve(socket);
        },
        { once: true },
      );

      socket.addEventListener(
        "error",
        () => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          reject(new Error(`Failed to open Codex websocket ${url}.`));
        },
        { once: true },
      );
    });
  }

  private attachRpcSocket(socket: WebSocket): void {
    this.rpcSocket = socket;
    this.rpcShuttingDown = false;

    socket.addEventListener("message", (event) => {
      this.handleRpcMessageData(event.data);
    });
    socket.addEventListener("close", () => {
      this.handleRpcSocketClosed();
    });
  }

  private async disconnectRpcClient(): Promise<void> {
    const socket = this.rpcSocket;
    this.rpcSocket = null;
    this.rpcShuttingDown = true;
    this.rejectPendingRpcRequests("Codex websocket connection closed.");

    if (!socket) {
      this.rpcShuttingDown = false;
      return;
    }

    await new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }

      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };

      socket.addEventListener("close", () => finish(), { once: true });
      const timer = setTimeout(() => finish(), 1_000);
      timer.unref?.();

      try {
        socket.close();
      } catch {
        finish();
      }
    });

    this.rpcShuttingDown = false;
  }

  private handleRpcSocketClosed(): void {
    const expectedShutdown = this.rpcShuttingDown || this.shuttingDown;
    this.rpcSocket = null;
    this.rejectPendingRpcRequests("Codex websocket connection closed.");
    this.rpcShuttingDown = false;

    if (expectedShutdown) {
      return;
    }

    const details = this.describeAppServerLog();
    this.emit({
      type: "fatal_error",
      message: `codex app-server websocket closed unexpectedly.${details}`,
      timestamp: nowIso(),
    });

    if (this.pty) {
      this.shuttingDown = true;
      try {
        this.pty.kill();
      } catch {
        // Best effort cleanup after websocket failure.
      }
    }
  }

  private rejectPendingRpcRequests(message: string): void {
    for (const pending of this.pendingRpcRequests.values()) {
      pending.reject(new Error(message));
    }
    this.pendingRpcRequests.clear();
  }

  private async initializeRpcClient(): Promise<void> {
    await this.sendRpcRequest("initialize", {
      clientInfo: {
        name: "wechat-bridge",
        title: "WeChat Bridge",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
  }

  private async ensureThreadStarted(): Promise<string> {
    if (this.currentThreadId) {
      return this.currentThreadId;
    }

    const response = await this.sendRpcRequest("thread/start", {
      cwd: this.options.cwd,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      serviceName: "wechat-bridge",
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });

    const threadId = this.extractThreadIdFromResponse(response);
    if (!threadId) {
      throw new Error("Codex did not return a thread id for the bridge session.");
    }

    this.currentThreadId = threadId;
    return threadId;
  }

  private extractThreadIdFromResponse(response: unknown): string | null {
    if (!isRecord(response) || !isRecord(response.thread)) {
      return null;
    }
    return typeof response.thread.id === "string" ? response.thread.id : null;
  }

  private extractTurnIdFromResponse(response: unknown): string | null {
    if (!isRecord(response) || !isRecord(response.turn)) {
      return null;
    }
    return typeof response.turn.id === "string" ? response.turn.id : null;
  }

  private bindCurrentTurn(turnId: string): void {
    this.pendingTurnStart = false;
    this.currentTurnId = turnId;

    const queuedNotifications = this.queuedTurnNotifications;
    this.queuedTurnNotifications = [];
    for (const notification of queuedNotifications) {
      const notificationTurnId = getNotificationTurnId(notification.params);
      if (notificationTurnId === turnId) {
        this.handleTurnScopedNotification(notification.method, notification.params);
      }
    }

    const queuedRequests = this.queuedTurnServerRequests;
    this.queuedTurnServerRequests = [];
    for (const request of queuedRequests) {
      const requestTurnId = getNotificationTurnId(request.params);
      if (requestTurnId === turnId) {
        this.handleTurnScopedServerRequest(request.requestId, request.method, request.params);
      }
    }
  }

  private async requestActiveTurnInterrupt(): Promise<void> {
    if (!this.currentThreadId || !this.currentTurnId) {
      return;
    }

    await this.sendRpcRequest("turn/interrupt", {
      threadId: this.currentThreadId,
      turnId: this.currentTurnId,
    });
  }

  private armInterruptFallback(): void {
    this.clearInterruptTimer();
    this.interruptTimer = setTimeout(() => {
      this.interruptTimer = null;
      if (this.state.status !== "busy" && this.state.status !== "awaiting_approval") {
        return;
      }

      this.resetCurrentTurnState({ preserveThread: true });
      this.setStatus("idle", "Codex task interrupted.");
      this.emit({
        type: "task_complete",
        summary: "Interrupted",
        timestamp: nowIso(),
      });
    }, INTERRUPT_SETTLE_DELAY_MS);
  }

  private clearInterruptTimer(): void {
    if (!this.interruptTimer) {
      return;
    }
    clearTimeout(this.interruptTimer);
    this.interruptTimer = null;
  }

  private resetCurrentTurnState(options: { preserveThread: boolean }): void {
    this.clearInterruptTimer();
    this.currentTurnId = null;
    this.pendingTurnStart = false;
    this.interruptPendingTurnStart = false;
    this.pendingApprovalRequest = null;
    this.pendingApproval = null;
    this.state.pendingApproval = null;
    this.queuedTurnNotifications = [];
    this.queuedTurnServerRequests = [];
    this.currentTurnFinalMessages.clear();
    this.currentTurnDeltaByItem.clear();
    this.currentTurnError = null;
    if (!options.preserveThread) {
      this.currentThreadId = null;
    }
  }

  private currentTurnStateMatches(params: unknown): boolean {
    const threadId = getNotificationThreadId(params);
    const turnId = getNotificationTurnId(params);
    return (
      Boolean(threadId) &&
      threadId === this.currentThreadId &&
      Boolean(turnId) &&
      turnId === this.currentTurnId
    );
  }

  private rpcRequestKey(requestId: CodexRpcRequestId): string {
    return `${typeof requestId}:${String(requestId)}`;
  }

  private async sendRpcRequest(method: string, params: unknown): Promise<unknown> {
    const socket = this.rpcSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex websocket is not connected.");
    }

    const requestId = ++this.rpcRequestCounter;
    const requestKey = this.rpcRequestKey(requestId);
    const responsePromise = new Promise<unknown>((resolve, reject) => {
      this.pendingRpcRequests.set(requestKey, {
        method,
        resolve,
        reject,
      });
    });

    try {
      this.sendRpcMessage({
        id: requestId,
        method,
        params,
      });
    } catch (err) {
      this.pendingRpcRequests.delete(requestKey);
      throw err;
    }

    return await responsePromise;
  }

  private sendRpcMessage(payload: Record<string, unknown>): void {
    const socket = this.rpcSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex websocket is not connected.");
    }

    socket.send(JSON.stringify(payload));
  }

  private async respondToApprovalRequest(
    request: CodexPendingApprovalRequest,
    action: "confirm" | "deny",
  ): Promise<void> {
    const decision = action === "confirm" ? "accept" : "decline";
    this.sendRpcMessage({
      id: request.requestId,
      result: { decision },
    });
  }

  private handleRpcMessageData(data: unknown): void {
    const text = coerceWebSocketMessageData(data);
    if (!text) {
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return;
    }

    if (!isRecord(payload)) {
      return;
    }

    const requestId = getCodexRpcRequestId(payload.id);
    const method = typeof payload.method === "string" ? payload.method : null;

    if (requestId !== null && method) {
      this.handleRpcServerRequest(requestId, method, payload.params);
      return;
    }

    if (requestId !== null) {
      this.handleRpcResponse(requestId, payload);
      return;
    }

    if (method) {
      this.handleRpcNotification(method, payload.params);
    }
  }

  private handleRpcResponse(requestId: CodexRpcRequestId, payload: Record<string, unknown>): void {
    const requestKey = this.rpcRequestKey(requestId);
    const pending = this.pendingRpcRequests.get(requestKey);
    if (!pending) {
      return;
    }

    this.pendingRpcRequests.delete(requestKey);
    if (payload.error !== undefined && payload.error !== null) {
      pending.reject(new Error(normalizeCodexRpcError(payload.error)));
      return;
    }

    pending.resolve(payload.result);
  }

  private handleRpcNotification(method: string, params: unknown): void {
    if (!isRecord(params)) {
      return;
    }

    if (
      method === "item/agentMessage/delta" ||
      method === "item/completed" ||
      method === "turn/completed" ||
      method === "turn/started" ||
      method === "error" ||
      method === "serverRequest/resolved"
    ) {
      if (this.pendingTurnStart && !this.currentTurnId) {
        this.queuedTurnNotifications.push({ method, params });
        return;
      }

      if (!this.currentTurnStateMatches(params)) {
        if (
          method === "serverRequest/resolved" &&
          this.pendingApprovalRequest &&
          getNotificationThreadId(params) === this.currentThreadId
        ) {
          const requestId = getCodexRpcRequestId(params.requestId);
          if (requestId !== null && requestId === this.pendingApprovalRequest.requestId) {
            this.pendingApprovalRequest = null;
            this.pendingApproval = null;
            this.state.pendingApproval = null;
            if (this.state.status === "awaiting_approval") {
              this.setStatus("busy", "Codex approval resolved.");
            }
          }
        }
        return;
      }

      this.handleTurnScopedNotification(method, params);
      return;
    }

    if (this.currentTurnStateMatches(params)) {
      this.state.lastOutputAt = nowIso();
    }
  }

  private handleTurnScopedNotification(
    method: string,
    params: Record<string, unknown>,
  ): void {
    this.state.lastOutputAt = nowIso();

    switch (method) {
      case "item/agentMessage/delta": {
        const itemId = typeof params.itemId === "string" ? params.itemId : null;
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (!itemId || !delta) {
          return;
        }

        const previous = this.currentTurnDeltaByItem.get(itemId) ?? "";
        this.currentTurnDeltaByItem.set(itemId, `${previous}${delta}`);
        return;
      }

      case "item/completed": {
        const itemId =
          isRecord(params.item) && typeof params.item.id === "string"
            ? params.item.id
            : null;
        const finalText = extractCodexFinalTextFromItem(params.item);
        if (itemId && finalText) {
          this.currentTurnFinalMessages.set(itemId, finalText);
        }
        return;
      }

      case "error": {
        if (isRecord(params.error) && typeof params.error.message === "string") {
          this.currentTurnError = params.error.message;
        }
        return;
      }

      case "serverRequest/resolved": {
        const requestId = getCodexRpcRequestId(params.requestId);
        if (
          requestId !== null &&
          this.pendingApprovalRequest &&
          requestId === this.pendingApprovalRequest.requestId
        ) {
          this.pendingApprovalRequest = null;
          this.pendingApproval = null;
          this.state.pendingApproval = null;
          if (this.state.status === "awaiting_approval") {
            this.setStatus("busy", "Codex approval resolved.");
          }
        }
        return;
      }

      case "turn/completed": {
        this.handleTurnCompleted(params);
        return;
      }
    }
  }

  private handleRpcServerRequest(
    requestId: CodexRpcRequestId,
    method: string,
    params: unknown,
  ): void {
    if (
      method !== "item/commandExecution/requestApproval" &&
      method !== "item/fileChange/requestApproval"
    ) {
      this.sendRpcMessage({
        id: requestId,
        error: {
          code: -32601,
          message: `Unsupported server request: ${method}`,
        },
      });
      return;
    }

    if (!isRecord(params)) {
      this.sendRpcMessage({
        id: requestId,
        error: {
          code: -32602,
          message: "Invalid Codex approval request payload.",
        },
      });
      return;
    }

    if (this.pendingTurnStart && !this.currentTurnId) {
      this.queuedTurnServerRequests.push({
        requestId,
        method,
        params,
      });
      return;
    }

    if (!this.currentTurnStateMatches(params)) {
      return;
    }

    this.handleTurnScopedServerRequest(requestId, method, params);
  }

  private handleTurnScopedServerRequest(
    requestId: CodexRpcRequestId,
    method: CodexPendingApprovalRequest["method"],
    params: Record<string, unknown>,
  ): void {
    const request = buildCodexApprovalRequest(method, params);
    if (!request) {
      return;
    }

    this.pendingApprovalRequest = {
      requestId,
      method,
    };
    this.pendingApproval = request;
    this.state.pendingApproval = request;
    this.state.lastOutputAt = nowIso();
    this.setStatus("awaiting_approval", "Codex approval is required.");
    this.emit({
      type: "approval_required",
      request,
      timestamp: nowIso(),
    });
  }

  private handleTurnCompleted(params: Record<string, unknown>): void {
    const turn = isRecord(params.turn) ? params.turn : null;
    const status = turn && typeof turn.status === "string" ? turn.status : "completed";
    const completedError =
      turn && isRecord(turn.error) && typeof turn.error.message === "string"
        ? turn.error.message
        : this.currentTurnError;
    const finalText = this.collectCurrentTurnOutput();

    this.resetCurrentTurnState({ preserveThread: true });

    if (finalText) {
      this.emit({
        type: "stdout",
        text: finalText,
        timestamp: nowIso(),
      });
    } else if (status === "failed") {
      const failureText = completedError
        ? `Codex could not complete the request: ${completedError}`
        : "Codex could not complete the request.";
      this.emit({
        type: "stdout",
        text: failureText,
        timestamp: nowIso(),
      });
    }

    if (this.state.status !== "stopped") {
      const statusMessage =
        status === "interrupted" ? "Codex task interrupted." : undefined;
      this.setStatus("idle", statusMessage);
    }
    this.emit({
      type: "task_complete",
      summary: status === "interrupted" ? "Interrupted" : this.currentPreview,
      timestamp: nowIso(),
    });
  }

  private collectCurrentTurnOutput(): string | null {
    const finalMessages = Array.from(this.currentTurnFinalMessages.values())
      .map((text) => normalizeOutput(text).trim())
      .filter(Boolean);
    if (finalMessages.length > 0) {
      return finalMessages.join("\n\n");
    }

    const deltaFallback = Array.from(this.currentTurnDeltaByItem.values())
      .map((text) => normalizeOutput(text).trim())
      .filter(Boolean);
    if (deltaFallback.length === 0) {
      return null;
    }

    return deltaFallback[deltaFallback.length - 1];
  }

  private async stopAppServer(): Promise<void> {
    if (!this.appServer) {
      this.appServerPort = null;
      this.appServerShuttingDown = false;
      return;
    }

    const child = this.appServer;
    this.appServerShuttingDown = true;
    this.appServer = null;
    this.appServerPort = null;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };
      child.once("exit", () => finish());
      try {
        child.kill();
      } catch {
        finish();
      }
      const timer = setTimeout(() => finish(), 1_000);
      timer.unref?.();
    });
  }

  private describeAppServerLog(): string {
    const summary = normalizeOutput(this.appServerLog).trim();
    if (!summary) {
      return "";
    }
    return ` Recent app-server log: ${truncatePreview(summary, 220)}`;
  }

  private attachLocalInputForwarding(): void {
    if (this.localInputListener || !process.stdin.readable) {
      return;
    }

    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    this.localInputListener = (chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (!text) {
        return;
      }
      this.writeToPty(text);
    };
    process.stdin.on("data", this.localInputListener);
  }

  private detachLocalInputForwarding(): void {
    if (!this.localInputListener) {
      return;
    }

    process.stdin.off("data", this.localInputListener);
    this.localInputListener = null;
    if (process.stdin.isTTY) {
      process.stdin.pause();
    }
  }

  private renderLocalOutput(rawText: string): void {
    try {
      process.stdout.write(rawText);
    } catch {
      // Best effort local mirroring for the visible Codex panel.
    }
  }
}

class CliPtyAdapter extends AbstractPtyAdapter {
  protected buildSpawnArgs(): string[] {
    const args: string[] = [];
    if (this.options.kind === "claude") {
      args.push("--no-alt-screen");
    }
    if (this.options.profile) {
      args.push("--profile", this.options.profile);
    }
    return args;
  }
}

class ShellAdapter extends AbstractPtyAdapter {
  private pendingShellCommand: string | null = null;
  private interruptTimer: ReturnType<typeof setTimeout> | null = null;

  protected buildSpawnArgs(): string[] {
    return ["-NoLogo", "-ExecutionPolicy", "Bypass", "-Command", "-"];
  }

  protected afterStart(): void {
    if (this.options.profile) {
      const profilePath = this.escapePowerShellString(
        path.resolve(this.options.profile),
      );
      this.writeToPty(`. "${profilePath}"\r`);
    }
  }

  override async sendInput(text: string): Promise<void> {
    if (isHighRiskShellCommand(text)) {
      this.pendingShellCommand = text;
      const request: ApprovalRequest = {
        source: "shell",
        summary: "High-risk shell command detected. Confirmation is required.",
        commandPreview: truncatePreview(text, 180),
      };
      this.pendingApproval = request;
      this.state.pendingApproval = request;
      this.setStatus("awaiting_approval", "Waiting for shell command approval.");
      this.emit({
        type: "approval_required",
        request,
        timestamp: nowIso(),
      });
      return;
    }

    await super.sendInput(text);
  }

  override async interrupt(): Promise<boolean> {
    if (!this.pty) {
      return false;
    }

    this.writeToPty("\u0003");
    if (this.interruptTimer) {
      clearTimeout(this.interruptTimer);
    }
    this.interruptTimer = setTimeout(() => {
      this.interruptTimer = null;
      if (this.state.status === "busy") {
        this.setStatus("idle", "Shell command interrupted.");
        this.emit({
          type: "task_complete",
          summary: "Interrupted",
          timestamp: nowIso(),
        });
      }
    }, 1_500);
    return true;
  }

  protected override prepareInput(text: string): string {
    const script = [
      "$__wechatBridgePreviousErrorActionPreference = $ErrorActionPreference",
      "$ErrorActionPreference = 'Continue'",
      "$global:LASTEXITCODE = 0",
      "try {",
      text,
      "} catch {",
      "  Write-Error $_",
      "  $global:LASTEXITCODE = 1",
      "} finally {",
      "  if (-not ($global:LASTEXITCODE -is [int])) { $global:LASTEXITCODE = 0 }",
      '  Write-Output "__WECHAT_BRIDGE_DONE__:$global:LASTEXITCODE"',
      "  $ErrorActionPreference = $__wechatBridgePreviousErrorActionPreference",
      "}",
      "",
    ];
    return `${script.join("\r")}\r`;
  }

  protected override defaultCompletionDelayMs(): number {
    return 15_000;
  }

  protected override async applyApproval(
    action: "confirm" | "deny",
    _pendingApproval: ApprovalRequest,
  ): Promise<boolean> {
    if (!this.pendingApproval) {
      return false;
    }

    if (action === "deny") {
      this.pendingShellCommand = null;
      this.pendingApproval = null;
      this.state.pendingApproval = null;
      this.setStatus("idle", "Shell command denied.");
      this.emit({
        type: "task_complete",
        summary: "Denied",
        timestamp: nowIso(),
      });
      return true;
    }

    const command = this.pendingShellCommand;
    if (!command) {
      return false;
    }

    this.pendingShellCommand = null;
    this.pendingApproval = null;
    this.state.pendingApproval = null;
    await super.sendInput(command);
    return true;
  }

  protected override handleData(rawText: string): void {
    const text = normalizeOutput(rawText);
    if (!text) {
      return;
    }

    this.state.lastOutputAt = nowIso();
    if (!this.hasAcceptedInput) {
      return;
    }

    const match = text.match(/__WECHAT_BRIDGE_DONE__:(-?\d+)/);
    const visibleText = this.filterShellOutput(
      text.replace(/__WECHAT_BRIDGE_DONE__:-?\d+/g, ""),
    );

    if (visibleText.trim()) {
      this.emit({
        type: "stdout",
        text: visibleText,
        timestamp: nowIso(),
      });
    }

    if (match) {
      this.clearCompletionTimer();
      this.setStatus("idle");
      this.emit({
        type: "task_complete",
        exitCode: Number(match[1]),
        summary: this.currentPreview,
        timestamp: nowIso(),
      });
    }
  }

  private filterShellOutput(text: string): string {
    return text
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return false;
        }
        if (trimmed.startsWith("$__wechatBridge")) {
          return false;
        }
        if (trimmed.startsWith("$ErrorActionPreference")) {
          return false;
        }
        if (trimmed === "try {" || trimmed === "} catch {" || trimmed === "}") {
          return false;
        }
        return true;
      })
      .join("\n");
  }

  private escapePowerShellString(text: string): string {
    return text.replace(/`/g, "``").replace(/"/g, '`"');
  }
}

export function createBridgeAdapter(options: AdapterOptions): BridgeAdapter {
  switch (options.kind) {
    case "codex":
      return new CodexPtyAdapter(options);
    case "claude":
      return new CliPtyAdapter(options);
    case "shell":
      return new ShellAdapter(options);
    default:
      throw new Error(`Unsupported adapter: ${options.kind}`);
  }
}
