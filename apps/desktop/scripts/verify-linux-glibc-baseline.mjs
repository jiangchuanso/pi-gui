import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The packaged Electron binaries only reference glibc 2.25 upwards, but node-pty has
// no Linux prebuild and is compiled by the packaging step, so its .node links against
// whatever glibc the build machine has. This guard fails the build when any packaged
// ELF requires a newer glibc than the oldest desktop target we ship for (Kylin V10 SP1
// ships glibc 2.31), which a newer build host would otherwise silently violate.
const CHUNK_SIZE = 4 * 1024 * 1024;
const OVERLAP = 64;
const UNPACKED_DIR_PATTERN = /^linux(?:-[\w]+)?-unpacked$/;

function parseVersion(value) {
  return value.split(".").map((part) => Number(part));
}

function compareVersions(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference < 0 ? -1 : 1;
    }
  }
  return 0;
}

function collectMaximum(current, candidate) {
  if (current === null || compareVersions(parseVersion(candidate), parseVersion(current)) > 0) {
    return candidate;
  }
  return current;
}

async function isElf(filePath) {
  const handle = await open(filePath, "r");
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, 4, 0);
    return (
      bytesRead === 4 &&
      header[0] === 0x7f &&
      header[1] === 0x45 &&
      header[2] === 0x4c &&
      header[3] === 0x46
    );
  } finally {
    await handle.close();
  }
}

async function scanElfVersions(filePath) {
  const result = { glibc: null, glibcxx: null };
  let carry = "";
  for await (const chunk of createReadStream(filePath, { highWaterMark: CHUNK_SIZE })) {
    const text = carry + chunk.toString("latin1");
    for (const match of text.matchAll(/GLIBC_(\d+\.\d+)/g)) {
      result.glibc = collectMaximum(result.glibc, match[1]);
    }
    for (const match of text.matchAll(/GLIBCXX_(\d+\.\d+\.\d+)/g)) {
      result.glibcxx = collectMaximum(result.glibcxx, match[1]);
    }
    carry = text.slice(-OVERLAP);
  }
  return result;
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

export async function verifyGlibcBaseline({
  releaseDir,
  maxGlibc = "2.31",
  maxGlibcxx = "3.4.28",
}) {
  const maxGlibcVersion = parseVersion(maxGlibc);
  const maxGlibcxxVersion = parseVersion(maxGlibcxx);

  const unpackedDirs = (await readdir(releaseDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && UNPACKED_DIR_PATTERN.test(entry.name))
    .map((entry) => path.join(releaseDir, entry.name));
  if (unpackedDirs.length === 0) {
    throw new Error(`No unpacked Linux application directory found in ${releaseDir}`);
  }

  const violations = [];
  const observedGlibc = [];
  const observedGlibcxx = [];
  let scanned = 0;

  for (const unpackedDir of unpackedDirs) {
    for (const filePath of await listFiles(unpackedDir)) {
      const fileStat = await stat(filePath);
      if (fileStat.size === 0 || !(await isElf(filePath))) {
        continue;
      }
      scanned += 1;
      const versions = await scanElfVersions(filePath);
      const relative = path.relative(releaseDir, filePath);
      if (versions.glibc !== null) {
        observedGlibc.push(`${relative} needs GLIBC_${versions.glibc}`);
        if (compareVersions(parseVersion(versions.glibc), maxGlibcVersion) > 0) {
          violations.push(`${relative} requires GLIBC_${versions.glibc} > ${maxGlibc}`);
        }
      }
      if (versions.glibcxx !== null) {
        observedGlibcxx.push(`${relative} needs GLIBCXX_${versions.glibcxx}`);
        if (compareVersions(parseVersion(versions.glibcxx), maxGlibcxxVersion) > 0) {
          violations.push(`${relative} requires GLIBCXX_${versions.glibcxx} > ${maxGlibcxx}`);
        }
      }
    }
  }

  return { scanned, violations, observedGlibc, observedGlibcxx };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument list near ${key ?? "<end>"}`);
    }
    options[key.slice(2)] = value;
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.dir) {
    throw new Error(
      "Usage: verify-linux-glibc-baseline.mjs --dir <release-dir> [--max-glibc 2.31] [--max-glibcxx 3.4.28]",
    );
  }
  const result = await verifyGlibcBaseline({
    releaseDir: path.resolve(options.dir),
    maxGlibc: options["max-glibc"],
    maxGlibcxx: options["max-glibcxx"],
  });

  console.log(`Scanned ${result.scanned} packaged ELF file(s) under ${path.resolve(options.dir)}`);
  for (const line of result.observedGlibc) {
    console.log(`  ${line}`);
  }
  for (const line of result.observedGlibcxx) {
    console.log(`  ${line}`);
  }
  if (result.violations.length > 0) {
    throw new Error(
      `Packaged Linux binaries exceed the glibc baseline:\n${result.violations.join("\n")}\nBuild them on the oldest supported baseline instead of the current host.`,
    );
  }
  console.log(
    `All packaged Linux binaries stay within glibc ${options["max-glibc"] ?? "2.31"} / GLIBCXX ${options["max-glibcxx"] ?? "3.4.28"}.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
