import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Parser } from "@asyncapi/parser";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

function rootFile(relativePath: string): string {
  return fileURLToPath(new URL(`../../../../${relativePath}`, import.meta.url));
}

function readJson(relativePath: string): object {
  return JSON.parse(readFileSync(rootFile(relativePath), "utf8")) as object;
}

describe("published schemas", () => {
  it("compiles every manifest schema under JSON Schema 2020-12", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    ajv.addSchema(readJson("schemas/manifest-base.schema.json"));

    for (const name of ["art-manifest", "art-runtime", "capability-manifest", "app-update-manifest"]) {
      expect(() => ajv.compile(readJson(`schemas/${name}.schema.json`))).not.toThrow();
    }
  });

  it("accepts the Loom-native Art manifest and runtime contracts", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validateManifest = ajv.compile(readJson("schemas/art-manifest.schema.json"));
    const validateRuntime = ajv.compile(readJson("schemas/art-runtime.schema.json"));

    expect(
      validateManifest(readJson("contracts/fixtures/art-manifest.v1.json")),
      JSON.stringify(validateManifest.errors),
    ).toBe(true);
    expect(
      validateRuntime(readJson("contracts/fixtures/art-runtime.v1.json")),
      JSON.stringify(validateRuntime.errors),
    ).toBe(true);
  });

  it("rejects undeclared Art execution and package-security fields", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(readJson("schemas/art-manifest.schema.json"));
    const rootExtension = {
      ...readJson("contracts/fixtures/art-manifest.v1.json"),
      permissions: ["network"],
    };
    const securityExtension = structuredClone(
      readJson("contracts/fixtures/art-manifest.v1.json"),
    ) as { metadata: { packageSecurity: Record<string, unknown> } };
    securityExtension.metadata.packageSecurity.allowUnsigned = true;

    expect(validate(rootExtension)).toBe(false);
    expect(validate(securityExtension)).toBe(false);
  });

  it("accepts the Loom-native capability v1 contract and rejects legacy nesting", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(readJson("schemas/capability-manifest.schema.json"));
    const manifest = readJson("contracts/fixtures/capability-manifest.v1.json");

    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
    expect(
      validate({
        schema_version: "1.0.0",
        package: { kind: "capability" },
        capability: { entrypoint: "runtime/main", permissions: [] },
      }),
    ).toBe(false);
  });

  it("parses the AsyncAPI event contract", async () => {
    const source = readFileSync(rootFile("contracts/asyncapi/asyncapi.yaml"), "utf8");
    const result = await new Parser().parse(source);
    const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === 0);

    expect(errors).toEqual([]);
    expect(result.document).toBeDefined();
  });
});
