import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as k8s from "@kubernetes/client-node";
import type { Writable } from "node:stream";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

// All K8s API mock functions — declared before vi.mock() so the factory can
// reference them.  The mock's logApi.log default is a never-resolving promise,
// simulating the FAR-10 hang where K8s API drops the connection indefinitely.
const mockLogFn = vi.fn();
const mockGetSelfPodInfo = vi.fn();
const mockBatchListJobs = vi.fn();
const mockBatchCreateJob = vi.fn();
const mockBatchReadJob = vi.fn();
const mockBatchDeleteJob = vi.fn();
const mockBatchPatchJob = vi.fn();
const mockCoreListPods = vi.fn();
const mockCoreReadPodLog = vi.fn();
const mockCoreCreateSecret = vi.fn();
const mockCorePatchSecret = vi.fn();
const mockCoreDeleteSecret = vi.fn();
// vi.hoisted ensures a single vi.fn() instance shared between the mock factory
// (which runs at hoist time) and the test body (which calls mockResolvedValue).
// A plain const would be re-assigned at its original position, leaving the
// factory with a stale reference to a different vi.fn() instance.
const mockReadSkillEntries = vi.hoisted(() => vi.fn());

vi.mock("./k8s-client.js", () => ({
  getLogApi: () => ({ log: mockLogFn }),
  getBatchApi: () => ({
    listNamespacedJob: mockBatchListJobs,
    createNamespacedJob: mockBatchCreateJob,
    readNamespacedJob: mockBatchReadJob,
    deleteNamespacedJob: mockBatchDeleteJob,
    patchNamespacedJob: mockBatchPatchJob,
  }),
  getCoreApi: () => ({
    listNamespacedPod: mockCoreListPods,
    readNamespacedPodLog: mockCoreReadPodLog,
    createNamespacedSecret: mockCoreCreateSecret,
    patchNamespacedSecret: mockCorePatchSecret,
    deleteNamespacedSecret: mockCoreDeleteSecret,
  }),
  getAuthzApi: () => ({}),
  getSelfPodInfo: mockGetSelfPodInfo,
  resetCache: vi.fn(),
}));

const mockPrepareBundle = vi.fn();
vi.mock("./prompt-cache.js", () => ({
  prepareClaudePromptBundle: mockPrepareBundle,
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const original = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  // Enumerate all original exports so transitive deps (job-manifest.ts, parse.ts,
  // prompt-cache.ts, etc.) keep working.  Only readPaperclipRuntimeSkillEntries
  // is replaced so tests run without real fs.stat I/O under fake timers.
  return Object.assign(Object.create(null), original, {
    readPaperclipRuntimeSkillEntries: mockReadSkillEntries,
  });
});

const { isK8s404, buildPartialRunError, classifyOrphan, describePodTerminatedError, streamPodLogsOnce, shouldAbortForCancellation, execute } = await import("./execute.js");

function makeJob(opts: {
  runId?: string;
  agentId?: string;
  taskId?: string;
  sessionId?: string;
  adapterType?: string;
  terminal?: boolean;
}): k8s.V1Job {
  const labels: Record<string, string> = {
    "paperclip.io/adapter-type": opts.adapterType ?? "claude_k8s",
  };
  if (opts.agentId) labels["paperclip.io/agent-id"] = opts.agentId;
  if (opts.runId) labels["paperclip.io/run-id"] = opts.runId;
  if (opts.taskId) labels["paperclip.io/task-id"] = opts.taskId;
  if (opts.sessionId) labels["paperclip.io/session-id"] = opts.sessionId;
  return {
    metadata: { name: "ac-job", namespace: "paperclip", labels },
    status: opts.terminal
      ? { conditions: [{ type: "Complete", status: "True" }] }
      : { conditions: [] },
  } as k8s.V1Job;
}

describe("isK8s404", () => {
  it("returns false for non-Error values", () => {
    expect(isK8s404(null)).toBe(false);
    expect(isK8s404(undefined)).toBe(false);
    expect(isK8s404("string error")).toBe(false);
    expect(isK8s404(404)).toBe(false);
  });

  it("returns false for unrelated errors", () => {
    expect(isK8s404(new Error("something went wrong"))).toBe(false);
    expect(isK8s404(new Error("HTTP-Code: 500 Message: Internal Server Error"))).toBe(false);
  });

  it("detects 404 from v1.0+ message format", () => {
    const err = new Error("HTTP-Code: 404 Message: Unknown API Status Code! Body: ...");
    expect(isK8s404(err)).toBe(true);
  });

  it("detects 404 from v0.x response.statusCode", () => {
    const err = Object.assign(new Error("Not Found"), {
      response: { statusCode: 404 },
    });
    expect(isK8s404(err)).toBe(true);
  });

  it("detects 404 from v1.0+ response.status", () => {
    const err = Object.assign(new Error("Not Found"), {
      response: { status: 404 },
    });
    expect(isK8s404(err)).toBe(true);
  });

  it("detects 404 from direct statusCode property", () => {
    const err = Object.assign(new Error("Not Found"), { statusCode: 404 });
    expect(isK8s404(err)).toBe(true);
  });

  it("does not match non-404 status codes on response", () => {
    const err = Object.assign(new Error("Forbidden"), {
      response: { statusCode: 403 },
    });
    expect(isK8s404(err)).toBe(false);
  });
});

describe("buildPartialRunError", () => {
  const initLine = JSON.stringify({
    type: "system",
    subtype: "init",
    model: "claude-sonnet-4-6",
    session_id: "sess_abc",
  });

  it("returns parse-failure message when exitCode is 0", () => {
    expect(buildPartialRunError(0, "", "")).toBe("Failed to parse Claude JSON output");
    expect(buildPartialRunError(0, "claude-sonnet-4-6", initLine)).toBe(
      "Failed to parse Claude JSON output",
    );
  });

  it("returns generic exit message when stdout is empty", () => {
    expect(buildPartialRunError(1, "", "")).toBe("Claude exited with code 1");
    expect(buildPartialRunError(null, "", "")).toBe("Claude exited with code -1");
  });

  it("skips system/init events and returns generic message when only init captured", () => {
    const msg = buildPartialRunError(1, "claude-sonnet-4-6", initLine);
    expect(msg).toBe(
      "Claude started but did not produce a result (model: claude-sonnet-4-6) — check API credentials, model support, and adapter config",
    );
  });

  it("includes model from parsedStream when stdout is init-only", () => {
    const msg = buildPartialRunError(null, "MiniMax-M2.7", initLine);
    expect(msg).toContain("MiniMax-M2.7");
    expect(msg).not.toContain("type");
    expect(msg).not.toContain("system");
  });

  it("uses first non-system line as content when present", () => {
    const stdout = [initLine, "Error: no API key configured"].join("\n");
    const msg = buildPartialRunError(1, "claude-sonnet-4-6", stdout);
    expect(msg).toBe("Claude exited with code 1: Error: no API key configured");
  });

  it("skips result events (structured protocol artefact — not surfaced verbatim)", () => {
    // In production, buildPartialRunError is only called when parseClaudeStreamJson
    // returns null (no result event).  If somehow a result event appears here, the
    // raw JSON blob must not be shown — the "did not produce a result" message is
    // cleaner and avoids leaking protocol internals to the UI.
    const resultLike = JSON.stringify({ type: "result", subtype: "error", result: "rate limit" });
    const stdout = [initLine, resultLike].join("\n");
    const msg = buildPartialRunError(2, "claude-sonnet-4-6", stdout);
    expect(msg).toContain("did not produce a result");
    expect(msg).toContain("claude-sonnet-4-6");
    expect(msg).not.toMatch(/\{.*type.*result/);
  });

  it("skips rate_limit_event and surfaces model hint (FAR-32 Anthropic/Nancy repro)", () => {
    // Reproduces the second variant from FAR-32: init event + rate_limit_event +
    // assistant event (thinking only, no result).  The rate_limit_event JSON blob
    // must not appear verbatim in the error message.
    const rateLimitEvent = JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", resetsAt: 1777056000, rateLimitType: "five_hour" },
      uuid: "3ab8f9eb-b9d6-4bf6-9c39-4608427717fc",
      session_id: "ad5f3e11-3c0c-4144-b53d-d4b959e57cee",
    });
    const stdout = [initLine, rateLimitEvent].join("\n");
    const msg = buildPartialRunError(null, "claude-opus-4-7", stdout);
    expect(msg).toContain("claude-opus-4-7");
    expect(msg).toContain("did not produce a result");
    expect(msg).not.toContain("rate_limit_event");
    expect(msg).not.toContain("rateLimitType");
  });

  it("skips assistant events and surfaces model hint (FAR-32: MiniMax-M2.7 output_tokens=0)", () => {
    // Reproduces the exact failure: init event + assistant event with only a
    // thinking block and output_tokens=0, no result event.  The assistant JSON
    // blob must not be surfaced verbatim as the error message.
    const assistantEvent = JSON.stringify({
      type: "assistant",
      message: {
        id: "063ad6038e4c889faa7c95168e007d73",
        type: "message",
        role: "assistant",
        content: [{ type: "thinking", thinking: "Let me start…", signature: "abc123" }],
        model: "MiniMax-M2.7",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 11013, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
    const stdout = [initLine, assistantEvent].join("\n");
    const msg = buildPartialRunError(null, "MiniMax-M2.7", stdout);
    expect(msg).toContain("MiniMax-M2.7");
    expect(msg).toContain("did not produce a result");
    expect(msg).not.toContain("063ad6038e4c889faa7c95168e007d73");
    expect(msg).not.toContain("output_tokens");
    expect(msg).not.toContain("thinking");
  });

  it("skips user events alongside system events", () => {
    const userEvent = JSON.stringify({ type: "user", message: { role: "user", content: [] } });
    const stdout = [initLine, userEvent, "Error: API quota exceeded"].join("\n");
    const msg = buildPartialRunError(1, "claude-sonnet-4-6", stdout);
    expect(msg).toBe("Claude exited with code 1: Error: API quota exceeded");
  });

  it("null exitCode renders as -1 in message", () => {
    const msg = buildPartialRunError(null, "", "Some plain error text");
    expect(msg).toBe("Claude exited with code -1: Some plain error text");
  });

  it("skips multiple consecutive system events", () => {
    const anotherSystem = JSON.stringify({ type: "system", subtype: "other" });
    const stdout = [initLine, anotherSystem, "real error line"].join("\n");
    const msg = buildPartialRunError(1, "model-x", stdout);
    expect(msg).toBe("Claude exited with code 1: real error line");
  });
});

describe("classifyOrphan", () => {
  const taskId = "task-xyz";
  const sessionId = "sess-123";

  // --- Happy path: reattach ---
  it("returns reattach when taskId matches and both sessionIds match", () => {
    const job = makeJob({ taskId, sessionId });
    expect(classifyOrphan(job, { taskId, sessionId })).toBe("reattach");
  });

  it("returns reattach when taskId matches and expected sessionId is null (missing on current side)", () => {
    const job = makeJob({ taskId, sessionId });
    expect(classifyOrphan(job, { taskId, sessionId: null })).toBe("reattach");
  });

  it("returns reattach when taskId matches and job has no session-id label (missing on job side)", () => {
    const job = makeJob({ taskId });
    expect(classifyOrphan(job, { taskId, sessionId })).toBe("reattach");
  });

  it("returns reattach when taskId matches and neither side has a sessionId", () => {
    const job = makeJob({ taskId });
    expect(classifyOrphan(job, { taskId, sessionId: null })).toBe("reattach");
  });

  // --- Block: task unknown ---
  it("returns block_task_unknown when expected taskId is null", () => {
    const job = makeJob({ taskId, sessionId });
    expect(classifyOrphan(job, { taskId: null, sessionId })).toBe("block_task_unknown");
  });

  it("returns block_task_unknown when job has no task-id label", () => {
    const job = makeJob({ sessionId });
    expect(classifyOrphan(job, { taskId, sessionId })).toBe("block_task_unknown");
  });

  // --- Block: task mismatch ---
  it("returns block_task_mismatch when both sides have taskId but they differ", () => {
    const job = makeJob({ taskId: "task-other", sessionId });
    expect(classifyOrphan(job, { taskId, sessionId })).toBe("block_task_mismatch");
  });

  // --- Block: session mismatch ---
  it("returns block_session_mismatch when taskId matches but sessionIds differ", () => {
    const job = makeJob({ taskId, sessionId: "sess-other" });
    expect(classifyOrphan(job, { taskId, sessionId })).toBe("block_session_mismatch");
  });

  // --- Terminal orphan (caller filters these before classifyOrphan) ---
  it("returns reattach for terminal job (caller is responsible for filtering terminals)", () => {
    const job = makeJob({ taskId, sessionId, terminal: true });
    // classifyOrphan does not check terminal status — that is the caller's job
    expect(classifyOrphan(job, { taskId, sessionId })).toBe("reattach");
  });
});

// Regression: FAR-10 — waitForPod must throw on phase=Failed, not return the pod name.
// These tests cover describePodTerminatedError, the helper that waitForPod uses to build
// the error message before throwing.  Verifies that phase=Failed with no claude logs
// produces a structured, actionable error instead of silently entering the log-stream path.
describe("describePodTerminatedError", () => {
  it("includes exit code and reason when claude container status is available", () => {
    const cs = [
      {
        name: "claude",
        state: { terminated: { exitCode: 137, reason: "OOMKilled" } },
      },
    ] as k8s.V1ContainerStatus[];
    const msg = describePodTerminatedError("mypod", "Failed", cs);
    expect(msg).toContain("137");
    expect(msg).toContain("OOMKilled");
    expect(msg).toContain("phase=Failed");
  });

  it("falls back to message field when reason is absent", () => {
    const cs = [
      {
        name: "claude",
        state: { terminated: { exitCode: 1, message: "signal: killed" } },
      },
    ] as k8s.V1ContainerStatus[];
    const msg = describePodTerminatedError("mypod", "Failed", cs);
    expect(msg).toContain("signal: killed");
    expect(msg).toContain("1");
  });

  it("returns generic message when no claude container status is present", () => {
    const msg = describePodTerminatedError("mypod", "Failed", []);
    expect(msg).toBe("Pod mypod reached phase=Failed");
  });

  it("ignores non-claude containers", () => {
    const cs = [
      {
        name: "sidecar",
        state: { terminated: { exitCode: 0, reason: "Completed" } },
      },
    ] as k8s.V1ContainerStatus[];
    const msg = describePodTerminatedError("mypod", "Failed", cs);
    expect(msg).toBe("Pod mypod reached phase=Failed");
  });

  it("handles null exitCode gracefully", () => {
    const cs = [
      {
        name: "claude",
        state: { terminated: { exitCode: null, reason: "Error" } },
      },
    ] as unknown as k8s.V1ContainerStatus[];
    const msg = describePodTerminatedError("mypod", "Failed", cs);
    expect(msg).toContain("unknown");
    expect(msg).toContain("Error");
  });
});

describe("execute: all-invalid agent.id (N4)", () => {
  it("returns hard error without creating a Job when agent.id sanitizes to null", async () => {
    const logs: string[] = [];
    const result = await execute({
      runId: "run-001",
      agent: { id: "@@@", companyId: "co1", name: "Bad Agent", adapterType: "claude_k8s", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {},
      context: {},
      onLog: async (_stream, msg) => { logs.push(msg); },
    });
    expect(result.errorCode).toBe("k8s_agent_id_invalid");
    expect(result.errorMessage).toContain("@@@");
    // getSelfPodInfo must NOT have been called (early return before K8s calls)
    const { getSelfPodInfo } = await import("./k8s-client.js");
    expect(getSelfPodInfo).not.toHaveBeenCalled();
  });
});

// Regression: FAR-10 hardening — streamPodLogsOnce must not hang forever when
// the K8s client's logApi.log call never resolves.  When stopSignal fires, the
// bail timer must force-return within LOG_STREAM_BAIL_TIMEOUT_MS (3s in the
// implementation) so execute() does not get stuck waiting for a dead stream.
describe("streamPodLogsOnce bail timer", () => {
  beforeEach(() => {
    mockLogFn.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns within the bail window when stopSignal fires during a hung log call", async () => {
    // logApi.log never resolves — simulates the FAR-10 hang where the K8s
    // response stream stalls without closing the connection.
    mockLogFn.mockImplementation((_ns, _pod, _ctr, _writable: Writable) => {
      return new Promise(() => { /* never resolves */ });
    });

    const stopSignal = { stopped: false };
    const onLog = vi.fn().mockResolvedValue(undefined);

    const resultPromise = streamPodLogsOnce(
      "default",
      "mypod",
      onLog,
      undefined,
      undefined,
      undefined,
      stopSignal,
    );

    // Fire stopSignal; let the 200ms poller tick and start the bail timer.
    stopSignal.stopped = true;
    await vi.advanceTimersByTimeAsync(300);

    // Advance past the 3s bail timeout.  streamPodLogsOnce must now resolve
    // with an empty string (no chunks were captured) rather than hanging.
    await vi.advanceTimersByTimeAsync(3_100);

    const result = await resultPromise;
    expect(result).toBe("");
    expect(mockLogFn).toHaveBeenCalledOnce();
  });

  it("returns promptly if logApi.log resolves before stopSignal fires (happy path, no bail involved)", async () => {
    mockLogFn.mockImplementation(async (_ns, _pod, _ctr, _writable: Writable) => {
      // Resolve immediately — normal log-stream completion.
      return undefined;
    });

    const onLog = vi.fn().mockResolvedValue(undefined);

    // No stopSignal → no bail machinery engaged.
    const result = await streamPodLogsOnce(
      "default",
      "mypod",
      onLog,
      undefined,
      undefined,
      undefined,
      undefined,
    );

    expect(result).toBe("");
    expect(mockLogFn).toHaveBeenCalledOnce();
  });
});

// ─── Helpers shared across execute() integration tests ───────────────────────

function makeCtx(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-test-001",
    agent: {
      id: "agent-abc",
      companyId: "co1",
      name: "Test Agent",
      adapterType: "claude_k8s",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {},
    context: {},
    onLog: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as AdapterExecutionContext;
}

function makeSelfPodResult() {
  return {
    namespace: "paperclip",
    image: "paperclipai/paperclip:latest",
    imagePullSecrets: [],
    dnsConfig: undefined,
    pvcClaimName: "paperclip-data",
    secretVolumes: [],
    inheritedEnv: {},
    inheritedEnvValueFrom: [],
    inheritedEnvFrom: [],
  };
}

function makeBundle() {
  return {
    bundleKey: "test-bundle",
    rootDir: "/tmp/test-bundle",
    addDir: "/tmp/test-bundle",
    instructionsFilePath: null,
  };
}

// Valid minimal Claude stream-json output used in happy-path tests.
const CLAUDE_HAPPY_OUTPUT = [
  JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet-4-6", session_id: "sess_test123" }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    result: "Done.",
    session_id: "sess_test123",
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 },
    total_cost_usd: 0.001,
  }),
].join("\n") + "\n";

// ─── execute: concurrency guard paths ────────────────────────────────────────

describe("execute: concurrency guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadSkillEntries.mockResolvedValue([]);
    mockGetSelfPodInfo.mockResolvedValue(makeSelfPodResult());
  });

  it("returns k8s_concurrency_guard_unreachable when listNamespacedJob throws", async () => {
    mockBatchListJobs.mockRejectedValue(new Error("K8s API unavailable"));
    const result = await execute(makeCtx());
    expect(result.errorCode).toBe("k8s_concurrency_guard_unreachable");
    expect(result.errorMessage).toContain("K8s API unavailable");
  });

  it("returns k8s_concurrent_run_blocked when reattach disabled and orphan is running", async () => {
    const orphan = makeJob({ runId: "prior-run", agentId: "agent-abc", terminal: false });
    mockBatchListJobs.mockResolvedValue({ items: [orphan] });
    const result = await execute(makeCtx({ config: { reattachOrphanedJobs: false } } as Partial<AdapterExecutionContext>));
    expect(result.errorCode).toBe("k8s_concurrent_run_blocked");
    expect(result.errorMessage).toContain("reattach disabled");
  });

  it("returns k8s_orphan_task_unknown when orphan has no task label", async () => {
    // No taskId on the orphan job and no taskId in context → block_task_unknown
    const orphan = makeJob({ runId: "prior-run", agentId: "agent-abc" }); // no taskId label
    mockBatchListJobs.mockResolvedValue({ items: [orphan] });
    // context.taskId absent → currentTaskLabel = null → block_task_unknown
    const result = await execute(makeCtx());
    expect(result.errorCode).toBe("k8s_orphan_task_unknown");
  });

  it("returns k8s_concurrent_run_blocked when orphan task-id mismatches current task", async () => {
    const orphan = makeJob({ runId: "prior-run", agentId: "agent-abc", taskId: "task-other" });
    mockBatchListJobs.mockResolvedValue({ items: [orphan] });
    const result = await execute(
      makeCtx({ context: { taskId: "task-current" } } as Partial<AdapterExecutionContext>),
    );
    expect(result.errorCode).toBe("k8s_concurrent_run_blocked");
    expect(result.errorMessage).toContain("different task");
  });

  it("returns k8s_orphan_session_mismatch when task matches but session differs", async () => {
    const orphan = makeJob({
      runId: "prior-run",
      agentId: "agent-abc",
      taskId: "task-match",
      sessionId: "sess-other",
    });
    mockBatchListJobs.mockResolvedValue({ items: [orphan] });
    const result = await execute(
      makeCtx({
        context: { taskId: "task-match" },
        runtime: { sessionId: "sess-current", sessionParams: null, sessionDisplayId: null, taskKey: null },
      } as Partial<AdapterExecutionContext>),
    );
    expect(result.errorCode).toBe("k8s_orphan_session_mismatch");
    expect(result.errorMessage).toContain("mismatched session");
  });

  it("returns k8s_concurrent_run_blocked when same-run job is still running", async () => {
    // runId matches → samRun.length > 0 → blocked
    const sameRunJob = makeJob({ runId: "run-test-001", agentId: "agent-abc", terminal: false });
    mockBatchListJobs.mockResolvedValue({ items: [sameRunJob] });
    const result = await execute(makeCtx());
    expect(result.errorCode).toBe("k8s_concurrent_run_blocked");
    expect(result.errorMessage).toContain("still running for this agent");
  });

  it("ignores terminating jobs (deletionTimestamp set) and proceeds past the concurrency guard", async () => {
    // A job being force-deleted has deletionTimestamp set but no Complete/Failed condition.
    // The guard must treat it as terminal so subsequent runs are not blocked.
    const terminating: k8s.V1Job = {
      metadata: {
        name: "terminating-job",
        namespace: "paperclip",
        labels: { "paperclip.io/agent-id": "agent-abc", "paperclip.io/adapter-type": "claude_k8s" },
        deletionTimestamp: new Date(),
      },
      status: { conditions: [] },
    };
    mockBatchListJobs.mockResolvedValue({ items: [terminating] });
    // Guard passes → next failure is job creation (no further mocks set up)
    mockBatchCreateJob.mockRejectedValue(new Error("quota exceeded"));
    mockPrepareBundle.mockResolvedValue(makeBundle());
    const result = await execute(makeCtx());
    // Must NOT be a concurrency error — the guard let us through
    expect(result.errorCode).not.toBe("k8s_concurrent_run_blocked");
    expect(result.errorCode).toBe("k8s_job_create_failed");
  });

  it("reattaches to a matching orphan and returns k8s_pod_reattach_failed when pod is missing", async () => {
    // Orphan with matching taskId and sessionId → reattach classification → reattachTarget is set
    const orphan = makeJob({
      runId: "prior-run",
      agentId: "agent-abc",
      taskId: "task-match",
      sessionId: "sess-match",
    });
    mockBatchListJobs.mockResolvedValue({ items: [orphan] });
    mockBatchPatchJob.mockResolvedValue({});
    mockPrepareBundle.mockResolvedValue(makeBundle());
    // Pod lookup finds nothing → reattach pod-not-found error
    mockCoreListPods.mockResolvedValue({ items: [] });

    const result = await execute(
      makeCtx({
        context: { taskId: "task-match" },
        runtime: { sessionId: "sess-match", sessionParams: null, sessionDisplayId: null, taskKey: null },
      } as Partial<AdapterExecutionContext>),
    );

    expect(result.errorCode).toBe("k8s_pod_reattach_failed");
    expect(result.errorMessage).toContain("no pod");
  });
});

// ─── execute: job creation paths ─────────────────────────────────────────────

describe("execute: job creation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockReadSkillEntries.mockResolvedValue([]);
    mockGetSelfPodInfo.mockResolvedValue(makeSelfPodResult());
    mockBatchListJobs.mockResolvedValue({ items: [] }); // no concurrent jobs
    mockPrepareBundle.mockResolvedValue(makeBundle());
    mockBatchCreateJob.mockResolvedValue({ metadata: { uid: "job-uid-1" } });
    mockBatchDeleteJob.mockResolvedValue({});
  });

  it("returns k8s_job_create_failed when createNamespacedJob throws", async () => {
    mockBatchCreateJob.mockRejectedValue(new Error("quota exceeded"));
    const result = await execute(makeCtx());
    expect(result.errorCode).toBe("k8s_job_create_failed");
    expect(result.errorMessage).toContain("quota exceeded");
  });

  it("returns k8s_pod_schedule_failed when pod scheduling times out", async () => {
    mockBatchCreateJob.mockResolvedValue({ metadata: { uid: "uid-1" } });
    mockBatchDeleteJob.mockResolvedValue({});
    // Pod never appears → waitForPod eventually times out.
    // Provide a config with very short timeout to avoid a real 2-minute wait.
    // Instead, make listNamespacedPod return an unschedulable condition immediately.
    mockCoreListPods.mockResolvedValue({
      items: [
        {
          metadata: { name: "pod-xyz" },
          status: {
            phase: "Pending",
            conditions: [
              { type: "PodScheduled", status: "False", reason: "Unschedulable", message: "no nodes available" },
            ],
            containerStatuses: [],
            initContainerStatuses: [],
          },
        },
      ],
    });

    const result = await execute(makeCtx());

    expect(result.errorCode).toBe("k8s_pod_schedule_failed");
    expect(result.errorMessage).toContain("unschedulable");
  });
});

// ─── execute: full happy path ─────────────────────────────────────────────────

describe("execute: happy path", () => {
  // vi.resetAllMocks() ensures the mockResolvedValueOnce queue is fully cleared
  // before each test so beforeEach always starts with a known queue depth of zero.
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    mockReadSkillEntries.mockResolvedValue([]);
    mockGetSelfPodInfo.mockResolvedValue(makeSelfPodResult());
    mockBatchListJobs.mockResolvedValue({ items: [] });
    mockPrepareBundle.mockResolvedValue(makeBundle());
    mockBatchCreateJob.mockResolvedValue({ metadata: { uid: "job-uid-1" } });
    mockBatchPatchJob.mockResolvedValue({});

    // Default: waitForPod gets Running pod (once queue), getPodExitCode gets
    // the terminated-exit-0 pod (default return value).
    // Tests that need a different exit code should call
    //   mockCoreListPods.mockResolvedValue(exitCode1Pod)
    // which replaces only the default; the once-queue entry from this beforeEach
    // is still consumed by the first waitForPod call.
    mockCoreListPods
      .mockResolvedValueOnce({
        items: [
          {
            metadata: { name: "pod-abc" },
            status: { phase: "Running", containerStatuses: [], initContainerStatuses: [] },
          },
        ],
      })
      .mockResolvedValue({
        items: [
          {
            metadata: { name: "pod-abc" },
            status: {
              containerStatuses: [{ name: "claude", state: { terminated: { exitCode: 0 } } }],
            },
          },
        ],
      });

    // waitForJobCompletion: Complete on first read
    mockBatchReadJob.mockResolvedValue({
      status: { conditions: [{ type: "Complete", status: "True" }] },
    });

    // streamPodLogsOnce: write valid Claude output to the writable stream
    mockLogFn.mockImplementation(
      async (_ns: string, _pod: string, _ctr: string, writable: Writable) => {
        // chunks.push() is called synchronously inside the Writable handler,
        // so the output is captured even before the write callback fires.
        writable.write(CLAUDE_HAPPY_OUTPUT);
      },
    );

    mockBatchDeleteJob.mockResolvedValue({});
    mockCoreDeleteSecret.mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a successful result with session, usage, and model fields", async () => {
    const onSpawn = vi.fn().mockResolvedValue(undefined);
    const onMeta = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ onSpawn, onMeta } as Partial<AdapterExecutionContext>);

    const executePromise = execute(ctx);

    // streamPodLogs checks stopSignal after streamPodLogsOnce returns.  With fake
    // timers the reconnect delay (3 s) is held by a fake setTimeout — advance past
    // it so the loop exits and Promise.allSettled resolves.  advanceTimersByTimeAsync
    // flushes all pending microtasks between timer firings, including the
    // waitForJobCompletion resolution that sets logStopSignal.stopped = true.
    await vi.advanceTimersByTimeAsync(3_100);

    const result = await executePromise;

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.errorMessage).toBeNull();
    expect(result.sessionId).toBe("sess_test123");
    expect(result.usage?.inputTokens).toBe(100);
    expect(result.usage?.outputTokens).toBe(50);
    expect(result.usage?.cachedInputTokens).toBe(10);
    expect(result.provider).toBe("anthropic");
    // cleanupJob must have been called
    expect(mockBatchDeleteJob).toHaveBeenCalled();
  });

  it("returns timedOut=true when the job deadline is exceeded", async () => {
    // Override waitForJobCompletion to report DeadlineExceeded
    mockBatchReadJob.mockResolvedValue({
      status: {
        conditions: [{ type: "Failed", status: "True", reason: "DeadlineExceeded" }],
      },
    });

    const executePromise = execute(makeCtx({ config: { timeoutSec: 30 } } as Partial<AdapterExecutionContext>));
    await vi.advanceTimersByTimeAsync(3_100);
    const result = await executePromise;

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("timeout");
  });

  it("returns session_unavailable and clearSession=true on unknown-session Claude error", async () => {
    // isClaudeUnknownSessionError matches /no conversation found with session id/i
    const sessionErrorOutput = [
      JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet-4-6", session_id: "sess_bad" }),
      JSON.stringify({
        type: "result",
        subtype: "error",
        result: "No conversation found with session id sess_bad",
        is_error: true,
        session_id: "sess_bad",
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
        total_cost_usd: 0.0,
      }),
    ].join("\n") + "\n";

    mockLogFn.mockImplementation(
      async (_ns: string, _pod: string, _ctr: string, writable: Writable) => {
        writable.write(sessionErrorOutput);
      },
    );
    // Once-queue entry for waitForPod already set by beforeEach; override the
    // default so getPodExitCode returns exitCode=1.
    mockCoreListPods.mockResolvedValue({
      items: [{ metadata: { name: "pod-abc" }, status: { containerStatuses: [{ name: "claude", state: { terminated: { exitCode: 1 } } }] } }],
    });

    const executePromise = execute(
      makeCtx({ runtime: { sessionId: "sess_bad", sessionParams: null, sessionDisplayId: null, taskKey: null } } as Partial<AdapterExecutionContext>),
    );
    await vi.advanceTimersByTimeAsync(3_100);
    const result = await executePromise;

    expect(result.clearSession).toBe(true);
    expect(result.errorCode).toBe("session_unavailable");
  });

  it("surfaces buildPartialRunError when stdout has no result event", async () => {
    // Log stream returns only init line — no result event
    const noResultOutput = JSON.stringify({
      type: "system",
      subtype: "init",
      model: "claude-sonnet-4-6",
      session_id: "sess_x",
    }) + "\n";

    mockLogFn.mockImplementation(
      async (_ns: string, _pod: string, _ctr: string, writable: Writable) => {
        writable.write(noResultOutput);
      },
    );
    // Override default so getPodExitCode returns exit code 1 (model-hint path);
    // the once-queue entry from beforeEach is still consumed by waitForPod.
    mockCoreListPods.mockResolvedValue({
      items: [{ metadata: { name: "pod-abc" }, status: { containerStatuses: [{ name: "claude", state: { terminated: { exitCode: 1 } } }] } }],
    });

    const executePromise = execute(makeCtx());
    await vi.advanceTimersByTimeAsync(3_100);
    const result = await executePromise;

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("claude-sonnet-4-6");
  });

  it("does not delete the Job when retainJobs=true", async () => {
    const executePromise = execute(makeCtx({ config: { retainJobs: true } } as Partial<AdapterExecutionContext>));
    await vi.advanceTimersByTimeAsync(3_100);
    const result = await executePromise;

    expect(result.exitCode).toBe(0);
    expect(mockBatchDeleteJob).not.toHaveBeenCalled();
  });

  it("handles cleanupJob failure gracefully (best-effort)", async () => {
    mockBatchDeleteJob.mockRejectedValue(new Error("forbidden: delete not allowed"));

    const executePromise = execute(makeCtx());
    await vi.advanceTimersByTimeAsync(3_100);
    const result = await executePromise;

    // cleanupJob failure must not propagate — execute should still succeed
    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeNull();
  });

  it("falls back to one-shot readPodLogs when log stream returns empty", async () => {
    // Log stream writes nothing — simulates fast container exit before follow connect
    mockLogFn.mockImplementation(async () => {});
    // One-shot read returns full output
    mockCoreReadPodLog.mockResolvedValue(CLAUDE_HAPPY_OUTPUT);

    const executePromise = execute(makeCtx());
    await vi.advanceTimersByTimeAsync(3_100);
    const result = await executePromise;

    expect(result.sessionId).toBe("sess_test123");
    expect(mockCoreReadPodLog).toHaveBeenCalled();
  });

  it("replaces partial stream with longer one-shot pod log read", async () => {
    // Stream writes only the init line (no result event) — partial capture
    const initLine = JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet-4-6", session_id: "sess_x" }) + "\n";
    mockLogFn.mockImplementation(
      async (_ns: string, _pod: string, _ctr: string, writable: Writable) => {
        writable.write(initLine);
      },
    );
    // One-shot read returns the full output, which is longer and has a result event
    mockCoreReadPodLog.mockResolvedValue(CLAUDE_HAPPY_OUTPUT);

    const executePromise = execute(makeCtx());
    await vi.advanceTimersByTimeAsync(3_100);
    const result = await executePromise;

    expect(result.sessionId).toBe("sess_test123");
    expect(mockCoreReadPodLog).toHaveBeenCalled();
  });

  it("proceeds with captured output when job is deleted by TTL (404 in completion poll)", async () => {
    // waitForJobCompletion catches 404 and returns jobGone=true — execute must
    // continue to stdout parsing rather than returning an error.
    mockBatchReadJob.mockRejectedValue(
      Object.assign(new Error("Not Found"), { response: { statusCode: 404 } }),
    );

    const executePromise = execute(makeCtx());
    await vi.advanceTimersByTimeAsync(3_100);
    const result = await executePromise;

    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("sess_test123");
  });

  it("returns k8s_job_deleted_externally when job 404s mid-run and stdout has no result event (FAR-31)", async () => {
    // Reproduces the observed scenario: kubectl delete job while Claude is mid-run.
    // The log stream captures only partial output (no result event), and the pod
    // is also gone so getPodExitCode returns null.  The adapter must emit a
    // descriptive error instead of the misleading "Claude exited with code -1".

    // Log stream writes only the init line — no result event (mid-run deletion)
    const partialOutput = JSON.stringify({
      type: "system",
      subtype: "init",
      model: "claude-sonnet-4-6",
      session_id: "sess_x",
    }) + "\n";
    mockLogFn.mockImplementation(
      async (_ns: string, _pod: string, _ctr: string, writable: Writable) => {
        writable.write(partialOutput);
      },
    );

    // Job is gone (404) — matches the kubectl-delete-job-mid-run scenario
    mockBatchReadJob.mockRejectedValue(
      Object.assign(new Error("Not Found"), { response: { statusCode: 404 } }),
    );

    // Pod is also gone — getPodExitCode returns null (no pod found)
    mockCoreListPods.mockReset();
    mockCoreListPods
      .mockResolvedValueOnce({
        items: [{
          metadata: { name: "pod-abc" },
          status: { phase: "Running", containerStatuses: [], initContainerStatuses: [] },
        }],
      })
      .mockResolvedValue({ items: [] }); // pod gone → exitCode null

    const executePromise = execute(makeCtx());
    await vi.advanceTimersByTimeAsync(3_100);
    const result = await executePromise;

    expect(result.errorCode).toBe("k8s_job_deleted_externally");
    expect(result.errorMessage).toBe("K8s Job was deleted externally before Claude could complete");
    expect(result.exitCode).toBeNull();
  });

  it("returns llm_api_error when assistant event has stop_reason:null and output_tokens:0 (FAR-30)", async () => {
    // Reproduces the MiniMax degradation pattern: init event + assistant event with
    // stop_reason:null and output_tokens:0, no result event, Claude exits -1.
    const emptyResponseOutput = [
      JSON.stringify({ type: "system", subtype: "init", model: "MiniMax-M2.7", session_id: "sess_mm" }),
      JSON.stringify({
        type: "assistant",
        session_id: "sess_mm",
        message: {
          id: "msg_empty",
          stop_reason: null,
          usage: { input_tokens: 500, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          content: [],
        },
      }),
    ].join("\n") + "\n";

    mockLogFn.mockImplementation(
      async (_ns: string, _pod: string, _ctr: string, writable: Writable) => {
        writable.write(emptyResponseOutput);
      },
    );
    // getPodExitCode: exit code -1 (as reported in the issue)
    mockCoreListPods.mockResolvedValue({
      items: [{ metadata: { name: "pod-abc" }, status: { containerStatuses: [{ name: "claude", state: { terminated: { exitCode: -1 } } }] } }],
    });

    const executePromise = execute(makeCtx());
    await vi.advanceTimersByTimeAsync(3_100);
    const result = await executePromise;

    expect(result.errorCode).toBe("llm_api_error");
    expect(result.errorMessage).toContain("stop_reason: null");
    expect(result.errorMessage).toContain("output_tokens: 0");
  });

  it("reconnects log stream and logs status when job completion takes > 3s", async () => {
    // Make waitForJobCompletion take 4s so the 3s stream reconnect fires first.
    // timeoutSec=4, graceSec=0 → completionTimeoutMs=4000.
    // Sequence: poll at t=0 (non-terminal, 2s delay) → poll at t=2000 (non-terminal,
    // 2s delay) → at t=4000 deadline passes → timedOut=true → stopped=true.
    // Meanwhile: reconnect at t=3000 (attempt=1) → line 393 fires → stream reconnects.
    mockBatchReadJob.mockResolvedValue({ status: { conditions: [] } }); // never terminal

    const executePromise = execute(
      makeCtx({ config: { timeoutSec: 4, graceSec: 0 } } as Partial<AdapterExecutionContext>),
    );

    // readPaperclipRuntimeSkillEntries is mocked (no real I/O).  Timer sequence:
    //   t=2000: waitForJobCompletion poll 2 (non-terminal → sleep 2000ms)
    //   t=3000: streamPodLogs reconnect sleep fires (attempt=1 → sleep 3000ms more)
    //   t=4000: waitForJobCompletion deadline exceeded → timedOut=true → stopped=true
    //   t=6000: reconnect sleep fires → while(!stopped) → exits → allSettled resolves
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(2_000);

    const result = await executePromise;

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("timeout");
  });

  it("waitForJobCompletion respects deadline and returns timedOut via poll loop", async () => {
    // timeoutSec=1, graceSec=0 → completionTimeoutMs=1000ms. The poll delay (2s)
    // fires at t=2000 > deadline (t=1000) → while loop exits → returns timedOut.
    mockBatchReadJob.mockResolvedValue({ status: { conditions: [] } }); // never terminal

    const executePromise = execute(
      makeCtx({ config: { timeoutSec: 1, graceSec: 0 } } as Partial<AdapterExecutionContext>),
    );
    // readPaperclipRuntimeSkillEntries is mocked (no real I/O).  Timer sequence:
    //   t=2000: poll sleep fires → Date.now()=2000 > deadline=1000 → timedOut=true → stopped=true
    //   t=3000: reconnect sleep fires → while(!stopped) → exits → allSettled resolves
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await executePromise;

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("timeout");
  });

  it("waits for pod creation (no-pod state) then succeeds when pod appears", async () => {
    // Override mockCoreListPods: first call returns empty (no pod yet),
    // second returns running, default returns terminated exit 0.
    mockCoreListPods.mockReset();
    mockCoreListPods
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({
        items: [{
          metadata: { name: "pod-abc" },
          status: { phase: "Running", containerStatuses: [], initContainerStatuses: [] },
        }],
      })
      .mockResolvedValue({
        items: [{
          metadata: { name: "pod-abc" },
          status: {
            containerStatuses: [{ name: "claude", state: { terminated: { exitCode: 0 } } }],
          },
        }],
      });

    const executePromise = execute(makeCtx());
    // Multiple advances provide event-loop turns for readPaperclipRuntimeSkillEntries
    // readPaperclipRuntimeSkillEntries is mocked (no real I/O).  Timer sequence:
    //   t=2000: waitForPod sleep fires → Running pod found → streaming starts
    //   waitForJobCompletion → Complete immediately → stopped=true (microtask)
    //   t=5000: reconnect sleep fires → while(!stopped) → exits → allSettled resolves
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await executePromise;

    expect(result.exitCode).toBe(0);
  });

  it("logs warning and continues when instructionsFilePath file does not exist", async () => {
    // The catch block in execute() logs a warning and proceeds with null instructions
    const executePromise = execute(
      makeCtx({ config: { instructionsFilePath: "/nonexistent/agent-instructions.md" } } as Partial<AdapterExecutionContext>),
    );
    await vi.advanceTimersByTimeAsync(3_100);
    const result = await executePromise;

    expect(result.exitCode).toBe(0);
  });

  it("logs warning for extra labels with reserved prefix (skippedLabels)", async () => {
    // Labels starting with "paperclip.io/" are reserved and get skipped
    const executePromise = execute(
      makeCtx({ config: { labels: { "paperclip.io/custom": "value" } } } as Partial<AdapterExecutionContext>),
    );
    await vi.advanceTimersByTimeAsync(3_100);
    const result = await executePromise;

    expect(result.exitCode).toBe(0);
  });

  it("logs pod pending → init-waiting → running transition and then succeeds", async () => {
    // First poll: pod is Pending with init and main containers in waiting state
    // Second poll: pod is Running → waitForPod returns
    mockCoreListPods.mockReset();
    mockCoreListPods
      .mockResolvedValueOnce({
        items: [{
          metadata: { name: "pod-abc" },
          status: {
            phase: "Pending",
            initContainerStatuses: [{ name: "write-prompt", state: { waiting: { reason: "PodInitializing" } } }],
            containerStatuses: [{ name: "claude", state: { waiting: { reason: "PodInitializing" } } }],
          },
        }],
      })
      .mockResolvedValueOnce({
        items: [{
          metadata: { name: "pod-abc" },
          status: { phase: "Running", containerStatuses: [], initContainerStatuses: [] },
        }],
      })
      .mockResolvedValue({
        items: [{
          metadata: { name: "pod-abc" },
          status: { containerStatuses: [{ name: "claude", state: { terminated: { exitCode: 0 } } }] },
        }],
      });

    const executePromise = execute(makeCtx());
    // Timer sequence:
    //   t+2000: waitForPod poll 1 (Pending → logs phase)
    //   t+4000: waitForPod poll 2 (Running → pod found, streaming starts)
    //   t+7000: streamPodLogs 3s reconnect sleep fires → while(!stopped) → exits
    // readPaperclipRuntimeSkillEntries is mocked (no real I/O), so fake timers
    // apply from the moment execute() is called.
    await vi.advanceTimersByTimeAsync(2_000); // t+2000: poll 1 fires
    await vi.advanceTimersByTimeAsync(2_000); // t+4000: poll 2 fires → pod found
    await vi.advanceTimersByTimeAsync(3_000); // t+7000: reconnect sleep fires → done
    const result = await executePromise;

    expect(result.exitCode).toBe(0);
  });

  it("returns running pod via allInitsDone && mainRunning even when phase=Pending", async () => {
    // Phase stays Pending, but init containers are done and main is running.
    // waitForPod returns immediately via the allInitsDone && mainRunning branch (no 2s delay).
    mockCoreListPods.mockReset();
    mockCoreListPods
      .mockResolvedValueOnce({
        items: [{
          metadata: { name: "pod-abc" },
          status: {
            phase: "Pending",
            initContainerStatuses: [{ name: "write-prompt", state: { terminated: { exitCode: 0 } } }],
            containerStatuses: [{ name: "claude", state: { running: { startedAt: "2024-01-01T00:00:00Z" } } }],
          },
        }],
      })
      .mockResolvedValue({
        items: [{
          metadata: { name: "pod-abc" },
          status: { containerStatuses: [{ name: "claude", state: { terminated: { exitCode: 0 } } }] },
        }],
      });

    const executePromise = execute(makeCtx());
    await vi.advanceTimersByTimeAsync(3_100);
    const result = await executePromise;

    expect(result.exitCode).toBe(0);
  });
});

// ─── execute: waitForPod edge cases ──────────────────────────────────────────

describe("execute: waitForPod edge cases", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockReadSkillEntries.mockResolvedValue([]);
    mockGetSelfPodInfo.mockResolvedValue(makeSelfPodResult());
    mockBatchListJobs.mockResolvedValue({ items: [] });
    mockPrepareBundle.mockResolvedValue(makeBundle());
    mockBatchCreateJob.mockResolvedValue({ metadata: { uid: "uid-1" } });
    mockBatchDeleteJob.mockResolvedValue({});
  });

  it("throws k8s_pod_schedule_failed when pod reaches phase=Failed immediately", async () => {
    mockCoreListPods.mockResolvedValue({
      items: [{
        metadata: { name: "pod-fail" },
        status: {
          phase: "Failed",
          containerStatuses: [{ name: "claude", state: { terminated: { exitCode: 137, reason: "OOMKilled" } } }],
          initContainerStatuses: [],
        },
      }],
    });

    const result = await execute(makeCtx());

    expect(result.errorCode).toBe("k8s_pod_schedule_failed");
    expect(result.errorMessage).toContain("OOMKilled");
  });

  it("throws k8s_pod_schedule_failed when init container exits non-zero", async () => {
    mockCoreListPods.mockResolvedValue({
      items: [{
        metadata: { name: "pod-x" },
        status: {
          phase: "Pending",
          initContainerStatuses: [{
            name: "write-prompt",
            state: { terminated: { exitCode: 1, reason: "Error" } },
          }],
          containerStatuses: [],
        },
      }],
    });

    const result = await execute(makeCtx());

    expect(result.errorCode).toBe("k8s_pod_schedule_failed");
    expect(result.errorMessage).toContain("write-prompt");
  });

  it("throws k8s_pod_schedule_failed when init container has ImagePullBackOff", async () => {
    mockCoreListPods.mockResolvedValue({
      items: [{
        metadata: { name: "pod-x" },
        status: {
          phase: "Pending",
          initContainerStatuses: [{
            name: "write-prompt",
            state: { waiting: { reason: "ImagePullBackOff", message: "pull failed" } },
          }],
          containerStatuses: [],
        },
      }],
    });

    const result = await execute(makeCtx());

    expect(result.errorCode).toBe("k8s_pod_schedule_failed");
    expect(result.errorMessage).toContain("image pull");
  });

  it("throws k8s_pod_schedule_failed when main container has CrashLoopBackOff", async () => {
    mockCoreListPods.mockResolvedValue({
      items: [{
        metadata: { name: "pod-x" },
        status: {
          phase: "Pending",
          initContainerStatuses: [],
          containerStatuses: [{
            name: "claude",
            state: { waiting: { reason: "CrashLoopBackOff" } },
          }],
        },
      }],
    });

    const result = await execute(makeCtx());

    expect(result.errorCode).toBe("k8s_pod_schedule_failed");
    expect(result.errorMessage).toContain("crash loop");
  });
});

// ─── execute: grace-period fallback (FAR-23) ─────────────────────────────────

describe("execute: log-stream-exit grace period (FAR-23)", () => {
  // Tests verify that execute() resolves within the grace window even when
  // waitForJobCompletion keeps polling after the log stream exits (K8s
  // condition propagation lag).
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    mockReadSkillEntries.mockResolvedValue([]);
    mockGetSelfPodInfo.mockResolvedValue(makeSelfPodResult());
    mockBatchListJobs.mockResolvedValue({ items: [] });
    mockPrepareBundle.mockResolvedValue(makeBundle());
    mockBatchCreateJob.mockResolvedValue({ metadata: { uid: "job-uid-1" } });
    mockBatchPatchJob.mockResolvedValue({});
    mockBatchDeleteJob.mockResolvedValue({});
    mockCoreDeleteSecret.mockResolvedValue({});
    mockCoreListPods
      .mockResolvedValueOnce({
        items: [{
          metadata: { name: "pod-abc" },
          status: { phase: "Running", containerStatuses: [], initContainerStatuses: [] },
        }],
      })
      .mockResolvedValue({
        items: [{
          metadata: { name: "pod-abc" },
          status: { containerStatuses: [{ name: "claude", state: { terminated: { exitCode: 0 } } }] },
        }],
      });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves via grace (jobGone) when log stream exits but job condition never arrives", async () => {
    // logApi.log returns immediately (container exited) — log stream exits on first attempt.
    mockLogFn.mockImplementation(async () => {});
    // One-shot read returns full Claude output (no reconnects needed for output)
    mockCoreReadPodLog.mockResolvedValue(CLAUDE_HAPPY_OUTPUT);
    // waitForJobCompletion never detects terminal — simulates K8s condition lag.
    mockBatchReadJob.mockResolvedValue({ status: { conditions: [] } }); // never terminal

    // No timeoutSec → completionTimeoutMs=0 → polls indefinitely without grace.
    const executePromise = execute(makeCtx());

    // readPaperclipRuntimeSkillEntries is mocked (no real I/O).  waitForPod
    // resolves immediately (Running pod on first poll).  Timer sequence:
    //   t=3000: first reconnect sleep → loop continues (stopSignal still false)
    //   t=30000: gracePoller fires → stopSignal.stopped = true
    //   t≤33000: current sleep fires → while(!stopped) → exit → trackedLogStream resolves
    await vi.advanceTimersByTimeAsync(3_100); // first reconnect sleep
    await vi.advanceTimersByTimeAsync(30_100); // grace fires at t=30000
    await vi.advanceTimersByTimeAsync(3_500); // remaining sleep + margin
    const result = await executePromise;

    // Grace fires → jobGone=true → execute proceeds with one-shot logs → success
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("sess_test123");
    expect(mockCoreReadPodLog).toHaveBeenCalled();
  }, 60_000);

  it("resolves promptly via real completion when job condition arrives before grace", async () => {
    // Log stream exits immediately then job condition arrives well within the grace period.
    mockLogFn.mockImplementation(
      async (_ns: string, _pod: string, _ctr: string, writable: import("node:stream").Writable) => {
        writable.write(CLAUDE_HAPPY_OUTPUT);
      },
    );
    // Job condition appears quickly (< 30s grace period)
    mockBatchReadJob.mockResolvedValue({
      status: { conditions: [{ type: "Complete", status: "True" }] },
    });

    const executePromise = execute(makeCtx());
    await vi.advanceTimersByTimeAsync(3_100);
    const result = await executePromise;

    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("sess_test123");
    // One-shot fallback should NOT be needed since the stream captured full output
    // (grace did not fire, real completion arrived)
    expect(result.errorMessage).toBeNull();
  });
});

// ─── execute: concurrency guard — multiple orphan sorting ────────────────────

describe("execute: concurrency guard — multiple orphans", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSelfPodInfo.mockResolvedValue(makeSelfPodResult());
  });

  it("sorts multiple orphans newest-first and processes them in that order", async () => {
    // orphanNew has a newer timestamp and a mismatching task → block_task_mismatch
    // orphanOld has an older timestamp and a matching task → would reattach
    // The sort (lines 603-605) must put orphanNew first so it is the one classified.
    const orphanOld = makeJob({ runId: "prior-1", agentId: "agent-abc", taskId: "task-match" });
    orphanOld.metadata!.creationTimestamp = new Date("2024-01-01T00:00:00Z") as unknown as Date;
    const orphanNew = makeJob({ runId: "prior-2", agentId: "agent-abc", taskId: "task-other" });
    orphanNew.metadata!.creationTimestamp = new Date("2024-01-02T00:00:00Z") as unknown as Date;

    mockBatchListJobs.mockResolvedValue({ items: [orphanOld, orphanNew] });
    const result = await execute(
      makeCtx({ context: { taskId: "task-match" } } as Partial<AdapterExecutionContext>),
    );

    // Newest orphan (task-other) is classified first → block_task_mismatch
    expect(result.errorCode).toBe("k8s_concurrent_run_blocked");
    expect(result.errorMessage).toContain("different task");
  });
});

// ─── shouldAbortForCancellation ──────────────────────────────────────────────

describe("shouldAbortForCancellation", () => {
  it("returns false for undefined", () => {
    expect(shouldAbortForCancellation(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(shouldAbortForCancellation("")).toBe(false);
  });

  it("returns false when status is 'running'", () => {
    expect(shouldAbortForCancellation("running")).toBe(false);
  });

  it("returns true when status is 'cancelled'", () => {
    expect(shouldAbortForCancellation("cancelled")).toBe(true);
  });

  it("returns true when status is 'failed'", () => {
    expect(shouldAbortForCancellation("failed")).toBe(true);
  });

  it("returns true when status is 'completed'", () => {
    expect(shouldAbortForCancellation("completed")).toBe(true);
  });

  it("returns true for any non-running non-empty string", () => {
    expect(shouldAbortForCancellation("unknown")).toBe(true);
  });
});

// ─── execute: cancel-polling path ────────────────────────────────────────────

describe("execute: cancel-polling via keepalive tick", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    // Replace global fetch for this suite
    vi.stubGlobal("fetch", mockFetch);
    process.env.PAPERCLIP_API_URL = "http://paperclip-test.local";

    mockReadSkillEntries.mockResolvedValue([]);
    mockGetSelfPodInfo.mockResolvedValue(makeSelfPodResult());
    mockBatchListJobs.mockResolvedValue({ items: [] });
    mockPrepareBundle.mockResolvedValue(makeBundle());
    mockBatchCreateJob.mockResolvedValue({ metadata: { uid: "job-uid-1" } });
    mockBatchPatchJob.mockResolvedValue({});
    mockBatchDeleteJob.mockResolvedValue({});
    mockCoreDeleteSecret.mockResolvedValue({});

    mockCoreListPods
      .mockResolvedValueOnce({
        items: [{
          metadata: { name: "pod-abc" },
          status: { phase: "Running", containerStatuses: [], initContainerStatuses: [] },
        }],
      })
      .mockResolvedValue({
        items: [{
          metadata: { name: "pod-abc" },
          status: { containerStatuses: [{ name: "claude", state: { terminated: { exitCode: 0 } } }] },
        }],
      });

    // Job never reaches terminal on its own (cancel kicks in first)
    mockBatchReadJob.mockResolvedValue({ status: { conditions: [] } });

    // Log stream never ends (hung — simulates long-running Claude)
    mockLogFn.mockImplementation(() => new Promise(() => { /* never resolves */ }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env.PAPERCLIP_API_URL;
  });

  it("returns errorCode=cancelled when poll detects non-running status within one keepalive tick", async () => {
    // Use a flag so readJob throws 404 only AFTER deleteJob is called (simulating
    // K8s state where the job disappears after deletion).
    let jobDeleted = false;
    mockBatchDeleteJob.mockImplementation(async () => { jobDeleted = true; return {}; });
    mockBatchReadJob.mockImplementation(async () => {
      if (jobDeleted) {
        throw Object.assign(new Error("Not Found"), { response: { statusCode: 404 } });
      }
      return { status: { conditions: [] } };
    });

    // Cancel poll returns "cancelled" status.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: "cancelled" }),
    });

    const executePromise = execute(
      makeCtx({ authToken: "tok-abc" } as Partial<AdapterExecutionContext>),
    );

    // Timer sequence:
    //   t=15100: keepalive fires → pre-check non-terminal → fetch → cancelled →
    //            deleteJob (jobDeleted=true) → stop signal set
    //   t=15300: stop poller fires (200ms) → destroys writable → starts 3s bail timer
    //   t=17100: completion watcher polls → 404 (jobDeleted=true) → jobGone → settles
    //   t=18300: bail timer fires → streamPodLogsOnce returns → streamPodLogs exits →
    //            trackedLogStream settles → Promise.allSettled resolves
    await vi.advanceTimersByTimeAsync(15_100); // keepalive fires → cancel detected
    await vi.advanceTimersByTimeAsync(2_100);  // completion watcher polls → 404 → settles
    await vi.advanceTimersByTimeAsync(3_100);  // bail timer fires → log stream settles

    const result = await executePromise;

    expect(result.errorCode).toBe("cancelled");
    expect(result.errorMessage).toBe("Run cancelled");
    expect(result.timedOut).toBe(false);
    expect(mockBatchDeleteJob).toHaveBeenCalled();
  });

  it("treats HTTP 500 on cancel poll as transient and does not cancel", async () => {
    // Cancel poll returns 500 → transient, should not cancel.
    // After a while the job completes normally.
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    // Override: job completes after keepalive tick fires
    mockBatchReadJob
      .mockResolvedValueOnce({ status: { conditions: [] } }) // first keepalive check: non-terminal
      .mockResolvedValue({ status: { conditions: [{ type: "Complete", status: "True" }] } });
    mockLogFn.mockImplementation(
      async (_ns: string, _pod: string, _ctr: string, writable: import("node:stream").Writable) => {
        writable.write(CLAUDE_HAPPY_OUTPUT);
      },
    );

    const executePromise = execute(
      makeCtx({ authToken: "tok-abc" } as Partial<AdapterExecutionContext>),
    );

    await vi.advanceTimersByTimeAsync(15_100); // keepalive fires: 500 → transient, no cancel
    await vi.advanceTimersByTimeAsync(3_100);  // log reconnect sleep → stopSignal already true

    const result = await executePromise;

    expect(result.errorCode).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("sess_test123");
  });

  it("skips cancel poll when authToken is absent", async () => {
    // No authToken → cancel poll must not be attempted → job completes normally
    mockBatchReadJob.mockResolvedValue({
      status: { conditions: [{ type: "Complete", status: "True" }] },
    });
    mockLogFn.mockImplementation(
      async (_ns: string, _pod: string, _ctr: string, writable: import("node:stream").Writable) => {
        writable.write(CLAUDE_HAPPY_OUTPUT);
      },
    );

    const executePromise = execute(makeCtx()); // no authToken

    await vi.advanceTimersByTimeAsync(3_100);
    const result = await executePromise;

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
  });

  it("skips cancel poll when PAPERCLIP_API_URL is not set", async () => {
    delete process.env.PAPERCLIP_API_URL;

    mockBatchReadJob.mockResolvedValue({
      status: { conditions: [{ type: "Complete", status: "True" }] },
    });
    mockLogFn.mockImplementation(
      async (_ns: string, _pod: string, _ctr: string, writable: import("node:stream").Writable) => {
        writable.write(CLAUDE_HAPPY_OUTPUT);
      },
    );

    const executePromise = execute(
      makeCtx({ authToken: "tok-abc" } as Partial<AdapterExecutionContext>),
    );

    await vi.advanceTimersByTimeAsync(3_100);
    const result = await executePromise;

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
  });
});

// ─── execute: SIGTERM handler ─────────────────────────────────────────────────

describe("execute: SIGTERM handler best-effort cleanup", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    mockReadSkillEntries.mockResolvedValue([]);
    mockGetSelfPodInfo.mockResolvedValue(makeSelfPodResult());
    mockBatchListJobs.mockResolvedValue({ items: [] });
    mockPrepareBundle.mockResolvedValue(makeBundle());
    mockBatchCreateJob.mockResolvedValue({ metadata: { uid: "job-uid-1" } });
    mockBatchPatchJob.mockResolvedValue({});
    mockBatchDeleteJob.mockResolvedValue({});
    mockCoreDeleteSecret.mockResolvedValue({});
    mockCoreListPods
      .mockResolvedValueOnce({
        items: [{
          metadata: { name: "pod-abc" },
          status: { phase: "Running", containerStatuses: [], initContainerStatuses: [] },
        }],
      })
      .mockResolvedValue({
        items: [{
          metadata: { name: "pod-abc" },
          status: { containerStatuses: [{ name: "claude", state: { terminated: { exitCode: 0 } } }] },
        }],
      });
    mockBatchReadJob.mockResolvedValue({ status: { conditions: [] } });
    mockLogFn.mockImplementation(() => new Promise(() => { /* never resolves */ }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("deletes the active Job when SIGTERM fires during execution", async () => {
    // Mock process.kill to prevent the test process from actually being killed.
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    // Start execute() and suppress unhandled rejection (we won't await it).
    const executePromise = execute(makeCtx());
    executePromise.catch(() => {});

    // Flush microtasks through the async setup chain: getSelfPodInfo, listJobs,
    // readSkillEntries, prepareBundle, createJob, onLog, activeJobs.add(), and
    // ensureSigtermHandler() all complete before the try block enters streaming.
    // 30 rounds is more than enough for the ~7 sequential await points.
    for (let i = 0; i < 30; i++) await Promise.resolve();

    // Emit SIGTERM — the process.once handler fires synchronously and kicks off
    // async cleanup (deleteNamespacedJob). The mock resolves immediately.
    process.emit("SIGTERM");

    // Flush microtasks for deleteJob to resolve and the .then(process.kill) to run.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(mockBatchDeleteJob).toHaveBeenCalled();
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGTERM");

    killSpy.mockRestore();
    // afterEach calls vi.useRealTimers() which clears all pending fake timers,
    // so we do not need to settle executePromise.
  });
});
