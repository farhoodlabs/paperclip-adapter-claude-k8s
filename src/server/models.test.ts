import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { listK8sModels, DIRECT_MODELS, BEDROCK_MODELS } from "./models.js";

describe("listK8sModels", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.CLAUDE_CODE_USE_BEDROCK = process.env.CLAUDE_CODE_USE_BEDROCK;
    savedEnv.ANTHROPIC_BEDROCK_BASE_URL = process.env.ANTHROPIC_BEDROCK_BASE_URL;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.ANTHROPIC_BEDROCK_BASE_URL;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("returns direct API models by default", async () => {
    const models = await listK8sModels();
    expect(models.some((m) => m.id === "claude-opus-4-7")).toBe(true);
    expect(models.some((m) => m.id === "claude-opus-4-6")).toBe(true);
    expect(models.every((m) => !m.id.includes("anthropic."))).toBe(true);
  });

  it("returns Bedrock models when CLAUDE_CODE_USE_BEDROCK=1", async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    const models = await listK8sModels();
    expect(models.some((m) => m.id.includes("anthropic."))).toBe(true);
    expect(models.every((m) => !m.id.startsWith("claude-"))).toBe(true);
  });

  it("returns Bedrock models when CLAUDE_CODE_USE_BEDROCK=true", async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "true";
    const models = await listK8sModels();
    expect(models.some((m) => m.id.includes("anthropic."))).toBe(true);
  });

  it("returns Bedrock models when ANTHROPIC_BEDROCK_BASE_URL is set", async () => {
    process.env.ANTHROPIC_BEDROCK_BASE_URL = "https://bedrock.us-east-1.amazonaws.com";
    const models = await listK8sModels();
    expect(models.some((m) => m.id.includes("anthropic."))).toBe(true);
  });

  it("ignores blank ANTHROPIC_BEDROCK_BASE_URL", async () => {
    process.env.ANTHROPIC_BEDROCK_BASE_URL = "   ";
    const models = await listK8sModels();
    expect(models.some((m) => m.id === "claude-opus-4-7")).toBe(true);
  });
});

describe("static model lists", () => {
  it("DIRECT_MODELS is non-empty and has valid ids", () => {
    expect(DIRECT_MODELS.length).toBeGreaterThan(0);
    for (const m of DIRECT_MODELS) {
      expect(typeof m.id).toBe("string");
      expect(m.id.length).toBeGreaterThan(0);
      expect(typeof m.label).toBe("string");
    }
  });

  it("BEDROCK_MODELS is non-empty and all ids contain 'anthropic.'", () => {
    expect(BEDROCK_MODELS.length).toBeGreaterThan(0);
    for (const m of BEDROCK_MODELS) {
      expect(m.id).toContain("anthropic.");
      expect(typeof m.label).toBe("string");
    }
  });
});
