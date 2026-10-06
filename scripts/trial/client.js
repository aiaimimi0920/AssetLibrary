import "/app.client.js";
import { confirmAction } from "/render.client.js";

const element = (id) => document.getElementById(id);
let submitting = false;
let login = null;
let maintenance = null;
async function localRequest(path, body, signal) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-assetlibrary-trial": "1" },
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
  });
  if (!response.ok) throw new Error(`LOCAL_TRIAL_REQUEST_FAILED ${response.status}`);
  return response.json();
}

// 复用原应用的身份清除、请求取消和 D1 授权；不向生产客户端增加模拟登录分支。
element("identity-form").addEventListener(
  "submit",
  async (event) => {
    if (submitting) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    element("disconnect").click();
    const controller = new AbortController();
    login = controller;
    const number = element("trial-number").value;
    const button = element("identity-form").querySelector("button");
    button.disabled = true;
    element("trial-login-state").textContent = "正在连接本地虚构身份…";
    try {
      const result = await localRequest("/__trial/login", { number }, controller.signal);
      controller.signal.throwIfAborted();
      if (login !== controller) return;
      element("credential").value = result.token;
      element("trial-login-state").textContent =
        `已签发虚构主体 ${result.principal}；身份验证结果见页顶。`;
      submitting = true;
      element("identity-form").requestSubmit();
    } catch {
      if (login === controller)
        element("trial-login-state").textContent = "连接失败或已取消；可以重新选择编号连接。";
    } finally {
      submitting = false;
      if (login === controller) {
        login = null;
        // 原应用已开始身份请求时，由其自身 controls 负责按钮生命周期。
        if (element("stop").disabled) button.disabled = false;
      }
    }
  },
  { capture: true },
);

function clearLogin() {
  login?.abort();
  login = null;
  maintenance?.abort();
  element("credential").value = "";
  element("trial-login-state").textContent = "本地身份已清除，可重新选择编号。";
}
element("disconnect").addEventListener("click", clearLogin);
element("trial-number").addEventListener("change", () => element("disconnect").click());
element("trial-tick").addEventListener("click", async () => {
  if (maintenance) return;
  const controller = new AbortController();
  maintenance = controller;
  element("trial-tick").disabled = true;
  try {
    await localRequest("/__trial/tick", {}, controller.signal);
    element("trial-tick-state").textContent =
      "本轮队列已执行；请查询检查事实，队列完成不代表每项检查通过。";
  } catch {
    element("trial-tick-state").textContent = "队列调用失败或取消，请查询状态后重试。";
  } finally {
    maintenance = null;
    element("trial-tick").disabled = false;
  }
});
window.addEventListener("pagehide", clearLogin, { once: true });
element("trial-stop").addEventListener("click", async () => {
  if (
    !(await confirmAction(
      "停止本地体验",
      "关闭本轮服务并保留体验数据；再次运行 pnpm trial 会创建新的一轮。",
      "停止服务",
    ))
  )
    return;
  element("disconnect").click();
  try {
    await localRequest("/__trial/stop", {}, new AbortController().signal);
    element("trial-tick-state").textContent =
      "已请求停止本地服务，数据保留；再次运行 pnpm trial 可开始新的一轮。";
  } catch {
    element("trial-tick-state").textContent = "未收到停止确认，请检查本地启动终端。";
  }
});
