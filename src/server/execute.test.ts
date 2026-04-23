import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as k8s from "@kubernetes/client-node";
import type { Writable } from "node:stream";

// Mock the K8s client before importing execute so streamPodLogsOnce picks up
// the mocked getLogApi.  The mock's logApi.log never resolves, simulating the
// FAR-10 hang: K8s API drops the connection but the client awaits forever.
const mockLogFn = vi.fn();
vi.mock("./k8s-client.js", () => ({
  getLogApi: () => ({ log: mockLogFn }),
  getBatchApi: () => ({}),
  getCoreApi: () => ({}),
  getAuthzApi: () => ({}),
  getSelfPodInfo: vi.fn(),
  resetCache: vi.fn(),
}));

const { isK8s404, buildPartialRunError, classifyOrphan, describePodTerminatedError, streamPodLogsOnce } = await import("./execute.js");

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

  it("uses first non-system JSON event as content", () => {
    const resultLike = JSON.stringify({ type: "result", subtype: "error", result: "rate limit" });
    const stdout = [initLine, resultLike].join("\n");
    const msg = buildPartialRunError(2, "claude-sonnet-4-6", stdout);
    expect(msg).toContain("rate limit");
    expect(msg).toContain("code 2");
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
