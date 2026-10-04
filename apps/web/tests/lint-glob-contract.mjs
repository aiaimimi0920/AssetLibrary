import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const configRequire = createRequire(require.resolve("eslint-config-next/core-web-vitals"));
const pluginPath = configRequire.resolve("@next/eslint-plugin-next/package.json");
const pluginRequire = createRequire(pluginPath);
const { getRootDirs } = pluginRequire("./dist/utils/get-root-dirs.js");
const pluginRoot = resolve(pluginPath, "..");

// tinyglobby returns relative, slash-suffixed directories. Next consumes them
// through path.join/fs, so compare directory identities, not presentation.
const directories = (paths) => paths.map((path) => resolve(path).replaceAll("\\", "/")).sort();

test("the scoped replacement removes braces without changing other consumers", () => {
  const implementation = pluginRequire("fast-glob/package.json");
  assert.equal(implementation.name, "tinyglobby");
  assert.equal(implementation.version, "0.2.17");
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.pnpm.overrides["@next/eslint-plugin-next@16.3.7>fast-glob"], "npm:tinyglobby@0.2.17");
  const lock = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
  assert.doesNotMatch(lock, /^  (?:braces|micromatch|fast-glob)@/m);
});

test("the pinned Next plugin only uses the compatible globSync directory API", () => {
  const consumers = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith(".js")) {
        const source = readFileSync(path, "utf8");
        if (source.includes('require("fast-glob")')) {
          consumers.push(relative(pluginRoot, path).replaceAll("\\", "/"));
          assert.match(source, /_fastglob\.globSync/);
          assert.match(source, /onlyDirectories: true/);
          assert.equal((source.match(/_fastglob\./g) ?? []).length, 1);
        }
      }
    }
  };
  visit(join(pluginRoot, "dist"));
  assert.deepEqual(consumers, ["dist/utils/get-root-dirs.js"]);
});

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "assetlibrary-lint-"));
  try {
    for (const name of ["alpha", "beta", ".hidden"]) mkdirSync(join(root, "apps", name), { recursive: true });
    writeFileSync(join(root, "apps", "not-a-directory"), "fixture");
    run(root.replaceAll("\\", "/"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("Next root discovery preserves literal, brace, extglob and array directory identities", () => {
  fixture((root) => {
    const context = (rootDir) => ({ cwd: root, settings: { next: { rootDir } } });
    const expected = [`${root}/apps/alpha`, `${root}/apps/beta`];
    assert.deepEqual(getRootDirs({ cwd: root, settings: {} }), [root]);
    for (const suffix of ["*", "{alpha,beta}", "@(alpha|beta)"]) {
      assert.deepEqual(directories(getRootDirs(context(`${root}/apps/${suffix}`))), expected);
    }
    assert.deepEqual(directories(getRootDirs(context(`${root}/apps/alpha`))), [expected[0]]);
    assert.deepEqual(directories(getRootDirs(context([`${root}/apps/alpha`, 7, `${root}/apps/beta`]))), expected);
    assert.deepEqual(directories(getRootDirs(context(relative(process.cwd(), `${root}/apps/*`)))), expected);
    assert.deepEqual(getRootDirs(context(`${root}/missing/*`)), []);
    if (process.platform === "win32") {
      assert.deepEqual(directories(getRootDirs(context(`${root}/apps/*`.replaceAll("/", "\\")))), expected);
    }
  });
});

test("the real Next no-html-link-for-pages rule still rejects internal anchors", () => {
  fixture((root) => {
    mkdirSync(`${root}/apps/alpha/pages`);
    writeFileSync(`${root}/apps/alpha/pages/about.js`, "export default function About() {}");
    const { Linter } = require("eslint");
    const plugin = pluginRequire("./dist/index.js");
    const config = {
      languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
      plugins: { "@next/next": plugin },
      settings: { next: { rootDir: `${root}/apps/*` } },
      rules: { "@next/next/no-html-link-for-pages": "error" },
    };
    const lint = (href) => new Linter().verify(`const page = <a href="${href}">About</a>`, config);
    assert.deepEqual(lint("/about").map((message) => message.ruleId), ["@next/next/no-html-link-for-pages"]);
    assert.deepEqual(lint("https://example.com/about"), []);
  });
});
