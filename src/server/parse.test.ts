import { describe, it, expect } from "vitest";
import {
  parseClaudeStreamJson,
  extractClaudeLoginUrl,
  detectClaudeLoginRequired,
  describeClaudeFailure,
  isClaudeMaxTurnsResult,
  isClaudeUnknownSessionError,
} from "./parse.js";

describe("parseClaudeStreamJson", () => {
  it("returns empty result for blank input", () => {
    const result = parseClaudeStreamJson("");
    expect(result.sessionId).toBeNull();
    expect(result.model).toBe("");
    expect(result.costUsd).toBeNull();
    expect(result.usage).toBeNull();
    expect(result.summary).toBe("");
    expect(result.resultJson).toBeNull();
  });

  it("returns empty result for non-JSON lines", () => {
    const result = parseClaudeStreamJson("hello world\nnot json\n");
    expect(result.summary).toBe("");
    expect(result.resultJson).toBeNull();
  });

  it("parses system/init event for sessionId and model", () => {
    const stdout = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "sess_abc123",
      model: "claude-opus-4-6",
    });
    const result = parseClaudeStreamJson(stdout);
    expect(result.sessionId).toBe("sess_abc123");
    expect(result.model).toBe("claude-opus-4-6");
  });

  it("parses assistant text blocks", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        session_id: "sess_abc",
        message: { content: [{ type: "text", text: "Hello" }] },
      }),
      JSON.stringify({
        type: "assistant",
        session_id: "sess_abc",
        message: { content: [{ type: "text", text: " world" }] },
      }),
    ].join("\n");
    const result = parseClaudeStreamJson(lines);
    expect(result.summary).toBe("Hello\n\n world");
  });

  it("parses thinking blocks", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "thinking", thinking: "Let me think..." }] },
      }),
    ].join("\n");
    const result = parseClaudeStreamJson(lines);
    // thinking is not included in summary
    expect(result.summary).toBe("");
  });

  it("parses tool_use blocks without crashing", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            name: "Bash",
            input: { command: "ls" },
            id: "tool_123",
          }],
        },
      }),
    ].join("\n");
    const result = parseClaudeStreamJson(lines);
    expect(result.resultJson).toBeNull(); // no result event yet
  });

  it("parses result event with usage and cost", () => {
    const lines = [
      JSON.stringify({
        type: "result",
        session_id: "sess_abc",
        result: "Done",
        subtype: "stop",
        total_cost_usd: 0.005,
        usage: {
          input_tokens: 100,
          output_tokens: 200,
          cache_read_input_tokens: 50,
        },
      }),
    ].join("\n");
    const result = parseClaudeStreamJson(lines);
    expect(result.sessionId).toBe("sess_abc");
    expect(result.costUsd).toBe(0.005);
    expect(result.resultJson).not.toBeNull();
    expect(result.usage?.inputTokens).toBe(100);
    expect(result.usage?.outputTokens).toBe(200);
    expect(result.usage?.cachedInputTokens).toBe(50);
  });

  it("returns null cost for non-finite total_cost_usd", () => {
    const lines = [
      JSON.stringify({
        type: "result",
        total_cost_usd: Infinity,
        result: "Done",
      }),
    ].join("\n");
    const result = parseClaudeStreamJson(lines);
    expect(result.costUsd).toBeNull();
  });

  it("falls back to assistant texts when no result event", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Some output" }] },
      }),
    ].join("\n");
    const result = parseClaudeStreamJson(lines);
    expect(result.summary).toBe("Some output");
    expect(result.resultJson).toBeNull();
  });

  it("handles mixed JSON and non-JSON lines", () => {
    const lines = `some raw output
${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "JSON output" }] } })}
more raw output`;
    const result = parseClaudeStreamJson(lines);
    // Non-JSON lines don't contribute to summary; only parsed JSON content does
    expect(result.summary).toContain("JSON output");
    expect(result.summary).not.toContain("some raw output");
  });

  it("deduplicates identical assistant text blocks from reconnect replays", () => {
    const assistantEvent = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello world" }] },
    });
    // Simulate the same assistant event appearing twice (log stream reconnect replay)
    const stdout = `${assistantEvent}\n${assistantEvent}\n`;
    const result = parseClaudeStreamJson(stdout);
    expect(result.summary).toBe("Hello world");
    // Should not be "Hello world\n\nHello world"
    expect(result.summary.split("Hello world").length).toBe(2);
  });

  it("sets llmApiEmptyResponse=true when stop_reason:null and usage.output_tokens:0", () => {
    const initLine = JSON.stringify({ type: "system", subtype: "init", model: "MiniMax-M2.7", session_id: "sess_1" });
    const assistantEvent = JSON.stringify({
      type: "assistant",
      session_id: "sess_1",
      message: {
        id: "msg_abc",
        stop_reason: null,
        usage: { input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        content: [],
      },
    });
    const result = parseClaudeStreamJson([initLine, assistantEvent].join("\n"));
    expect(result.llmApiEmptyResponse).toBe(true);
    expect(result.resultJson).toBeNull();
  });

  it("sets llmApiEmptyResponse=true when stop_reason:null and message-level output_tokens:0", () => {
    const assistantEvent = JSON.stringify({
      type: "assistant",
      message: { stop_reason: null, output_tokens: 0, content: [] },
    });
    const result = parseClaudeStreamJson(assistantEvent);
    expect(result.llmApiEmptyResponse).toBe(true);
  });

  it("does not set llmApiEmptyResponse when stop_reason is non-null", () => {
    const assistantEvent = JSON.stringify({
      type: "assistant",
      message: {
        stop_reason: "end_turn",
        usage: { output_tokens: 0 },
        content: [],
      },
    });
    const result = parseClaudeStreamJson(assistantEvent);
    expect(result.llmApiEmptyResponse).toBe(false);
  });

  it("does not set llmApiEmptyResponse when output_tokens > 0", () => {
    const assistantEvent = JSON.stringify({
      type: "assistant",
      message: {
        stop_reason: null,
        usage: { output_tokens: 5 },
        content: [{ type: "text", text: "hello" }],
      },
    });
    const result = parseClaudeStreamJson(assistantEvent);
    expect(result.llmApiEmptyResponse).toBe(false);
  });

  it("clears llmApiEmptyResponse when a result event follows the empty assistant event", () => {
    const assistantEvent = JSON.stringify({
      type: "assistant",
      message: { stop_reason: null, usage: { output_tokens: 0 }, content: [] },
    });
    const resultEvent = JSON.stringify({
      type: "result",
      result: "Done",
      subtype: "stop",
      total_cost_usd: 0.001,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
    });
    const result = parseClaudeStreamJson([assistantEvent, resultEvent].join("\n"));
    expect(result.llmApiEmptyResponse).toBe(false);
    expect(result.resultJson).not.toBeNull();
  });

  it("sets llmApiEmptyResponse=false for normal result", () => {
    const resultEvent = JSON.stringify({
      type: "result",
      result: "Done",
      subtype: "stop",
      total_cost_usd: 0.005,
      usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 50 },
    });
    const result = parseClaudeStreamJson(resultEvent);
    expect(result.llmApiEmptyResponse).toBe(false);
  });
});

describe("extractClaudeLoginUrl", () => {
  it("returns null for no URL in text", () => {
    expect(extractClaudeLoginUrl("not a url")).toBeNull();
  });

  it("extracts and cleans URLs with trailing punctuation", () => {
    expect(extractClaudeLoginUrl("Visit https://auth.anthropic.com/ for login!")).toBe("https://auth.anthropic.com/");
  });

  it("returns first URL when no anthropic/claude keywords", () => {
    expect(extractClaudeLoginUrl("Go to https://example.com/page")).toBe("https://example.com/page");
  });

  it("filters by claude/anthropic/auth keywords", () => {
    const text = "See https://example.com and https://auth.anthropic.com/login";
    expect(extractClaudeLoginUrl(text)).toBe("https://auth.anthropic.com/login");
  });

  it("returns null when no URL matches filter", () => {
    expect(extractClaudeLoginUrl("Visit https://example.com only")).toBe("https://example.com");
  });
});

describe("detectClaudeLoginRequired", () => {
  const loginPhrases = [
    "Please log in",
    "not logged in",
    "please run `claude login`",
    "login required",
    "unauthorized",
    "authentication required",
  ];

  it("returns requiresLogin false when no auth phrases", () => {
    const result = detectClaudeLoginRequired({
      parsed: { result: "All good" },
      stdout: "",
      stderr: "",
    });
    expect(result.requiresLogin).toBe(false);
    expect(result.loginUrl).toBeNull();
  });

  it("detects login required from result text", () => {
    const result = detectClaudeLoginRequired({
      parsed: { result: "Please log in to continue" },
      stdout: "",
      stderr: "",
    });
    expect(result.requiresLogin).toBe(true);
  });

  it("detects login required from error array", () => {
    const result = detectClaudeLoginRequired({
      parsed: { errors: ["not logged in", "please log in"] },
      stdout: "",
      stderr: "",
    });
    expect(result.requiresLogin).toBe(true);
  });

  it("extracts login URL from stdout", () => {
    const result = detectClaudeLoginRequired({
      parsed: {},
      stdout: "Visit https://auth.anthropic.com to login",
      stderr: "",
    });
    expect(result.requiresLogin).toBe(false);
    expect(result.loginUrl).toBe("https://auth.anthropic.com");
  });

  it("extracts login URL from stderr", () => {
    const result = detectClaudeLoginRequired({
      parsed: {},
      stdout: "",
      stderr: "Error. See https://auth.anthropic.com/setup",
    });
    expect(result.requiresLogin).toBe(false);
    expect(result.loginUrl).toBe("https://auth.anthropic.com/setup");
  });

  it("detects requiresLogin with URL extraction combined", () => {
    const result = detectClaudeLoginRequired({
      parsed: { result: "please log in" },
      stdout: "Visit https://auth.anthropic.com/",
      stderr: "",
    });
    expect(result.requiresLogin).toBe(true);
    expect(result.loginUrl).toBe("https://auth.anthropic.com/");
  });
});

describe("describeClaudeFailure", () => {
  it("returns null when no failure info", () => {
    expect(describeClaudeFailure({})).toBeNull();
  });

  it("returns null when result is empty", () => {
    expect(describeClaudeFailure({ result: "  " })).toBeNull();
  });

  it("formats with subtype and result", () => {
    const result = describeClaudeFailure({ subtype: "error_rate_limit", result: "Too many requests" });
    expect(result).toBe("Claude run failed: subtype=error_rate_limit: Too many requests");
  });

  it("falls back to first error message", () => {
    const result = describeClaudeFailure({
      subtype: "",
      result: "",
      errors: ["something went wrong"],
    });
    expect(result).toBe("Claude run failed: something went wrong");
  });
});

describe("isClaudeMaxTurnsResult", () => {
  it("returns false for null/undefined", () => {
    expect(isClaudeMaxTurnsResult(null)).toBe(false);
    expect(isClaudeMaxTurnsResult(undefined)).toBe(false);
  });

  it("detects error_max_turns subtype", () => {
    expect(isClaudeMaxTurnsResult({ subtype: "error_max_turns" })).toBe(true);
  });

  it("detects max_turns stop_reason", () => {
    expect(isClaudeMaxTurnsResult({ stop_reason: "max_turns" })).toBe(true);
  });

  it("detects max turns in result text", () => {
    expect(isClaudeMaxTurnsResult({ result: "Reached maximum turns" })).toBe(true);
    expect(isClaudeMaxTurnsResult({ result: "Maximum turns exceeded" })).toBe(true);
    expect(isClaudeMaxTurnsResult({ result: "result is ready" })).toBe(false);
  });

  it("is case insensitive", () => {
    expect(isClaudeMaxTurnsResult({ result: "MAXIMUM TURNS" })).toBe(true);
    expect(isClaudeMaxTurnsResult({ subtype: "Error_Max_Turns" })).toBe(true);
  });
});

describe("isClaudeUnknownSessionError", () => {
  it("detects 'no conversation found with session id'", () => {
    expect(isClaudeUnknownSessionError({ result: "no conversation found with session id abc" })).toBe(true);
  });

  it("detects 'unknown session'", () => {
    expect(isClaudeUnknownSessionError({ result: "unknown session: sess_123" })).toBe(true);
  });

  it("detects 'session not found'", () => {
    expect(isClaudeUnknownSessionError({ result: "session sess_xyz not found" })).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isClaudeUnknownSessionError({ result: "something went wrong" })).toBe(false);
  });

  it("checks error array messages", () => {
    expect(isClaudeUnknownSessionError({ errors: ["session abc not found"] })).toBe(true);
  });
});
