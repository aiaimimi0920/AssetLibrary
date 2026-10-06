import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { inspectImageEnvironment } from "./scanner-image-environment.mjs";
import { nativeEnginePaths } from "./scanner-native-installation.mjs";

/** 仅创建和回收本轮随机命名、标签匹配的容器；保留镜像及所有既有服务/数据。 */
function docker(args, input, timeout = 80000) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "rtk",
      ["proxy", "docker", ...args],
      { encoding: "utf8", timeout, maxBuffer: 1048576 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message}\n${stdout}\n${stderr}`));
        else resolve((args[0] === "build" || args[0] === "logs" ? stdout + stderr : stdout).trim());
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

const probe = `import http from 'node:http';
let input=''; for await (const chunk of process.stdin) input+=chunk;
const data=JSON.parse(input); const bytes=Buffer.from(data.bytes,'base64');
let aborted=false, timer;
const req=http.request('http://127.0.0.1:8080'+data.path,{method:data.method,headers:data.headers},res=>{
 let body=''; res.on('data',chunk=>{ body+=chunk; if(body.length>8192) req.destroy(new Error('RESPONSE_LIMIT')); });
 res.on('end',()=>{clearTimeout(timer); console.log(JSON.stringify({status:res.statusCode,body,headers:res.headers}));});
});
req.on('error',()=>{clearTimeout(timer); console.log(JSON.stringify({status:503,body:'{}',headers:{},clientAborted:aborted}));});
req.setTimeout(70000,()=>req.destroy(new Error('TIMEOUT')));
if(data.abortAfter) timer=setTimeout(()=>{aborted=true; req.destroy(new Error('ABORT'));},data.abortAfter);
req.end(bytes);`;

export async function localScanner(output) {
  const owner = randomUUID();
  const name = `assetlibrary-p33b-${owner}`;
  const tag = `neuro-assetlibrary-scanner:p33b-${owner}`;
  const context = path.join(output, "scanner");
  let created = false;
  let image;
  async function inspect() {
    return JSON.parse(await docker(["inspect", name]))[0];
  }
  async function cleanup() {
    if (!created) return;
    const state = await inspect();
    if (
      state.Name !== `/${name}` ||
      state.Config.Labels["neuro.owner"] !== owner ||
      state.Image !== image.Id
    )
      throw new Error("CONTAINER_OWNER_MISMATCH");
    await writeFile(path.join(output, "scanner/runtime.log"), await docker(["logs", name]), "utf8");
    await docker(["stop", "--time", "5", name]);
    await docker(["rm", name]);
    created = false;
    await writeFile(
      path.join(output, "scanner/cleanup.json"),
      `${JSON.stringify({ name, owner, removed: true, imageRetained: image.Id })}\n`,
      "utf8",
    );
  }
  try {
    const log = await docker(
      [
        "build",
        "--build-arg",
        `SCANNER_SIGNATURE_REFRESH=${owner}`,
        "--tag",
        tag,
        "--file",
        path.join(context, "Dockerfile"),
        context,
      ],
      undefined,
      180000,
    );
    await writeFile(path.join(output, "scanner/image-build.log"), log, "utf8");
    image = JSON.parse(await docker(["image", "inspect", tag]))[0];
    if (image.Config.Labels?.["neuro.signature-refresh"] !== owner)
      throw new Error("SIGNATURE_REFRESH_IDENTITY_MISMATCH");
    await docker([
      "run",
      "--detach",
      "--name",
      name,
      "--label",
      `neuro.owner=${owner}`,
      "--memory",
      "4g",
      "--cpus",
      "1",
      "--pids-limit",
      "32",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m",
      image.Id,
    ]);
    created = true;
    const state = await inspect();
    if (
      state.HostConfig.NetworkMode !== "none" ||
      !state.HostConfig.ReadonlyRootfs ||
      state.Config.User !== "clamav"
    )
      throw new Error("CONTAINER_ISOLATION_INVALID");
    async function request(method, pathname, bytes = Buffer.alloc(0), headers = {}, abortAfter) {
      const input = JSON.stringify({
        method,
        path: pathname,
        bytes: Buffer.from(bytes).toString("base64"),
        headers,
        abortAfter,
      });
      const result = JSON.parse(
        await docker(["exec", "-i", name, "node", "--input-type=module", "--eval", probe], input),
      );
      // 只在宿主测试适配器标记实际 timer 中止，非 scanner 的生产响应或可信扫描事实。
      const responseHeaders = new Headers(result.headers);
      responseHeaders.set("x-scanner-probe-aborted", String(result.clientAborted === true));
      return new Response(result.body, { status: result.status, headers: responseHeaders });
    }
    let ready = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        ready = (await request("GET", "/healthz")).ok;
      } catch {
        /* 启动校验中 */
      }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!ready) throw new Error("SCANNER_NOT_READY");
    return {
      image: { id: image.Id, tag, created: image.Created, signatureRefresh: owner },
      environment: await inspectImageEnvironment(docker, name),
      request,
      binding: {
        fetch: async (incoming) =>
          request(
            incoming.method,
            new URL(incoming.url).pathname,
            await incoming.arrayBuffer(),
            Object.fromEntries(incoming.headers),
          ),
      },
      files: async () =>
        JSON.parse(
          await docker(
            ["exec", "-i", name, "node", "--input-type=module"],
            await readFile(new URL("./scanner-runtime-inspection.mjs", import.meta.url), "utf8"),
          ),
        ),
      cleanup,
      engineFiles: async () =>
        JSON.parse(
          await docker(
            ["exec", "-i", name, "node", "--input-type=module"],
            `import {readFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const binaries={};
for (const name of ${JSON.stringify(nativeEnginePaths)}) {
  const resolved=await realpath(name);
  binaries[name]={path:resolved,sha256:createHash('sha256').update(await readFile(resolved)).digest('hex')};
}
console.log(JSON.stringify(binaries));`,
          ),
        ),
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
