import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { trialPage } from "../scripts/trial/presentation.mjs";

test("本地体验模板接受 LF 与 CRLF，不因格式化丢失入口或续传按钮", async () => {
  const source = (
    await readFile(new URL("../src/web/index.html", import.meta.url), "utf8")
  ).replaceAll("\r\n", "\n");
  const lf = await trialPage(source);
  const crlf = await trialPage(source.replaceAll("\n", "\r\n"));
  assert.equal(crlf, lf);
  assert.match(lf, /id="trial-number"/);
  assert.match(lf, /id="resume-download"/);
  assert.match(lf, /id="discard-download"/);
  assert.match(lf, /id="credential" hidden/);
  await assert.rejects(
    trialPage(source.replace('id="credential"', 'id="missing"')),
    /TRIAL_SOURCE_CONTRACT_CHANGED/,
  );
});
