import { describe, it, expect } from "vitest";
import type * as k8s from "@kubernetes/client-node";
import { isK8s404, buildPartialRunError, isReattachableOrphan, describePodTerminatedError } from "./execute.js";

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

describe("isReattachableOrphan", () => {
  const agentId = "agent-abc";
  const taskId = "task-xyz";
  const sessionId = "sess-123";

  it("returns true when agent/task/session all match and Job is not terminal", () => {
    const job = makeJob({ agentId, taskId, sessionId, runId: "old-run" });
    expect(isReattachableOrphan(job, { agentId, taskId, sessionId })).toBe(true);
  });

  it("returns false when the Job is already Complete", () => {
    const job = makeJob({ agentId, taskId, sessionId, runId: "old-run", terminal: true });
    expect(isReattachableOrphan(job, { agentId, taskId, sessionId })).toBe(false);
  });

  it("returns false when expected taskId is null (caller couldn't derive one)", () => {
    const job = makeJob({ agentId, taskId, sessionId });
    expect(isReattachableOrphan(job, { agentId, taskId: null, sessionId })).toBe(false);
  });

  it("returns false when expected sessionId is null", () => {
    const job = makeJob({ agentId, taskId, sessionId });
    expect(isReattachableOrphan(job, { agentId, taskId, sessionId: null })).toBe(false);
  });

  it("returns false when agent id doesn't match", () => {
    const job = makeJob({ agentId: "agent-other", taskId, sessionId });
    expect(isReattachableOrphan(job, { agentId, taskId, sessionId })).toBe(false);
  });

  it("returns false when task id doesn't match", () => {
    const job = makeJob({ agentId, taskId: "task-other", sessionId });
    expect(isReattachableOrphan(job, { agentId, taskId, sessionId })).toBe(false);
  });

  it("returns false when session id doesn't match", () => {
    const job = makeJob({ agentId, taskId, sessionId: "sess-other" });
    expect(isReattachableOrphan(job, { agentId, taskId, sessionId })).toBe(false);
  });

  it("returns false when the Job is from a different adapter type", () => {
    const job = makeJob({ agentId, taskId, sessionId, adapterType: "claude_local" });
    expect(isReattachableOrphan(job, { agentId, taskId, sessionId })).toBe(false);
  });

  it("returns false when Job has no task-id label (labels were introduced in FAR-124)", () => {
    const job = makeJob({ agentId, sessionId });
    expect(isReattachableOrphan(job, { agentId, taskId, sessionId })).toBe(false);
  });

  it("returns false when Job has no session-id label", () => {
    const job = makeJob({ agentId, taskId });
    expect(isReattachableOrphan(job, { agentId, taskId, sessionId })).toBe(false);
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
