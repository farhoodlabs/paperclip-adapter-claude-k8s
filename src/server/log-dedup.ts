/**
 * Line-level dedup filter for the K8s log stream.
 *
 * The K8s log follow stream can reconnect with an overlapping `sinceSeconds`
 * window (integer-second granularity + a safety buffer), which replays a few
 * seconds of recent output on every reconnect. Without dedup those replayed
 * lines appear as duplicate events in the streaming UI — the same assistant
 * text block shows up between every subsequent tool call (FAR-123).
 *
 * The filter operates at the chunk → line level: chunks are split on `\n`,
 * incomplete trailing content is buffered until the next chunk, and each
 * complete line is emitted at most once. JSON-shaped Claude stream-json
 * events are keyed by their stable structural IDs; non-JSON lines pass
 * through unchanged so genuinely-repeated status lines are not swallowed.
 */

type Parsed = Record<string, unknown>;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Parsed | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Parsed;
}

/**
 * Build a stable dedup key for a Claude stream-json event.  Returns `null`
 * when the event is not a recognized Claude event — those lines fall back to
 * raw-content hashing so non-JSON output (paperclip status lines, shell
 * output) is never deduped by identity.
 */
export function eventDedupKey(event: Parsed): string | null {
  const type = asString(event.type);

  if (type === "system") {
    const subtype = asString(event.subtype);
    const sessionId = asString(event.session_id);
    if (subtype === "init" && sessionId) return `system:init:${sessionId}`;
    return null;
  }

  if (type === "assistant") {
    const message = asRecord(event.message);
    const id = message ? asString(message.id) : "";
    if (id) return `assistant:${id}`;
    return null;
  }

  if (type === "user") {
    const message = asRecord(event.message);
    const content = message && Array.isArray(message.content) ? message.content : [];
    const toolUseIds: string[] = [];
    for (const entry of content) {
      const block = asRecord(entry);
      if (!block) continue;
      const toolUseId = asString(block.tool_use_id);
      if (toolUseId) toolUseIds.push(toolUseId);
    }
    if (toolUseIds.length > 0) return `user:tool_result:${toolUseIds.join(",")}`;
    return null;
  }

  if (type === "result") {
    const sessionId = asString(event.session_id);
    return sessionId ? `result:${sessionId}` : "result:unknown";
  }

  return null;
}

/**
 * Stateful line-level dedup filter.  Emits `filter(chunk)` output through
 * the caller — preserves original chunk formatting (including trailing
 * newlines) for lines that pass the dedup check.
 */
export class LogLineDedupFilter {
  private buffer = "";
  private readonly seenKeys = new Set<string>();

  /**
   * Process a chunk and return the subset that should be forwarded.
   * Incomplete trailing content (no terminating newline) is buffered and
   * emitted on the next chunk that completes the line (or on flush()).
   */
  filter(chunk: string): string {
    if (!chunk) return "";
    const combined = this.buffer + chunk;
    const endsWithNewline = combined.endsWith("\n");
    const parts = combined.split("\n");

    if (endsWithNewline) {
      // Discard the final empty element — last line was complete.
      parts.pop();
      this.buffer = "";
    } else {
      // Last element is an incomplete line — hold it for the next chunk.
      this.buffer = parts.pop() ?? "";
    }

    const out: string[] = [];
    for (const line of parts) {
      if (this.shouldEmit(line)) out.push(line);
    }
    if (out.length === 0) return "";
    return out.join("\n") + "\n";
  }

  /**
   * Flush any incomplete trailing content.  Called when the stream ends
   * without a terminating newline so the final partial line isn't lost.
   */
  flush(): string {
    const pending = this.buffer;
    this.buffer = "";
    if (!pending) return "";
    return this.shouldEmit(pending) ? pending : "";
  }

  private shouldEmit(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return true;

    // Only attempt dedup on JSON-shaped lines; pass shell/text output through.
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return true;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return true;
    }

    const event = asRecord(parsed);
    if (!event) return true;

    // Recognized Claude stream-json event → structural key.
    const structuralKey = eventDedupKey(event);
    const key = structuralKey ?? `raw:${trimmed}`;

    if (this.seenKeys.has(key)) return false;
    this.seenKeys.add(key);
    return true;
  }
}
