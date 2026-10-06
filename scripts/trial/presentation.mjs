import { readFile } from "node:fs/promises";
import { replaceOnce } from "./bundle.mjs";

export async function trialPage(source) {
  source = source.replaceAll("\r\n", "\n");
  let page = replaceOnce(
    source,
    '<script type="module" src="/app.client.js"></script>',
    '<script type="module" src="/__trial/client.js"></script>',
  );
  page = replaceOnce(
    page,
    "<title>AssetLibrary · Neuro</title>",
    "<title>AssetLibrary · 本地全流程体验</title>",
  );
  page = replaceOnce(
    page,
    '<label for="credential">外部身份 Bearer JWT</label>',
    `<label for="trial-number">虚构体验编号（不是手机号）</label>
    <select id="trial-number">
      <option value="10001">10001 · 发布者</option>
      <option value="10002">10002 · 独立审核者</option>
      <option value="10003">10003 · 下载者</option>
      <option value="10004">10004 · 未授权对照用户</option>
    </select>
    <p id="trial-login-state" class="muted" role="status">选择编号后连接；无需注册或粘贴 JWT。</p>`,
  );
  page = replaceOnce(page, 'id="credential"', 'id="credential" hidden');
  page = replaceOnce(
    page,
    '            required\n            maxlength="8192"',
    '            maxlength="8192"',
  );
  page = replaceOnce(
    page,
    "不提供模拟登录。",
    "当前为独立的本地模拟身份，15 分钟后可重新连接同一编号。",
  );
  page = replaceOnce(
    page,
    "<main>",
    `<main>
    <section aria-labelledby="trial-heading">
      <h2 id="trial-heading">本地全流程体验 · 非生产环境</h2>
      <p class="status">虚构身份 / 合成 AV / 假设部署准入。ZIP、清单、PNG、摘要、业务权限、D1/R2 和下载字节真实执行；不是恶意内容安全证明。</p>
      <p>10001 创建并上传 → 创建版本 → 10002 读取审核待办并审核 → 10001 发布并授权 trial:10003 → 10003 下载 → 10001 撤销或下架。</p>
      <div class="toolbar">
        <a href="/__trial/sample.zip" download="two-png.zip">下载双 PNG 示例包</a>
        <a href="/__trial/capability.zip" download="capability.zip">下载 Capability 示例包</a>
        <a href="/__trial/application.zip" download="application.zip">下载应用示例包</a>
        <button id="trial-tick" type="button">立即执行检查队列</button><button id="trial-stop" type="button">停止本地体验（保留数据）</button>
      </div>
      <p class="muted">创建资源时选择与示例相同的类型。软件示例只是无害字节载荷，不会执行，也不代表可安装的 Loom Capability 或应用。</p>
      <p id="trial-tick-state" class="muted" role="status">后台每 2 秒处理一次有界队列；上传后可查询检查。生产阻断字段仍保留，仅本地体验允许发布。</p>
    </section>`,
  );
  return page;
}

export const trialClient = () => readFile(new URL("./client.js", import.meta.url), "utf8");
