import { describe, it, expect, vi, beforeEach } from "vitest";
import { printClaudeStreamEvent } from "./format-event.js";

// Mock console methods to capture output
const consoleMock = {
  log: vi.fn(),
};

vi.stubGlobal("console", {
  ...console,
  log: consoleMock.log,
});

beforeEach(() => {
  consoleMock.log.mockClear();
});

function output() {
  return consoleMock.log.mock.calls.map((c) => c[0]).join("\n");
}

describe("printClaudeStreamEvent", () => {
  it("prints raw line if not JSON", () => {
    printClaudeStreamEvent("hello world", false);
    expect(output()).toBe("hello world");
  });

  it("skips empty lines", () => {
    printClaudeStreamEvent("  ", false);
    expect(output()).toBe("");
  });

  it("prints init event with model and session", () => {
    printClaudeStreamEvent(JSON.stringify({
      type: "system",
      subtype: "init",
      model: "claude-opus-4-6",
      session_id: "sess_abc123",
    }), false);
    expect(output()).toContain("Claude initialized");
    expect(output()).toContain("claude-opus-4-6");
    expect(output()).toContain("sess_abc123");
  });

  it("prints assistant text block", () => {
    printClaudeStreamEvent(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello world" }] },
    }), false);
    expect(output()).toContain("assistant: Hello world");
  });

  it("prints thinking block", () => {
    printClaudeStreamEvent(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "Let me think..." }] },
    }), false);
    expect(output()).toContain("thinking: Let me think...");
  });

  it("prints tool_use block with name and input", () => {
    printClaudeStreamEvent(JSON.stringify({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          name: "Bash",
          input: { command: "ls -la" },
        }],
      },
    }), false);
    expect(output()).toContain("tool_call: Bash");
    expect(output()).toContain("ls -la");
  });

  it("prints tool_result for user message", () => {
    printClaudeStreamEvent(JSON.stringify({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "tool_1",
          content: "file1.txt\nfile2.txt",
        }],
      },
    }), false);
    expect(output()).toContain("tool_result");
  });

  it("marks tool_result as error when is_error is true", () => {
    printClaudeStreamEvent(JSON.stringify({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "tool_1",
          is_error: true,
          content: "Permission denied",
        }],
      },
    }), false);
    expect(output()).toContain("tool_result (error)");
  });

  it("prints result with tokens and cost", () => {
    printClaudeStreamEvent(JSON.stringify({
      type: "result",
      result: "Done",
      subtype: "stop",
      total_cost_usd: 0.005,
      usage: {
        input_tokens: 100,
        output_tokens: 200,
        cache_read_input_tokens: 50,
      },
    }), false);
    expect(output()).toContain("tokens:");
    expect(output()).toContain("in=100");
    expect(output()).toContain("out=200");
    expect(output()).toContain("cached=50");
    expect(output()).toContain("cost=");
  });

  it("prints error subtype in result", () => {
    printClaudeStreamEvent(JSON.stringify({
      type: "result",
      subtype: "error_rate_limit",
      is_error: true,
      errors: ["rate limited"],
    }), false);
    expect(output()).toContain("claude_result");
    expect(output()).toContain("error_rate_limit");
    expect(output()).toContain("rate limited");
  });

  it("prints non-JSON lines directly", () => {
    printClaudeStreamEvent("some output text", false);
    expect(output()).toBe("some output text");
  });

  it("does not print unknown types in non-debug mode", () => {
    printClaudeStreamEvent(JSON.stringify({ type: "unknown", data: "stuff" }), false);
    expect(output()).toBe("");
  });

  it("prints unknown types in debug mode", () => {
    printClaudeStreamEvent(JSON.stringify({ type: "unknown", data: "stuff" }), true);
    expect(output()).toContain("stuff");
  });
});
