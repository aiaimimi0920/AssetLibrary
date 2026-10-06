import { imagePackages } from "../scripts/scanner-image-environment.mjs";

export function imageEnvironment() {
  return {
    osRelease: "ID=alpine\nVERSION_ID=3.24.2\n",
    node: "24.18.1",
    packages: [...imagePackages],
    linkedLibraries: "libxml2.so.2 => /usr/lib/libxml2.so.2 (0x1234)",
    binaries: Object.fromEntries(
      [
        "/usr/bin/node",
        "/usr/bin/clamscan",
        "/usr/lib/libclamav.so.12",
        "/usr/lib/libxml2.so.2",
      ].map((name) => [name, { path: name, sha256: "a".repeat(64) }]),
    ),
  };
}

export function imageInventory() {
  return {
    Class: "os-pkgs",
    Type: "alpine",
    Packages: imagePackages.map((entry) => {
      const [, Name, Version] = entry.match(/^(.+?)-(\d.*)$/);
      return { Name, Version };
    }),
    Vulnerabilities: [],
  };
}
