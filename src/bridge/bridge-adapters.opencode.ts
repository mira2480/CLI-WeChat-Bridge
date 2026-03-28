import { spawn as spawnChildProcess, type ChildProcess } from "node:child_process";

import {
  type AdapterOptions,
  type EventSink,
  OPENCODE_SERVER_HOST,
  OPENCODE_SERVER_READY_TIMEOUT_MS,
  OPENCODE_SSE_RECONNECT_DELAY_MS,
  OPENCODE_SESSION_IDLE_SETTLE_MS,
  OPENCODE_WECHAT_WORKING_NOTICE_DELAY_MS,
  buildCliEnvironment,
  isRecord,
  describeUnknownError,
  resolveSpawnTarget,
  reserveLocalPort,
  waitForTcpPort,
  delay,
} from "./bridge-adapters.shared.ts";
import type {
  ApprovalRequest,
  BridgeAdapter,
  BridgeAdapterState,
  BridgeResumeSessionCandidate,
  BridgeEvent,
} from "./bridge-types.ts";
import {
  normalizeOutput,
  nowIso,
  truncatePreview,
  buildOneTimeCode,
  OutputBatcher,
} from "./bridge-utils.ts";
import {
  buildLocalCompanionToken,
  clearLocalCompanionEndpoint,
  writeLocalCompanionEndpoint,
  type LocalCompanionEndpoint,
} from "../companion/local-companion-link.ts";

/* ------------------------------------------------------------------ */
/*  Types for @opencode-ai/sdk (loose to avoid hard import-time deps) */
/* ------------------------------------------------------------------ */

/**
 * The real @opencode-ai/sdk OpencodeClient uses hey-api generated methods
 * that return { data, error, request, response }.  We define a minimal
 * interface so the adapter can call methods without importing the SDK at
 * compile-time (the SDK is loaded dynamically via createSdkClient).
 */
type SdkResult<T> =
  | { data: T; error: undefined; request: unknown; response: unknown }
  | { data: undefined; error: unknown; request: unknown; response: unknown };

type SdkSession = {
  id: string;
  projectID: string;
  directory: string;
  parentID?: string;
  title: string;
  version: string;
  time: { created: number; updated: number; compacting?: number };
  share?: { url: string };
};

type SdkSessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt: number; message: string; next: number };

type SdkPermission = {
  id: string;
  type: string;
  pattern?: string | Array<string>;
  sessionID: string;
  messageID: string;
  callID?: string;
  title: string;
  metadata: Record<string, unknown>;
  time: { created: number };
};

type SdkPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  text?: string;
} & Record<string, unknown>;

type OpenCodeSdkClient = {
  session: {
    list(options?: Record<string, unknown>): Promise<SdkResult<SdkSession[]>>;
    create(options: { body?: Record<string, unknown>; query?: Record<string, unknown> }): Promise<SdkResult<SdkSession>>;
    get(options: { path: { id: string }; query?: Record<string, unknown> }): Promise<SdkResult<SdkSession>>;
    abort(options: { path: { id: string } }): Promise<SdkResult<unknown>>;
    promptAsync(options: {
      path: { id: string };
      body: { parts: Array<{ type: string; text: string }> };
      query?: Record<string, unknown>;
    }): Promise<SdkResult<void>>;
  };
  postSessionIdPermissionsPermissionId(options: {
    path: { id: string; permissionID: string };
    body: { response: string };
    query?: Record<string, unknown>;
  }): Promise<SdkResult<boolean>>;
  event: {
    subscribe(options?: Record<string, unknown>): Promise<{
      stream: AsyncIterable<SdkEvent>;
    }>;
  };
};

type SdkEvent = {
  type: string;
  properties?: unknown;
};

const OPENCODE_DEBUG_ENABLED = /^(1|true|yes|on)$/i.test(
  process.env.WECHAT_OPENCODE_DEBUG ?? "",
);

/* ------------------------------------------------------------------ */
/*  Adapter                                                            */
/* ------------------------------------------------------------------ */

export class OpenCodeServerAdapter implements BridgeAdapter {
  private readonly options: AdapterOptions;
  private readonly state: BridgeAdapterState;
  private eventSink: EventSink = () => undefined;

  private serverProcess: ChildProcess | null = null;
  private serverPort = 0;
  private client: OpenCodeSdkClient | null = null;
  private sseAbortController: AbortController | null = null;
  private sseLoopPromise: Promise<void> | null = null;
  private attachProcess: ChildProcess | null = null;
  private activeSessionId: string | null = null;
  private outputBatcher: OutputBatcher;
  private shuttingDown = false;
  private hasAcceptedInput = false;
  private currentPreview = "(idle)";
  private workingNoticeDelayMs: number;
  private workingNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  private workingNoticeSent = false;
  private lastBusyAtMs = 0;
  private readonly loggedUnknownEventTypes = new Set<string>();
  private readonly emittedTextByPartId = new Map<string, string>();
  private readonly endpointToken = buildLocalCompanionToken();
  private endpoint: LocalCompanionEndpoint | null = null;

  private pendingPermission: {
    sessionId: string;
    permissionId: string;
    code: string;
    createdAt: string;
    request: ApprovalRequest;
  } | null = null;

  constructor(options: AdapterOptions) {
    this.options = options;
    this.state = {
      kind: options.kind,
      status: "stopped",
      cwd: options.cwd,
      command: options.command,
      profile: options.profile,
    };
    this.outputBatcher = new OutputBatcher((text) =>
      this.flushOutputBatch(text),
    );
    this.workingNoticeDelayMs = OPENCODE_WECHAT_WORKING_NOTICE_DELAY_MS;
  }

  /* ---- BridgeAdapter interface ---- */

  setEventSink(sink: EventSink): void {
    this.eventSink = sink;
  }

  getState(): BridgeAdapterState {
    return JSON.parse(JSON.stringify(this.state)) as BridgeAdapterState;
  }

  async start(): Promise<void> {
    if (this.serverProcess) {
      return;
    }

    this.shuttingDown = false;
    this.setStatus("starting", "Starting OpenCode server...");

    try {
      this.serverPort = await reserveLocalPort();
      await this.startServerProcess();

      await waitForTcpPort(
        OPENCODE_SERVER_HOST,
        this.serverPort,
        OPENCODE_SERVER_READY_TIMEOUT_MS,
      );

      await this.createSdkClient();
      await this.checkHealth();
      await this.initializeSessions();
      this.startSseListener();

      this.state.pid = this.serverProcess!.pid;
      this.state.startedAt = nowIso();
      this.publishLocalEndpoint();
      if (this.shouldSpawnAttachProcess()) {
        this.spawnAttachProcess();
      }
      this.setStatus("idle", "OpenCode adapter is ready.");
    } catch (err) {
      this.state.status = "error";
      this.emit({
        type: "fatal_error",
        message: `Failed to start OpenCode: ${describeUnknownError(err)}`,
        timestamp: nowIso(),
      });
      await this.dispose();
      throw err;
    }
  }

  async sendInput(text: string): Promise<void> {
    if (!this.client) {
      throw new Error("OpenCode adapter is not running.");
    }
    if (this.state.status === "busy") {
      throw new Error("OpenCode is still working. Wait for the current reply or use /stop.");
    }
    if (this.pendingPermission) {
      throw new Error("An OpenCode approval request is pending. Reply with /confirm <code> or /deny.");
    }

    const normalized = normalizeOutput(text).trim();
    if (!normalized) {
      return;
    }

    this.outputBatcher.clear();
    this.clearStreamedPartState();

    const sessionId = await this.ensureSession();
    this.assignActiveSession(sessionId);

    try {
      const result = await this.client.session.promptAsync({
        path: { id: sessionId },
        body: { parts: [{ type: "text", text: normalized }] },
      });
      if (result.error !== undefined) {
        throw new Error(`SDK error: ${describeUnknownError(result.error)}`);
      }
    } catch (err) {
      throw new Error(`Failed to send prompt: ${describeUnknownError(err)}`);
    }

    this.hasAcceptedInput = true;
    this.currentPreview = truncatePreview(normalized);
    this.state.lastInputAt = nowIso();
    this.state.activeTurnOrigin = "wechat";
    this.lastBusyAtMs = Date.now();
    this.clearWechatWorkingNotice(true);
    this.setStatus("busy");
    this.armWechatWorkingNotice();
  }

  async listResumeSessions(limit = 10): Promise<BridgeResumeSessionCandidate[]> {
    if (!this.client) {
      return [];
    }

    try {
      const result = await this.client.session.list();
      if (result.error !== undefined) {
        return [];
      }
      const sessions = result.data ?? [];
      return sessions.slice(0, limit).map((s) => ({
        sessionId: s.id,
        title: truncatePreview(s.title || s.id, 120),
        lastUpdatedAt: new Date(s.time.updated).toISOString(),
      }));
    } catch {
      return [];
    }
  }

  async resumeSession(sessionId: string): Promise<void> {
    if (!this.client) {
      throw new Error("OpenCode adapter is not running.");
    }

    try {
      const session = this.unwrapOrThrow(
        await this.client.session.get({ path: { id: sessionId } }),
      );
      this.assignActiveSession(session.id);

      const timestamp = nowIso();
      this.state.lastSessionSwitchAt = timestamp;
      this.state.lastSessionSwitchSource = "wechat";
      this.state.lastSessionSwitchReason = "wechat_resume";

      this.emit({
        type: "session_switched",
        sessionId: session.id,
        source: "wechat",
        reason: "wechat_resume",
        timestamp,
      });
    } catch (err) {
      throw new Error(`Failed to resume session ${sessionId}: ${describeUnknownError(err)}`);
    }
  }

  async interrupt(): Promise<boolean> {
    if (!this.client || !this.activeSessionId) {
      return false;
    }
    if (this.state.status !== "busy" && this.state.status !== "awaiting_approval") {
      return false;
    }

    this.clearWechatWorkingNotice(true);

    try {
      await this.client.session.abort({ path: { id: this.activeSessionId } });
    } catch {
      // Best effort abort.
    }

    return true;
  }

  async reset(): Promise<void> {
    this.clearWechatWorkingNotice(true);
    this.pendingPermission = null;
    this.state.pendingApproval = null;
    this.state.pendingApprovalOrigin = undefined;
    this.activeSessionId = null;
    this.state.sharedSessionId = undefined;
    this.state.activeRuntimeSessionId = undefined;
    this.hasAcceptedInput = false;
    this.currentPreview = "(idle)";
    this.outputBatcher.clear();
    this.clearStreamedPartState();
    await this.dispose();
    await this.start();
  }

  async resolveApproval(action: "confirm" | "deny"): Promise<boolean> {
    if (!this.pendingPermission || !this.client) {
      return false;
    }

    const { sessionId, permissionId } = this.pendingPermission;
    const response = action === "confirm" ? "once" : "reject";

    try {
      const result = await this.client.postSessionIdPermissionsPermissionId({
        path: { id: sessionId, permissionID: permissionId },
        body: { response },
      });
      if (result.error !== undefined) {
        throw new Error(`SDK error: ${describeUnknownError(result.error)}`);
      }
    } catch (err) {
      this.emit({
        type: "stderr",
        text: `Failed to resolve permission: ${describeUnknownError(err)}`,
        timestamp: nowIso(),
      });
      return false;
    }

    this.clearWechatWorkingNotice();
    this.pendingPermission = null;
    this.state.pendingApproval = null;
    this.state.pendingApprovalOrigin = undefined;
    this.setStatus("busy");
    return true;
  }

  async dispose(): Promise<void> {
    this.shuttingDown = true;
    this.clearWechatWorkingNotice(true);
    this.detachLocalTerminal();
    this.clearLocalEndpoint();
    this.outputBatcher.clear();
    this.clearStreamedPartState();

    this.pendingPermission = null;
    this.state.pendingApproval = null;
    this.state.pendingApprovalOrigin = undefined;

    // Stop SSE listener
    if (this.sseAbortController) {
      this.sseAbortController.abort();
      this.sseAbortController = null;
    }
    if (this.sseLoopPromise) {
      try {
        await Promise.race([this.sseLoopPromise, delay(3_000)]);
      } catch {
        // Ignore SSE loop errors during shutdown.
      }
      this.sseLoopPromise = null;
    }

    // Stop attach process
    if (this.attachProcess) {
      try {
        this.attachProcess.kill();
      } catch {
        // Best effort.
      }
      this.attachProcess = null;
    }

    // Stop server process
    if (this.serverProcess) {
      const proc = this.serverProcess;
      this.serverProcess = null;
      try {
        proc.kill();
      } catch {
        // Best effort.
      }
    }

    this.client = null;
    this.activeSessionId = null;
    this.state.status = "stopped";
    this.state.pid = undefined;
  }

  /* ---- Server management ---- */

  private async startServerProcess(): Promise<void> {
    const env = buildCliEnvironment(this.options.kind);
    const serverArgs = [
      "serve",
      "--port",
      String(this.serverPort),
      "--hostname",
      OPENCODE_SERVER_HOST,
    ];

    const target = resolveSpawnTarget(this.options.command, this.options.kind, { env });
    this.serverProcess = spawnChildProcess(target.file, [...target.args, ...serverArgs], {
      cwd: this.options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const server = this.serverProcess;

    server.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        this.logDebug(`[opencode-serve:out] ${text}`);
      }
    });

    server.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        this.logDebug(`[opencode-serve:err] ${text}`);
      }
    });

    server.once("exit", (code) => {
      if (this.shuttingDown) {
        return;
      }
      this.emit({
        type: "fatal_error",
        message: `OpenCode server exited unexpectedly (code ${code ?? "unknown"}).`,
        timestamp: nowIso(),
      });
      this.setStatus("stopped");
    });

    server.once("error", (err) => {
      if (this.shuttingDown) {
        return;
      }
      this.emit({
        type: "fatal_error",
        message: `OpenCode server error: ${err.message}`,
        timestamp: nowIso(),
      });
    });
  }

  private async createSdkClient(): Promise<void> {
    try {
      const { createOpencodeClient } = await import("@opencode-ai/sdk");
      this.client = createOpencodeClient({
        baseUrl: `http://${OPENCODE_SERVER_HOST}:${this.serverPort}`,
      }) as unknown as OpenCodeSdkClient;
    } catch (err) {
      throw new Error(
        `Failed to load @opencode-ai/sdk. Make sure it is installed: ${describeUnknownError(err)}`,
      );
    }
  }

  private async checkHealth(): Promise<void> {
    const baseUrl = `http://${OPENCODE_SERVER_HOST}:${this.serverPort}`;
    const response = await fetch(`${baseUrl}/session/status`);
    if (!response.ok) {
      throw new Error(`OpenCode health check failed (HTTP ${response.status}).`);
    }
  }

  private async initializeSessions(): Promise<void> {
    if (!this.client) {
      return;
    }

    try {
      const result = await this.client.session.list();
      if (result.data && result.data.length > 0) {
        const latest = result.data[0]!;
        this.assignActiveSession(latest.id);
      }
    } catch {
      // Session listing is optional at startup.
    }

    if (this.options.initialSharedSessionId) {
      this.assignActiveSession(this.options.initialSharedSessionId);
    }
  }

  /* ---- SSE event handling ---- */

  private startSseListener(): void {
    if (!this.client || this.sseLoopPromise) {
      return;
    }

    this.sseAbortController = new AbortController();
    this.sseLoopPromise = this.runSseLoop();
  }

  private async runSseLoop(): Promise<void> {
    while (!this.shuttingDown) {
      try {
        const subscription = await this.client!.event.subscribe();
        const stream = subscription.stream;

        for await (const event of stream) {
          if (this.shuttingDown) {
            break;
          }
          this.handleSseEvent(event);
        }
      } catch (err) {
        if (this.shuttingDown) {
          return;
        }
        this.logDebug(
          `[opencode-adapter:sse] Stream error: ${describeUnknownError(err)}`,
        );
      }

      if (this.shuttingDown) {
        return;
      }

      await delay(OPENCODE_SSE_RECONNECT_DELAY_MS);
    }
  }

  private handleSseEvent(event: SdkEvent): void {
    const { type } = event;

    switch (type) {
      case "server.connected":
      case "server.heartbeat":
        return;

      case "session.idle": {
        this.handleSessionIdle(isRecord(event.properties) ? event.properties : undefined);
        return;
      }

      case "session.status": {
        this.handleSessionStatus(isRecord(event.properties) ? event.properties : undefined);
        return;
      }

      case "permission.updated":
      case "permission.asked": {
        this.handlePermissionRequest(event.properties);
        return;
      }

      case "session.created": {
        this.handleSessionCreated(event.properties);
        return;
      }

      case "session.updated": {
        this.handleSessionUpdated(event.properties);
        return;
      }

      case "message.updated": {
        // Full message update — not used for incremental text extraction.
        // Text output comes from message.part.updated events.
        return;
      }

      case "message.part.updated": {
        this.handleMessagePartUpdated(event.properties);
        return;
      }

      case "message.part.delta": {
        this.handleMessagePartDelta(event.properties);
        return;
      }

      case "message.part.removed": {
        this.handleMessagePartRemoved(event.properties);
        return;
      }

      case "session.diff":
      case "session.diff.delta":
      case "session.deleted":
      case "message.removed":
      case "permission.replied":
        return;

      default:
        this.logUnknownEvent(type);
        return;
    }
  }

  private handleSessionIdle(properties: Record<string, unknown> | undefined): void {
    if (!isRecord(properties)) {
      return;
    }

    const sessionId =
      typeof properties.sessionID === "string"
        ? properties.sessionID
        : this.activeSessionId;

    this.assignActiveSession(sessionId);

    if (this.state.status !== "busy" && this.state.status !== "awaiting_approval") {
      return;
    }

    // Wait a short settle time before emitting task_complete,
    // in case more events follow the idle signal.
    setTimeout(() => {
      if (this.state.status !== "busy" && this.state.status !== "awaiting_approval") {
        return;
      }

      this.clearWechatWorkingNotice(true);
      this.pendingPermission = null;
      this.state.pendingApproval = null;
      this.state.pendingApprovalOrigin = undefined;
      this.state.activeTurnOrigin = undefined;
      this.hasAcceptedInput = false;
      const completedPreview = this.currentPreview;

      void this.outputBatcher.flushNow()
        .catch(() => undefined)
        .then(() => {
          const summary = this.outputBatcher.getRecentSummary(500);
          this.setStatus("idle");
          if (summary && summary !== "(no output)") {
            this.emit({
              type: "final_reply",
              text: summary,
              timestamp: nowIso(),
            });
          }

          this.emit({
            type: "task_complete",
            summary: completedPreview,
            timestamp: nowIso(),
          });
          this.currentPreview = "(idle)";
          this.outputBatcher.clear();
          this.clearStreamedPartState();
        });
    }, OPENCODE_SESSION_IDLE_SETTLE_MS).unref?.();
  }

  private handleSessionStatus(properties: Record<string, unknown> | undefined): void {
    if (!isRecord(properties)) {
      return;
    }

    // properties: { sessionID: string, status: { type: "busy" | "idle" | ... } }
    const status = properties.status;
    if (!isRecord(status)) {
      return;
    }

    const statusType = typeof status.type === "string" ? status.type : undefined;
    if (!statusType) {
      return;
    }

    if (statusType === "busy" || statusType === "running") {
      if (this.state.status === "idle") {
        this.outputBatcher.clear();
        this.clearStreamedPartState();
        this.lastBusyAtMs = Date.now();
        this.setStatus("busy");
      }
    }
  }

  private handlePermissionRequest(properties: unknown): void {
    if (!isRecord(properties) || !this.client) {
      return;
    }

    const sessionId =
      typeof properties.sessionID === "string"
        ? properties.sessionID
        : this.activeSessionId;
    const permissionId =
      typeof properties.id === "string"
        ? properties.id
        : undefined;

    if (!sessionId || !permissionId) {
      return;
    }

    this.clearWechatWorkingNotice();

    const toolName =
      typeof properties.type === "string"
        ? properties.type
        : typeof properties.permission === "string"
          ? properties.permission
        : undefined;
    const title =
      typeof properties.title === "string"
        ? properties.title
        : typeof properties.permission === "string"
          ? `Permission request: ${properties.permission}`
        : undefined;
    const metadata = isRecord(properties.metadata) ? properties.metadata : {};
    const command =
      typeof metadata.command === "string"
        ? metadata.command
        : typeof metadata.detail === "string"
          ? metadata.detail
          : Array.isArray(properties.patterns)
            ? properties.patterns.filter((value): value is string => typeof value === "string").join(", ")
          : undefined;

    const code = buildOneTimeCode();
    const request: ApprovalRequest = {
      source: "cli",
      summary: title ?? `OpenCode needs approval${toolName ? ` for tool: ${toolName}` : ""}.`,
      commandPreview: truncatePreview(command ?? title ?? "Permission request", 180),
      toolName,
      detailPreview: typeof metadata.detail === "string" ? metadata.detail : undefined,
      detailLabel: typeof metadata.label === "string" ? metadata.label : undefined,
      confirmInput: undefined,
      denyInput: undefined,
    };

    this.pendingPermission = {
      sessionId,
      permissionId,
      code,
      createdAt: nowIso(),
      request,
    };
    this.state.pendingApproval = request;
    this.state.pendingApprovalOrigin = this.state.activeTurnOrigin;
    this.setStatus("awaiting_approval", "OpenCode approval is required.");
    this.emit({
      type: "approval_required",
      request,
      timestamp: nowIso(),
    });
  }

  private handleSessionCreated(properties: unknown): void {
    if (!isRecord(properties)) {
      return;
    }

    const sessionId = this.extractSessionId(properties);
    if (!sessionId) {
      return;
    }

    const changed = this.assignActiveSession(sessionId);
    if (!changed) {
      return;
    }

    this.announceLocalSessionSwitch(sessionId);
  }

  private handleSessionUpdated(properties: unknown): void {
    if (!isRecord(properties)) {
      return;
    }

    const sessionId = this.extractSessionId(properties);
    if (!sessionId) {
      return;
    }

    const changed = this.assignActiveSession(sessionId);
    if (!changed) {
      return;
    }

    this.announceLocalSessionSwitch(sessionId);
  }

  private handleMessagePartUpdated(properties: unknown): void {
    if (!isRecord(properties)) {
      return;
    }

    if (this.state.status !== "busy") {
      return;
    }

    const part = isRecord(properties.part) ? properties.part : undefined;
    if (!this.isVisibleTextPart(part)) {
      return;
    }

    const partId = this.extractPartId(properties, part);
    if (!partId) {
      return;
    }

    const partText =
      typeof part.text === "string"
        ? part.text
        : undefined;
    const delta =
      typeof properties.delta === "string"
        ? properties.delta
        : undefined;
    const text = partText
      ? this.consumeVisiblePartSnapshot(partId, partText)
      : delta
        ? this.consumeVisiblePartDelta(partId, delta)
        : "";
    this.pushVisibleOutput(text);
  }

  private handleMessagePartDelta(properties: unknown): void {
    if (!isRecord(properties) || this.state.status !== "busy") {
      return;
    }

    if (properties.field !== "text") {
      return;
    }

    const delta =
      typeof properties.delta === "string"
        ? properties.delta
        : undefined;
    const partId = this.extractPartId(properties);

    if (!delta || !partId) {
      return;
    }

    const text = this.consumeVisiblePartDelta(partId, delta);
    this.pushVisibleOutput(text);
  }

  private handleMessagePartRemoved(properties: unknown): void {
    if (!isRecord(properties)) {
      return;
    }

    const partId = this.extractPartId(properties);
    if (!partId) {
      return;
    }

    this.emittedTextByPartId.delete(partId);
  }

  /* ---- Session helpers ---- */

  private unwrapOrThrow<T>(result: SdkResult<T>): T {
    if (result.error !== undefined) {
      throw new Error(`SDK error: ${describeUnknownError(result.error)}`);
    }
    return result.data as T;
  }

  private async ensureSession(): Promise<string> {
    if (this.activeSessionId && this.client) {
      // Verify the session still exists.
      try {
        const result = await this.client.session.get({ path: { id: this.activeSessionId } });
        if (result.error === undefined) {
          return this.activeSessionId;
        }
      } catch {
        // Session doesn't exist anymore, create a new one.
      }
      this.activeSessionId = null;
    }

    if (!this.client) {
      throw new Error("OpenCode SDK client is not initialized.");
    }

    const session = this.unwrapOrThrow(
      await this.client.session.create({ body: {} }),
    );
    this.assignActiveSession(session.id);
    return session.id;
  }

  /* ---- Attach process (local TUI) ---- */

  private spawnAttachProcess(): void {
    const url = `http://${OPENCODE_SERVER_HOST}:${this.serverPort}`;
    const env = buildCliEnvironment(this.options.kind);
    const attachArgs = ["attach", url];

    try {
      const target = resolveSpawnTarget(this.options.command, this.options.kind, { env });
      const child = spawnChildProcess(target.file, [...target.args, ...attachArgs], {
        cwd: this.options.cwd,
        env,
        stdio: "inherit",
        windowsHide: false,
      });

      this.attachProcess = child;

      child.once("error", (error: Error) => {
        if (this.attachProcess === child) {
          this.attachProcess = null;
          if (!this.shuttingDown) {
            process.stderr.write(
              `[opencode-adapter] opencode attach error: ${describeUnknownError(error)}\n`,
            );
          }
        }
      });

      child.once("exit", (exitCode: number | null) => {
        if (this.attachProcess === child) {
          this.attachProcess = null;
          if (!this.shuttingDown) {
            process.stderr.write(
              `[opencode-adapter] Local TUI (opencode attach) exited with code ${exitCode ?? "unknown"}. The server is still running.\n`,
            );
          }
        }
      });
    } catch (err) {
      process.stderr.write(
        `[opencode-adapter] Failed to spawn opencode attach: ${describeUnknownError(err)}\n`,
      );
    }
  }

  private detachLocalTerminal(): void {
    if (this.attachProcess) {
      try {
        this.attachProcess.kill();
      } catch {
        // Best effort.
      }
      this.attachProcess = null;
    }
  }

  /* ---- Working notice ---- */

  private armWechatWorkingNotice(): void {
    this.clearWechatWorkingNotice();
    if (
      this.workingNoticeSent ||
      !this.hasAcceptedInput ||
      this.state.status !== "busy" ||
      this.pendingPermission ||
      this.state.activeTurnOrigin !== "wechat"
    ) {
      return;
    }

    this.workingNoticeTimer = setTimeout(() => {
      this.workingNoticeTimer = null;
      if (
        this.workingNoticeSent ||
        !this.hasAcceptedInput ||
        this.state.status !== "busy" ||
        this.pendingPermission ||
        this.state.activeTurnOrigin !== "wechat"
      ) {
        return;
      }

      this.workingNoticeSent = true;
      this.emit({
        type: "notice",
        text: `OpenCode is still working on:\n${this.currentPreview}`,
        level: "info",
        timestamp: nowIso(),
      });
    }, this.workingNoticeDelayMs);
    this.workingNoticeTimer.unref?.();
  }

  private clearWechatWorkingNotice(resetSent = false): void {
    if (this.workingNoticeTimer) {
      clearTimeout(this.workingNoticeTimer);
      this.workingNoticeTimer = null;
    }
    if (resetSent) {
      this.workingNoticeSent = false;
    }
  }

  /* ---- Output batching ---- */

  private flushOutputBatch(text: string): void {
    this.emit({
      type: "stdout",
      text,
      timestamp: nowIso(),
    });
  }

  /* ---- Core helpers ---- */

  private emit(event: BridgeEvent): void {
    this.eventSink(event);
  }

  private assignActiveSession(sessionId: string | null | undefined): boolean {
    if (!sessionId) {
      return false;
    }

    const changed = sessionId !== this.activeSessionId;
    this.activeSessionId = sessionId;
    this.state.sharedSessionId = sessionId;
    this.state.activeRuntimeSessionId = sessionId;
    this.publishLocalEndpoint();
    return changed;
  }

  private extractSessionId(properties: Record<string, unknown>): string | null {
    if (typeof properties.sessionID === "string") {
      return properties.sessionID;
    }

    const info = properties.info;
    if (isRecord(info) && typeof info.id === "string") {
      return info.id;
    }

    return null;
  }

  private announceLocalSessionSwitch(sessionId: string): void {
    const timestamp = nowIso();
    this.state.lastSessionSwitchAt = timestamp;
    this.state.lastSessionSwitchSource = "local";
    this.state.lastSessionSwitchReason = "local_follow";
    this.emit({
      type: "session_switched",
      sessionId,
      source: "local",
      reason: "local_follow",
      timestamp,
    });
  }

  private shouldPublishLocalEndpoint(): boolean {
    return this.options.renderMode === "embedded";
  }

  private shouldSpawnAttachProcess(): boolean {
    return this.options.renderMode === "panel" || this.options.renderMode === "companion";
  }

  private publishLocalEndpoint(): void {
    if (!this.shouldPublishLocalEndpoint() || !this.serverPort || !this.state.startedAt) {
      return;
    }

    const sharedSessionId = this.activeSessionId ?? this.state.sharedSessionId;
    const payload: LocalCompanionEndpoint = {
      instanceId: this.endpoint?.instanceId ?? `${process.pid}-${Date.now().toString(36)}`,
      kind: this.options.kind,
      port: this.serverPort,
      token: this.endpointToken,
      renderMode: "embedded",
      bridgeOwnerPid: process.pid,
      serverPort: this.serverPort,
      serverUrl: this.getServerUrl(),
      cwd: this.options.cwd,
      command: this.options.command,
      profile: this.options.profile,
      sharedSessionId,
      sharedThreadId: sharedSessionId,
      startedAt: this.state.startedAt,
    };

    writeLocalCompanionEndpoint(payload);
    this.endpoint = payload;
  }

  private clearLocalEndpoint(): void {
    if (!this.shouldPublishLocalEndpoint()) {
      return;
    }

    clearLocalCompanionEndpoint(this.options.cwd, this.endpoint?.instanceId);
    this.endpoint = null;
  }

  private getServerUrl(): string {
    return `http://${OPENCODE_SERVER_HOST}:${this.serverPort}`;
  }

  private isVisibleTextPart(part: Record<string, unknown> | undefined): part is SdkPart {
    return !!part && part.type === "text" && part.ignored !== true;
  }

  private extractPartId(
    properties: Record<string, unknown>,
    part?: Record<string, unknown> | undefined,
  ): string | null {
    if (typeof properties.partID === "string") {
      return properties.partID;
    }

    if (typeof part?.id === "string") {
      return part.id;
    }

    return null;
  }

  private consumeVisiblePartSnapshot(partId: string, text: string): string {
    const nextText = normalizeOutput(text);
    if (!nextText) {
      return "";
    }

    const previousText = this.emittedTextByPartId.get(partId) ?? "";
    if (nextText === previousText) {
      return "";
    }

    this.emittedTextByPartId.set(partId, nextText);
    if (!previousText) {
      return nextText;
    }

    if (nextText.startsWith(previousText)) {
      return nextText.slice(previousText.length);
    }

    const sharedPrefixLength = this.getSharedPrefixLength(previousText, nextText);
    return nextText.slice(sharedPrefixLength);
  }

  private consumeVisiblePartDelta(partId: string, delta: string): string {
    const nextChunk = normalizeOutput(delta);
    if (!nextChunk) {
      return "";
    }

    const previousText = this.emittedTextByPartId.get(partId) ?? "";
    if (nextChunk === previousText || previousText.endsWith(nextChunk)) {
      return "";
    }

    if (previousText && nextChunk.startsWith(previousText)) {
      this.emittedTextByPartId.set(partId, nextChunk);
      return nextChunk.slice(previousText.length);
    }

    this.emittedTextByPartId.set(partId, `${previousText}${nextChunk}`);
    return nextChunk;
  }

  private pushVisibleOutput(text: string): void {
    if (!text) {
      return;
    }

    this.state.lastOutputAt = nowIso();
    this.outputBatcher.push(text);
  }

  private clearStreamedPartState(): void {
    this.emittedTextByPartId.clear();
  }

  private getSharedPrefixLength(left: string, right: string): number {
    const limit = Math.min(left.length, right.length);
    let index = 0;
    while (index < limit && left[index] === right[index]) {
      index += 1;
    }
    return index;
  }

  private logDebug(message: string): void {
    if (!OPENCODE_DEBUG_ENABLED) {
      return;
    }
    process.stderr.write(`${message}\n`);
  }

  private logUnknownEvent(type: string): void {
    if (!OPENCODE_DEBUG_ENABLED || this.loggedUnknownEventTypes.has(type)) {
      return;
    }
    this.loggedUnknownEventTypes.add(type);
    this.logDebug(`[opencode-adapter:sse] Unknown event: ${type}`);
  }

  private setStatus(
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
}
