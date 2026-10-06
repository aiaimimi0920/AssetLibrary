import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const sha = /^[0-9a-f]{40}$/;

/** 不可解析的推送基线不得退化为最后一次提交，避免漏扫多提交推送。 */
export function secretRange(event, base, head, git) {
  if (!sha.test(head)) throw new Error("CI_HEAD_INVALID");
  if (event === "workflow_dispatch") return `${head}^!`;
  if (!["push", "pull_request"].includes(event)) throw new Error("CI_EVENT_UNSUPPORTED");
  if (!sha.test(base ?? "") || /^0+$/.test(base)) throw new Error("CI_BASE_REQUIRED");
  if (!git(["cat-file", "-e", `${base}^{commit}`])) throw new Error("CI_BASE_UNAVAILABLE");
  if (!git(["merge-base", "--is-ancestor", base, head])) throw new Error("CI_BASE_NOT_ANCESTOR");
  return `${base}..${head}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  function command(args) {
    const result = spawnSync("git", args, { encoding: "utf8", timeout: 10000, maxBuffer: 65536 });
    if (result.error) throw new Error("CI_GIT_UNAVAILABLE");
    return result;
  }
  try {
    const head = command(["rev-parse", "HEAD"]);
    if (head.status !== 0) throw new Error("CI_HEAD_UNAVAILABLE");
    console.log(
      secretRange(
        process.env.GITHUB_EVENT_NAME,
        process.env.BASE_SHA,
        head.stdout.trim(),
        (args) => command(args).status === 0,
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
