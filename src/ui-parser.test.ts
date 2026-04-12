import { describe, it, expect } from "vitest";
import { parseStdoutLine } from "./ui-parser.js";

const ts = "2026-04-12T00:00:00.000Z";

function parse(line: string) {
  return parseStdoutLine(line, ts);
}

describe("parseStdoutLine", () => {
  it("returns stdout entry for non-JSON input", () => {
    const entries = parse("hello world");
    expect(entries).toEqual([{ kind: "stdout", ts, text: "hello world" }]);
  });

  it("returns stdout entry for null parse result", () => {
    const entries = parse("  ");
    expect(entries[0]?.kind).toBe("stdout");
  });

  describe("system/init", () => {
    it("parses init event", () => {
      const entries = parse(JSON.stringify({
        type: "system",
        subtype: "init",
        model: "claude-opus-4-6",
        session_id: "sess_abc",
      }));
      expect(entries).toEqual([{
        kind: "init",
        ts,
        model: "claude-opus-4-6",
        sessionId: "sess_abc",
      }]);
    });

    it("handles missing model with default", () => {
      const entries = parse(JSON.stringify({ type: "system", subtype: "init" }));
      expect(entries[0]).toMatchObject({ kind: "init", model: "unknown" });
    });
  });

  describe("assistant messages", () => {
    it("parses text block", () => {
      const entries = parse(JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello there" }] },
      }));
      expect(entries).toEqual([{ kind: "assistant", ts, text: "Hello there" }]);
    });

    it("skips empty text blocks", () => {
      const entries = parse(JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "" }] },
      }));
      // Empty content arrays fall back to stdout
      expect(entries[0]?.kind).toBe("stdout");
    });

    it("parses thinking block", () => {
      const entries = parse(JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "thinking", thinking: "Let me think about this" }] },
      }));
      expect(entries).toEqual([{ kind: "thinking", ts, text: "Let me think about this" }]);
    });

    it("skips empty thinking blocks", () => {
      const entries = parse(JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "thinking", thinking: "" }] },
      }));
      // Empty content arrays fall back to stdout
      expect(entries[0]?.kind).toBe("stdout");
    });

    it("parses tool_use block", () => {
      const entries = parse(JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            name: "Bash",
            input: { command: "ls -la" },
            id: "tool_123",
          }],
        },
      }));
      expect(entries).toEqual([{
        kind: "tool_call",
        ts,
        name: "Bash",
        input: { command: "ls -la" },
        toolUseId: "tool_123",
      }]);
    });

    it("parses tool_use with tool_use_id fallback", () => {
      const entries = parse(JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            name: "Bash",
            tool_use_id: "tool_fallback",
            input: {},
          }],
        },
      }));
      const entry = entries[0] as { kind: string; toolUseId?: string };
      expect(entry.kind).toBe("tool_call");
      expect(entry.toolUseId).toBe("tool_fallback");
    });

    it("returns stdout as fallback for empty content", () => {
      const entries = parse(JSON.stringify({
        type: "assistant",
        message: { content: [] },
      }));
      expect(entries[0]?.kind).toBe("stdout");
    });
  });

  describe("user messages", () => {
    it("parses user text block", () => {
      const entries = parse(JSON.stringify({
        type: "user",
        message: { content: [{ type: "text", text: "Hello Claude" }] },
      }));
      expect(entries).toEqual([{ kind: "user", ts, text: "Hello Claude" }]);
    });

    it("parses tool_result block", () => {
      const entries = parse(JSON.stringify({
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "tool_123",
            content: "file1.txt\nfile2.txt",
          }],
        },
      }));
      expect(entries).toEqual([{
        kind: "tool_result",
        ts,
        toolUseId: "tool_123",
        content: "file1.txt\nfile2.txt",
        isError: false,
      }]);
    });

    it("marks tool_result as error when is_error is true", () => {
      const entries = parse(JSON.stringify({
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "tool_123",
            is_error: true,
            content: "Permission denied",
          }],
        },
      }));
      expect(entries[0]).toMatchObject({ kind: "tool_result", isError: true });
    });

    it("handles text content array parts", () => {
      const entries = parse(JSON.stringify({
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "tool_123",
            content: [{ type: "text", text: "part1" }, { type: "text", text: "part2" }],
          }],
        },
      }));
      const entry = entries[0] as { kind: string; content: string };
      expect(entry.kind).toBe("tool_result");
      expect(entry.content).toBe("part1\npart2");
    });
  });

  describe("result", () => {
    it("parses result with usage and cost", () => {
      const entries = parse(JSON.stringify({
        type: "result",
        result: "Task completed successfully",
        subtype: "stop",
        total_cost_usd: 0.0125,
        usage: {
          input_tokens: 500,
          output_tokens: 300,
          cache_read_input_tokens: 200,
        },
      }));
      expect(entries[0]).toMatchObject({
        kind: "result",
        ts,
        text: "Task completed successfully",
        subtype: "stop",
        costUsd: 0.0125,
        inputTokens: 500,
        outputTokens: 300,
        cachedTokens: 200,
        isError: false,
        errors: [],
      });
    });

    it("marks result as error when is_error is true", () => {
      const entries = parse(JSON.stringify({
        type: "result",
        is_error: true,
        errors: ["Something went wrong"],
      }));
      const entry = entries[0] as { kind: string; isError: boolean };
      expect(entry.kind).toBe("result");
      expect(entry.isError).toBe(true);
    });

    it("extracts errors array", () => {
      const entries = parse(JSON.stringify({
        type: "result",
        errors: ["error one", "error two"],
      }));
      const entry = entries[0] as { kind: string; errors: string[] };
      expect(entry.kind).toBe("result");
      expect(entry.errors).toEqual(["error one", "error two"]);
    });

    it("handles non-string errors", () => {
      const entries = parse(JSON.stringify({
        type: "result",
        errors: [{ message: "obj error" }],
      }));
      const entry = entries[0] as { kind: string; errors: string[] };
      expect(entry.kind).toBe("result");
      expect(entry.errors).toContain("obj error");
    });
  });

  describe("stderr and system", () => {
    it("passes through unknown types as stdout", () => {
      const entries = parse(JSON.stringify({ type: "unknown", data: "stuff" }));
      expect(entries[0]?.kind).toBe("stdout");
    });
  });
});
