import { describe, it, expect } from "vitest";
import { sessionCodec } from "./session.js";

const deserialize = sessionCodec.deserialize.bind(sessionCodec);
const serialize = sessionCodec.serialize.bind(sessionCodec);
const getDisplayId = sessionCodec.getDisplayId!.bind(sessionCodec);

describe("sessionCodec", () => {
  describe("deserialize", () => {
    it("returns null for non-object input", () => {
      expect(deserialize(null)).toBeNull();
      expect(deserialize(undefined)).toBeNull();
      expect(deserialize("string")).toBeNull();
      expect(deserialize(123)).toBeNull();
      expect(deserialize([])).toBeNull();
    });

    it("returns null when no sessionId present", () => {
      expect(deserialize({})).toBeNull();
      expect(deserialize({ workspaceId: "ws1" })).toBeNull();
    });

    it("accepts sessionId key", () => {
      const result = deserialize({ sessionId: "sess_abc" });
      expect(result?.sessionId).toBe("sess_abc");
    });

    it("accepts session_id key as fallback", () => {
      const result = deserialize({ session_id: "sess_abc" });
      expect(result?.sessionId).toBe("sess_abc");
    });

    it("prefers sessionId over session_id", () => {
      const result = deserialize({ sessionId: "sess_a", session_id: "sess_b" });
      expect(result?.sessionId).toBe("sess_a");
    });

    it("trims whitespace from sessionId", () => {
      const result = deserialize({ sessionId: "  sess_abc  " });
      expect(result?.sessionId).toBe("sess_abc");
    });

    it("returns null for blank sessionId", () => {
      expect(deserialize({ sessionId: "" })).toBeNull();
      expect(deserialize({ sessionId: "   " })).toBeNull();
    });

    it("maps cwd variants", () => {
      expect(deserialize({ sessionId: "s", cwd: "/work" })?.cwd).toBe("/work");
      expect(deserialize({ sessionId: "s", workdir: "/work" })?.cwd).toBe("/work");
      expect(deserialize({ sessionId: "s", folder: "/work" })?.cwd).toBe("/work");
    });

    it("prefers cwd over workdir and folder", () => {
      const result = deserialize({ sessionId: "s", cwd: "/a", workdir: "/b", folder: "/c" });
      expect(result?.cwd).toBe("/a");
    });

    it("maps workspaceId and workspace_id", () => {
      expect(deserialize({ sessionId: "s", workspaceId: "ws1" })?.workspaceId).toBe("ws1");
      expect(deserialize({ sessionId: "s", workspace_id: "ws2" })?.workspaceId).toBe("ws2");
    });

    it("maps repoUrl and repo_url", () => {
      expect(deserialize({ sessionId: "s", repoUrl: "https://github.com/a/b" })?.repoUrl).toBe("https://github.com/a/b");
      expect(deserialize({ sessionId: "s", repo_url: "https://github.com/a/b" })?.repoUrl).toBe("https://github.com/a/b");
    });

    it("maps repoRef and repo_ref", () => {
      expect(deserialize({ sessionId: "s", repoRef: "main" })?.repoRef).toBe("main");
      expect(deserialize({ sessionId: "s", repo_ref: "develop" })?.repoRef).toBe("develop");
    });

    it("omits undefined fields", () => {
      const result = deserialize({ sessionId: "sess_abc" });
      expect(Object.keys(result!)).toEqual(["sessionId"]);
    });

    it("includes all available fields", () => {
      const result = deserialize({
        sessionId: "sess_abc",
        cwd: "/work",
        workspaceId: "ws1",
        repoUrl: "https://github.com/a/b",
        repoRef: "main",
      });
      expect(result).toEqual({
        sessionId: "sess_abc",
        cwd: "/work",
        workspaceId: "ws1",
        repoUrl: "https://github.com/a/b",
        repoRef: "main",
      });
    });
  });

  describe("serialize", () => {
    it("returns null for null/undefined input", () => {
      expect(serialize(null)).toBeNull();
      expect(serialize(undefined as unknown as null)).toBeNull();
    });

    it("returns null when no sessionId", () => {
      expect(serialize({})).toBeNull();
      expect(serialize({ cwd: "/work" })).toBeNull();
    });

    it("serializes sessionId", () => {
      expect(serialize({ sessionId: "sess_abc" })?.sessionId).toBe("sess_abc");
    });

    it("falls back to session_id from params", () => {
      const result = serialize({ session_id: "sess_abc" } as unknown as Record<string, unknown> | null);
      expect(result?.sessionId).toBe("sess_abc");
    });

    it("maps all fields same as deserialize", () => {
      const input: Record<string, unknown> = {
        sessionId: "sess_abc",
        cwd: "/work",
        workspaceId: "ws1",
        repoUrl: "https://github.com/a/b",
        repoRef: "main",
      };
      expect(serialize(input)).toEqual(input);
    });

    it("omits undefined fields", () => {
      const result = serialize({ sessionId: "sess_abc" });
      expect(result).not.toBeNull();
      expect(Object.keys(result!)).toEqual(["sessionId"]);
    });
  });

  describe("getDisplayId", () => {
    it("returns null for null/undefined", () => {
      expect(getDisplayId(null)).toBeNull();
      expect(getDisplayId(undefined as unknown as null)).toBeNull();
    });

    it("returns sessionId when present", () => {
      expect(getDisplayId({ sessionId: "sess_abc" })).toBe("sess_abc");
    });

    it("falls back to session_id", () => {
      expect(getDisplayId({ session_id: "sess_abc" })).toBe("sess_abc");
    });

    it("prefers sessionId over session_id", () => {
      expect(getDisplayId({ sessionId: "sess_a", session_id: "sess_b" })).toBe("sess_a");
    });

    it("returns null when neither present", () => {
      expect(getDisplayId({ cwd: "/work" })).toBeNull();
    });

    it("trims whitespace", () => {
      expect(getDisplayId({ sessionId: "  sess_abc  " })).toBe("sess_abc");
    });
  });
});
