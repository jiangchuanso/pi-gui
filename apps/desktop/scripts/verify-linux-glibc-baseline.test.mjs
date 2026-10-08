import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyGlibcBaseline } from "./verify-linux-glibc-baseline.mjs";

const script = fileURLToPath(new URL("./verify-linux-glibc-baseline.mjs", import.meta.url));

function elfWith(...symbols) {
  return Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]),
    Buffer.from(`\n${symbols.join("\n")}\n`, "latin1"),
  ]);
}

async function createRelease(structure) {
  const releaseDir = await mkdtemp(path.join(os.tmpdir(), "pi-gui-glibc-baseline-"));
  const unpacked = path.join(releaseDir, "linux-arm64-unpacked");
  await mkdir(unpacked, { recursive: true });
  for (const [relativePath, contents] of Object.entries(structure)) {
    const filePath = path.join(unpacked, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
  }
  return releaseDir;
}

test("accepts packaged binaries within the baseline", async () => {
  const releaseDir = await createRelease({
    electron: elfWith("GLIBC_2.17", "GLIBC_2.25"),
    "resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node": elfWith(
      "GLIBC_2.31",
      "GLIBCXX_3.4.28",
    ),
    "latest-linux-arm64.yml": Buffer.from("version: 1.0.1\n", "utf8"),
  });

  const result = await verifyGlibcBaseline({ releaseDir });
  assert.deepEqual(result.violations, []);
  assert.equal(result.scanned, 2);
});

test("rejects a native module built against a newer glibc", async () => {
  const releaseDir = await createRelease({
    "resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node": elfWith(
      "GLIBC_2.39",
      "GLIBCXX_3.4.32",
    ),
  });

  const result = await verifyGlibcBaseline({ releaseDir });
  assert.equal(result.violations.length, 2);
  assert.match(result.violations.join("\n"), /GLIBC_2\.39 > 2\.31/);
  assert.match(result.violations.join("\n"), /GLIBCXX_3\.4\.32 > 3\.4\.28/);
});

test("ignores non-ELF payloads and fails closed without an unpacked directory", async () => {
  const releaseDir = await createRelease({
    "resources/app.asar": Buffer.from("not an elf but mentions GLIBC_2.99\n", "utf8"),
  });
  const result = await verifyGlibcBaseline({ releaseDir });
  assert.equal(result.scanned, 0);
  assert.deepEqual(result.violations, []);

  const emptyDir = await mkdtemp(path.join(os.tmpdir(), "pi-gui-glibc-empty-"));
  await assert.rejects(() => verifyGlibcBaseline({ releaseDir: emptyDir }));
});

test("CLI exit status reflects the baseline result", async () => {
  const passing = await createRelease({ electron: elfWith("GLIBC_2.31") });
  const failing = await createRelease({ electron: elfWith("GLIBC_2.34") });

  for (const [releaseDir, status] of [
    [passing, 0],
    [failing, 1],
  ]) {
    const result = spawnSync(process.execPath, [script, "--dir", releaseDir], { encoding: "utf8" });
    assert.equal(result.status, status, result.stderr);
    if (status === 1) {
      assert.match(result.stderr, /exceed the glibc baseline/);
    }
  }
});
