import { describe, it, expect } from "vitest";
import { LogLineDedupFilter, eventDedupKey } from "./log-dedup.js";

function assistantEvent(id: string, text: string): string {
  return JSON.stringify({
    type: "assistant",
    session_id: "sess_1",
    message: {
      id,
      content: [{ type: "text", text }],
    },
  });
}

function userToolResultEvent(toolUseId: string, content: string): string {
  return JSON.stringify({
    type: "user",
    session_id: "sess_1",
    message: {
      content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
    },
  });
}

function systemInitEvent(sessionId: string): string {
  return JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model: "claude-opus-4-7",
  });
}

function resultEvent(sessionId: string): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: sessionId,
    result: "done",
    total_cost_usd: 0.01,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
  });
}

describe("eventDedupKey", () => {
  it("keys assistant events by message.id", () => {
    const key = eventDedupKey(JSON.parse(assistantEvent("msg_abc", "hi")));
    expect(key).toBe("assistant:msg_abc");
  });

  it("keys user tool_result events by tool_use_id", () => {
    const key = eventDedupKey(JSON.parse(userToolResultEvent("toolu_1", "ok")));
    expect(key).toBe("user:tool_result:toolu_1");
  });

  it("keys system init events by session_id", () => {
    const key = eventDedupKey(JSON.parse(systemInitEvent("sess_xyz")));
    expect(key).toBe("system:init:sess_xyz");
  });

  it("keys result events by session_id", () => {
    const key = eventDedupKey(JSON.parse(resultEvent("sess_xyz")));
    expect(key).toBe("result:sess_xyz");
  });

  it("returns null for assistant events missing message.id", () => {
    const event = { type: "assistant", message: { content: [] } };
    expect(eventDedupKey(event)).toBeNull();
  });

  it("returns null for unknown event types", () => {
    expect(eventDedupKey({ type: "unknown" })).toBeNull();
    expect(eventDedupKey({})).toBeNull();
  });
});

describe("LogLineDedupFilter", () => {
  it("passes unique lines through unchanged", () => {
    const filter = new LogLineDedupFilter();
    const a = assistantEvent("msg_1", "hello");
    const b = assistantEvent("msg_2", "world");
    expect(filter.filter(`${a}\n${b}\n`)).toBe(`${a}\n${b}\n`);
  });

  it("drops assistant events replayed with the same message.id", () => {
    const filter = new LogLineDedupFilter();
    const a = assistantEvent("msg_1", "Three nits to fix.");
    filter.filter(`${a}\n`);
    expect(filter.filter(`${a}\n`)).toBe("");
  });

  it("drops user tool_result events replayed with the same tool_use_id", () => {
    const filter = new LogLineDedupFilter();
    const a = userToolResultEvent("toolu_abc", "file contents");
    filter.filter(`${a}\n`);
    expect(filter.filter(`${a}\n`)).toBe("");
  });

  it("drops system init and result events on replay", () => {
    const filter = new LogLineDedupFilter();
    const init = systemInitEvent("sess_1");
    const result = resultEvent("sess_1");
    filter.filter(`${init}\n${result}\n`);
    expect(filter.filter(`${init}\n${result}\n`)).toBe("");
  });

  it("buffers incomplete trailing lines across chunks", () => {
    const filter = new LogLineDedupFilter();
    const line = assistantEvent("msg_1", "hello");
    const mid = Math.floor(line.length / 2);
    const out1 = filter.filter(line.slice(0, mid));
    const out2 = filter.filter(line.slice(mid) + "\n");
    expect(out1).toBe("");
    expect(out2).toBe(`${line}\n`);
  });

  it("flush() emits a final incomplete line that was not replayed", () => {
    const filter = new LogLineDedupFilter();
    const line = assistantEvent("msg_tail", "no newline");
    filter.filter(line);
    expect(filter.flush()).toBe(line);
  });

  it("flush() drops an incomplete line that was already seen with a newline", () => {
    const filter = new LogLineDedupFilter();
    const line = assistantEvent("msg_same", "x");
    filter.filter(`${line}\n`);
    filter.filter(line);
    expect(filter.flush()).toBe("");
  });

  it("passes non-JSON lines through every time (does not dedup paperclip status)", () => {
    const filter = new LogLineDedupFilter();
    const status = "[paperclip] keepalive — job foo running\n";
    expect(filter.filter(status)).toBe(status);
    expect(filter.filter(status)).toBe(status);
  });

  it("dedups structurally identical JSON with identical content (raw fallback)", () => {
    const filter = new LogLineDedupFilter();
    // No recognized type → raw fallback key.
    const line = JSON.stringify({ foo: "bar", baz: 1 });
    filter.filter(`${line}\n`);
    expect(filter.filter(`${line}\n`)).toBe("");
  });

  it("handles multiple complete lines in a single chunk with partial trailing", () => {
    const filter = new LogLineDedupFilter();
    const a = assistantEvent("msg_a", "a");
    const b = assistantEvent("msg_b", "b");
    const c = assistantEvent("msg_c", "c");
    // a and b are complete, c is partial (no trailing newline).
    const out = filter.filter(`${a}\n${b}\n${c}`);
    expect(out).toBe(`${a}\n${b}\n`);
    // Completing c later should emit exactly c.
    expect(filter.filter("\n")).toBe(`${c}\n`);
  });

  it("drops the classic FAR-123 replay scenario across reconnects", () => {
    const filter = new LogLineDedupFilter();
    const assistantNits = assistantEvent("msg_nits", "Three nits to fix. Let me look at an existing test file...");
    const assistantWrite = assistantEvent("msg_write", "Now I need to write unit tests");
    // First stream attempt emits both events.
    const out1 = filter.filter(`${assistantNits}\n${assistantWrite}\n`);
    expect(out1).toBe(`${assistantNits}\n${assistantWrite}\n`);
    // Reconnect replays both within the sinceSeconds overlap — filter should drop them.
    const out2 = filter.filter(`${assistantNits}\n${assistantWrite}\n`);
    expect(out2).toBe("");
    // And a genuinely new event after the replay should still pass through.
    const assistantFresh = assistantEvent("msg_fresh", "next turn");
    expect(filter.filter(`${assistantFresh}\n`)).toBe(`${assistantFresh}\n`);
  });
});
