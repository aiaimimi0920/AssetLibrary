import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  imagePackages,
  inspectImageEnvironment,
  validateImageEnvironment,
  verifyImageCoverage,
} from "../scripts/scanner-image-environment.mjs";
import { imageEnvironment, imageInventory } from "./scanner-image-fixture.mjs";

test("镜像使用固定官方同版本 Alpine 和发行版 Node，不混装 glibc 或伪造 ABI", async () => {
  const source = await readFile(new URL("../scanner/Dockerfile", import.meta.url), "utf8");
  assert.match(
    source,
    /^FROM clamav\/clamav@sha256:ebec5bc138401b36ae987caa1a3fa3c3b2a21ed3d51f0bfa5852825e663e67b0$/m,
  );
  assert.equal(source.match(/^FROM /gm)?.length, 1);
  for (const entry of imagePackages)
    assert(source.includes(entry.replace(/-(\d.*)$/, "=$1")), `PACKAGE_PIN_MISSING:${entry}`);
  assert.doesNotMatch(
    source,
    /apt-get|COPY --from=node|LD_LIBRARY_PATH|--allow-untrusted|ln -s|apk del/,
  );
  assert.match(source, /freshclam --user=root --stdout --no-warnings/);
  assert.match(source, /^USER clamav$/m);
});

test("实际环境漂移、缺二进制、XML 链接失败不能签发环境证明", () => {
  validateImageEnvironment(imageEnvironment());
  for (const mutate of [
    (v) => {
      v.node = "22.23.3";
    },
    (v) => {
      v.osRelease = "ID=debian\nVERSION_ID=13\n";
    },
    (v) => {
      v.packages = [];
    },
    (v) => {
      v.packages.push(v.packages[0]);
    },
    (v) => {
      v.linkedLibraries = "libxml2.so.2 => not found";
    },
    (v) => {
      delete v.binaries["/usr/bin/clamscan"];
    },
  ]) {
    const value = imageEnvironment();
    mutate(value);
    assert.throws(() => validateImageEnvironment(value));
  }
});

test("扫描必须覆盖实际全部 APK，缺包、版本错误、重复包和过期发行版不能假绿", () => {
  const input = () => ({
    Metadata: { OS: { Family: "alpine", Name: "3.24.2" } },
    Results: [imageInventory()],
  });
  assert.equal(verifyImageCoverage(input(), imageEnvironment()).packages, 4);
  for (const mutate of [
    (v) => {
      v.Results[0].Packages = [];
    },
    (v) => {
      delete v.Results[0].Packages;
    },
    (v) => {
      v.Results[0].Packages.pop();
    },
    (v) => {
      v.Results[0].Packages[0].Version = "2.9.14";
    },
    (v) => {
      v.Results[0].Packages.push(v.Results[0].Packages[0]);
    },
    (v) => {
      v.Metadata.OS.Family = "debian";
    },
    (v) => {
      v.Metadata.OS.Eosl = true;
    },
  ]) {
    const value = input();
    mutate(value);
    assert.throws(() => verifyImageCoverage(value, imageEnvironment()));
  }
  assert.throws(() => verifyImageCoverage(input()), /IMAGE_ENVIRONMENT_MISSING/);
});

test("环境采集只对指定容器使用无 shell 的固定读回命令", async () => {
  const value = imageEnvironment();
  const commands = [];
  const docker = async (args) => {
    commands.push(args);
    assert.equal(args[0], "exec");
    assert.equal(args[1], "owned-container");
    if (args[2] === "node") return JSON.stringify(value);
    if (args[2] === "apk") return value.packages.join("\n");
    if (args[2] === "ldd") return value.linkedLibraries;
    throw new Error("UNEXPECTED_COMMAND");
  };
  const actual = await inspectImageEnvironment(docker, "owned-container");
  assert.deepEqual(actual.packages, [...value.packages].sort());
  assert.deepEqual(commands[1], ["exec", "owned-container", "apk", "--no-network", "info", "-v"]);
  assert.deepEqual(commands[2], ["exec", "owned-container", "ldd", "/usr/bin/clamscan"]);
});
