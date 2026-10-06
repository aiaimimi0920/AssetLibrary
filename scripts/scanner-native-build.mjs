import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nativeProofFiles, verifyNativeProof } from "./scanner-native-policy.mjs";
import {
  nativeBase,
  nativeCommand,
  prepareNativeContext,
  verifyNativeContext,
} from "./scanner-native-tools.mjs";
import { sha256 } from "./scanner-release-policy.mjs";
import { artifactRoot } from "./source-scope.mjs";

/** 独占本地候选，不切换活动 Dockerfile、不提供云部署或生产准入分支。 */
export async function buildNativeScanner(cmakeFile, sourceRepository) {
  await mkdir(artifactRoot, { recursive: true });
  const output = await mkdtemp(path.join(artifactRoot, "assetlibrary-native-build-"));
  assert(!output.includes(","), "DOCKER_OUTPUT_PATH_INVALID");
  const owner = randomUUID();
  const name = `assetlibrary-native-${owner}`;
  const tag = `neuro-assetlibrary-native:${owner}`;
  const run = (args, label, timeout) => nativeCommand(args, output, label, timeout);
  const save = (file, value) =>
    writeFile(path.join(output, file), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  let created = false;
  let image;
  let materialImage;
  let input;
  let verification;
  console.log(`Native build evidence: ${output}`);
  try {
    input = await prepareNativeContext(output, cmakeFile, sourceRepository);
    await save("inputs.json", { ...input, base: nativeBase, owner });
    const common = [
      "docker",
      "buildx",
      "build",
      "--progress=plain",
      "--platform=linux/amd64",
      "--file",
      path.join(input.context, "Dockerfile"),
    ];
    await verifyNativeContext(input);
    await run(
      [
        ...common,
        "--target=proof",
        "--output",
        `type=local,dest=${path.join(output, "proof")}`,
        "--metadata-file",
        path.join(output, "proof-metadata.json"),
        input.context,
      ],
      "offline-build",
      2400000,
    );
    await verifyNativeContext(input);
    await run(
      [
        ...common,
        "--target=materials",
        "--load",
        "--tag",
        `${tag}-materials`,
        "--label",
        `neuro.owner=${owner}`,
        input.context,
      ],
      "materials-export",
      1800000,
    );
    materialImage = JSON.parse(
      await run(["docker", "image", "inspect", `${tag}-materials`], "materials-inspect"),
    )[0];
    assert.equal(
      materialImage.Config.Labels?.["neuro.owner"],
      owner,
      "NATIVE_MATERIAL_IMAGE_OWNER_MISMATCH",
    );
    // 完整材料文件系统快照覆盖编译器后端、Rust sysroot、系统链接输入及 vendor，不能仅以工具入口哈希代替。
    await save("material-image.json", {
      id: materialImage.Id,
      inputSource: input.source,
      base: nativeBase,
      owner,
    });
    await verifyNativeContext(input);
    await run(
      [
        ...common,
        "--target=runtime",
        "--load",
        "--tag",
        tag,
        "--label",
        `neuro.owner=${owner}`,
        input.context,
      ],
      "runtime-build",
      1800000,
    );
    image = JSON.parse(await run(["docker", "image", "inspect", tag], "image-inspect"))[0];
    assert.equal(image.Config.Labels?.["neuro.owner"], owner, "NATIVE_IMAGE_OWNER_MISMATCH");
    created = true;
    await run(
      [
        "docker",
        "create",
        "--name",
        name,
        "--label",
        `neuro.owner=${owner}`,
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--memory=4g",
        "--cpus=1",
        "--pids-limit=32",
        "--tmpfs=/tmp:rw,noexec,nosuid,size=16m",
        "--user=clamav",
        "--entrypoint=sh",
        image.Id,
        "-c",
        "sleep 180",
      ],
      "probe-create",
    );
    const state = JSON.parse(await run(["docker", "inspect", name], "probe-isolation"))[0];
    assert.equal(state.Name, `/${name}`, "NATIVE_PROBE_NAME_MISMATCH");
    assert.equal(state.Config.Labels?.["neuro.owner"], owner, "NATIVE_PROBE_OWNER_MISMATCH");
    assert.equal(state.Image, image.Id, "NATIVE_PROBE_IMAGE_MISMATCH");
    assert.equal(state.HostConfig.NetworkMode, "none", "NATIVE_PROBE_NETWORK_ENABLED");
    assert.equal(state.HostConfig.ReadonlyRootfs, true, "NATIVE_PROBE_WRITABLE_ROOT");
    await run(["docker", "start", name], "probe-start");
    await run(["docker", "exec", name, "clamscan", "--version"], "engine-version");
    const probe = await run(
      ["docker", "exec", name, "node", "/opt/native/runtime-probe.mjs"],
      "runtime-probe",
      150000,
    );
    const runtime = JSON.parse(probe);
    const after = JSON.parse(await run(["docker", "inspect", name], "probe-after"))[0];
    await save("runtime.json", {
      image: image.Id,
      network: "none",
      oomKilled: after.State.OOMKilled,
      memoryLimit: after.HostConfig.Memory,
      ...runtime,
    });
    await verifyNativeContext(input);
    assert.equal(
      sha256(await readFile(path.join(output, "proof/evidence/source-tree.json"))),
      input.source.treeSha256,
      "NATIVE_PROOF_TREE_UNBOUND",
    );
    verification = await verifyNativeProof(output);
  } catch (error) {
    await save("failure.json", {
      at: new Date().toISOString(),
      error: error.message,
      productionReady: false,
    });
    throw error;
  } finally {
    if (created) {
      const existing = await run(
        ["docker", "ps", "-aq", "--filter", `name=^/${name}$`],
        "probe-existence",
      );
      if (existing) {
        const state = JSON.parse(await run(["docker", "inspect", name], "probe-inspect"))[0];
        assert.equal(state.Name, `/${name}`, "NATIVE_CLEANUP_NAME_MISMATCH");
        assert.equal(state.Config.Labels?.["neuro.owner"], owner, "NATIVE_CLEANUP_OWNER_MISMATCH");
        assert.equal(state.Image, image.Id, "NATIVE_CLEANUP_IMAGE_MISMATCH");
        await run(["docker", "stop", "--time=2", name], "probe-stop");
        await run(["docker", "rm", name], "probe-remove");
        await save("cleanup.json", { owner, name, removed: true, imageRetained: image.Id });
      }
    }
  }
  await save("receipt.json", {
    format: 1,
    at: new Date().toISOString(),
    owner,
    image: image.Id,
    materialImage: materialImage.Id,
    input,
    verification,
    files: await nativeProofFiles(output),
    productionReady: false,
    cloudDeployed: false,
  });
  console.log(JSON.stringify({ output, image: image.Id, ...verification }, null, 2));
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert(
    process.argv.length <= 4,
    "USAGE: scanner:native-build [verified-cmake.apk] [git-object-cache]",
  );
  await buildNativeScanner(process.argv[2], process.argv[3]);
}
