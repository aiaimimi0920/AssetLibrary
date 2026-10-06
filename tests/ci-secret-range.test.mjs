import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { secretRange } from "../scripts/ci-secret-range.mjs";

const base = "a".repeat(40);
const head = "b".repeat(40);

test("push 与 PR 保留完整基线至 HEAD，不退化为单提交", () => {
  for (const event of ["push", "pull_request"]) {
    const calls = [];
    assert.equal(
      secretRange(event, base, head, (args) => {
        calls.push(args);
        return true;
      }),
      `${base}..${head}`,
    );
    assert.deepEqual(calls, [
      ["cat-file", "-e", `${base}^{commit}`],
      ["merge-base", "--is-ancestor", base, head],
    ]);
  }
});

test("缺失、零值、无效与注入基线在 Git 调用前失败", () => {
  for (const value of [undefined, "", "0".repeat(40), "HEAD^", "--all", `${base}\n--all`]) {
    assert.throws(
      () =>
        secretRange("push", value, head, () => {
          throw new Error("UNEXPECTED_GIT");
        }),
      /CI_BASE_REQUIRED/,
    );
  }
  assert.throws(() => secretRange("push", base, "HEAD", () => true), /CI_HEAD_INVALID/);
  assert.throws(() => secretRange("schedule", base, head, () => true), /CI_EVENT_UNSUPPORTED/);
});

test("无法解析或非祖先基线明确失败，绝不静默 fallback", () => {
  assert.throws(() => secretRange("push", base, head, () => false), /CI_BASE_UNAVAILABLE/);
  let calls = 0;
  assert.throws(
    () => secretRange("pull_request", base, head, () => ++calls === 1),
    /CI_BASE_NOT_ANCESTOR/,
  );
  assert.equal(calls, 2);
});

test("手动触发明确仅扫描当前提交，根提交也无需 HEAD^ fallback", () => {
  assert.equal(
    secretRange("workflow_dispatch", undefined, head, () => {
      throw new Error("UNEXPECTED_GIT");
    }),
    `${head}^!`,
  );
});

test("真实 Git 三提交仓库扫描完整推送区间，缺失基线 CLI 非零退出", async () => {
  const bundle = process.env.ASSETLIBRARY_BUNDLE;
  assert.ok(bundle);
  const cwd = await mkdtemp(
    path.join(path.dirname(path.dirname(bundle)), "assetlibrary-ci-range-"),
  );
  function git(args) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git(["init", "--quiet"]);
  const commits = [];
  for (let i = 0; i < 3; i += 1) {
    await writeFile(path.join(cwd, "file.txt"), String(i), "utf8");
    git(["add", "file.txt"]);
    git([
      "-c",
      "user.name=CI fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      `fixture ${i}`,
    ]);
    commits.push(git(["rev-parse", "HEAD"]));
  }
  const script = fileURLToPath(new URL("../scripts/ci-secret-range.mjs", import.meta.url));
  function run(baseSha) {
    return spawnSync(process.execPath, [script], {
      cwd,
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, GITHUB_EVENT_NAME: "push", BASE_SHA: baseSha },
    });
  }
  const valid = run(commits[0]);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.stdout.trim(), `${commits[0]}..${commits[2]}`);
  assert.equal(git(["rev-list", "--count", valid.stdout.trim()]), "2");
  const missing = run("c".repeat(40));
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /CI_BASE_UNAVAILABLE/);
});
