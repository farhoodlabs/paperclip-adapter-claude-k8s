import { describe, it, expect } from "vitest";
import { getConfigSchema } from "./config-schema.js";

interface ConfigFieldSchema {
  key: string;
  label: string;
  type: string;
  default?: unknown;
  options?: { label: string; value: string }[];
}

describe("getConfigSchema", () => {
  it("returns a non-empty schema", () => {
    const schema = getConfigSchema();
    expect(schema.fields.length).toBeGreaterThan(0);
  });

  it("does not include platform-provided fields", () => {
    const schema = getConfigSchema();
    const keys = schema.fields.map((f: ConfigFieldSchema) => f.key);
    // These fields are provided by the platform and should not be duplicated
    expect(keys).not.toContain("model");
    expect(keys).not.toContain("effort");
    expect(keys).not.toContain("instructionsFilePath");
    expect(keys).not.toContain("timeoutSec");
    expect(keys).not.toContain("graceSec");
  });

  it("maxTurnsPerRun defaults to 1000", () => {
    const schema = getConfigSchema();
    const field = schema.fields.find((f: ConfigFieldSchema) => f.key === "maxTurnsPerRun");
    expect(field).toBeDefined();
    expect(field!.type).toBe("number");
    expect(field!.default).toBe(1000);
  });

  it("dangerouslySkipPermissions defaults to true", () => {
    const schema = getConfigSchema();
    const field = schema.fields.find((f: ConfigFieldSchema) => f.key === "dangerouslySkipPermissions");
    expect(field).toBeDefined();
    expect(field!.type).toBe("toggle");
    expect(field!.default).toBe(true);
  });

  it("has imagePullPolicy as select with correct options", () => {
    const schema = getConfigSchema();
    const field = schema.fields.find((f: ConfigFieldSchema) => f.key === "imagePullPolicy");
    expect(field).toBeDefined();
    expect(field!.type).toBe("select");
    expect(field!.options).toEqual([
      { label: "IfNotPresent", value: "IfNotPresent" },
      { label: "Always", value: "Always" },
      { label: "Never", value: "Never" },
    ]);
  });
});
