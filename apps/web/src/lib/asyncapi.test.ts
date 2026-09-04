import { Parser } from "@asyncapi/parser";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const contractPath = fileURLToPath(
  new URL("../../../../contracts/asyncapi/asyncapi.yaml", import.meta.url),
);

describe("AsyncAPI contract", () => {
  it("parses without contract errors", async () => {
    const result = await new Parser().parse(readFileSync(contractPath, "utf8"));
    const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === 0);

    expect(errors).toEqual([]);
    expect(result.document).toBeDefined();
  });
});
