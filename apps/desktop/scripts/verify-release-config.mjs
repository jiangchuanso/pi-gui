import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateConfiguration } from "app-builder-lib/out/util/config/config.js";
import { DebugLogger } from "builder-util";
import { parseDocument } from "yaml";
import { assertWorkflowActionPolicy, isAction } from "../../../scripts/workflow-action-policy.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(scriptDir, "..", "..", "..");
const linuxPackageCommand = "node scripts/run-electron-builder.mjs --linux --publish never";
const linuxDependencies = [
  "libgtk-3-0 | libgtk-3-0t64",
  "libnotify4",
  "libnss3",
  "libxss1",
  "libxtst6",
  "xdg-utils",
  "libatspi2.0-0 | libatspi2.0-0t64",
  "libuuid1",
  "libsecret-1-0",
  "libgbm1",
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function parseYaml(relativePath) {
  const filePath = path.join(repoDir, relativePath);
  const document = parseDocument(await readFile(filePath, "utf8"), { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(
      `${relativePath} is invalid YAML: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  }
  return document.toJS();
}

function stepNamed(job, name) {
  const step = job.steps?.find((candidate) => candidate.name === name);
  assert(step, `Missing workflow step "${name}"`);
  return step;
}

function runText(step) {
  return typeof step.run === "string" ? step.run : "";
}

function validateCiWorkflow(workflow) {
  const pushTrigger = workflow.on?.push ?? {};
  assert(
    !("tags" in pushTrigger) && !("tags-ignore" in pushTrigger),
    "CI must package a commit once: a tag push must promote the commit's packaging run instead of starting another one",
  );
  assert(
    workflow.on?.workflow_dispatch !== undefined,
    "CI must accept workflow_dispatch so a commit that never produced a run can still be packaged",
  );

  const versionCheck = stepNamed(workflow.jobs?.typecheck, "Verify release version consistency");
  assert(
    runText(versionCheck).includes("pnpm verify:release-version"),
    "CI must reject drift between product package versions",
  );

  const linuxJob = workflow.jobs?.["desktop-package-linux"];
  assert(linuxJob?.["runs-on"] === "ubuntu-latest", "Linux package CI must run on Ubuntu");
  assert(
    runText(stepNamed(linuxJob, "Verify Linux package configuration")).includes(
      "verify:release-config",
    ),
    "Linux package CI must validate release configuration before packaging",
  );
  assert(
    runText(stepNamed(linuxJob, "Package Linux AppImage and deb")).includes(
      "run package:linux:x64",
    ),
    "Linux x64 package CI must build the configured AppImage and deb targets",
  );
  assert(
    runText(stepNamed(linuxJob, "Verify Linux packages")).includes("verify-linux-release.sh") &&
      runText(stepNamed(linuxJob, "Verify Linux packages")).includes("--install"),
    "Linux package CI must run native archive and install lifecycle verification",
  );

  const packageVerification = stepNamed(linuxJob, "Verify Linux packages");
  const candidateStage = stepNamed(linuxJob, "Stage validated Linux candidate");
  assert(
    runText(candidateStage).includes("release-artifacts.mjs stage"),
    "Linux package CI must validate actual outputs through the candidate manifest helper",
  );

  const candidateUpload = stepNamed(linuxJob, "Upload immutable Linux CI candidate");
  assert(
    isAction(candidateUpload.uses, "actions/upload-artifact"),
    "Linux CI candidate must use upload-artifact",
  );
  assert(
    candidateUpload.with?.path === "apps/desktop/release-candidate/",
    "Linux CI candidate upload must use only the staged file set",
  );
  assert(
    candidateUpload.with?.["if-no-files-found"] === "error",
    "Linux CI candidate upload must fail if staging produced no files",
  );
  assert(
    candidateUpload.with?.overwrite !== true,
    "Linux CI candidate upload must remain immutable",
  );

  const windowsJob = workflow.jobs?.["desktop-package-windows"];
  assert(windowsJob?.["runs-on"] === "windows-latest", "Windows package CI must run on Windows");
  assert(
    !JSON.stringify(windowsJob).includes("WINDOWS_CSC_"),
    "Unsigned Windows releases must not depend on signing secrets",
  );
  assert(
    runText(stepNamed(windowsJob, "Package Windows installers")).includes("run package:win") &&
      !JSON.stringify(windowsJob).includes("package:win:dir"),
    "Windows package CI must build the installers the tag pipeline promotes",
  );
  assert(
    runText(stepNamed(windowsJob, "Verify packaged runtime dependencies")).includes(
      "verify:packaged-runtime-deps:windows",
    ),
    "Windows package CI must verify the packaged runtime dependencies",
  );
  const windowsVerification = stepNamed(windowsJob, "Verify Windows packages and architecture");
  assert(
    runText(windowsVerification).includes("-SmokePackages"),
    "Windows package CI must smoke-test both downloadable packages",
  );
  const windowsStage = stepNamed(windowsJob, "Stage validated Windows candidate");
  assert(
    runText(windowsStage).includes("release-artifacts.mjs stage"),
    "Windows package CI must validate actual outputs through the candidate manifest helper",
  );
  const windowsUpload = stepNamed(windowsJob, "Upload immutable Windows CI candidate");
  assert(
    isAction(windowsUpload.uses, "actions/upload-artifact") &&
      windowsUpload.with?.path === "apps/desktop/release-candidate/",
    "Windows CI candidate must upload the staged file set",
  );
  assert(
    windowsUpload.with?.["if-no-files-found"] === "error",
    "Windows CI candidate upload must fail when staging produced no files",
  );
  assert(
    windowsUpload.with?.overwrite !== true,
    "Windows CI candidate upload must remain immutable",
  );

  const proofUpload = stepNamed(linuxJob, "Upload Linux package proof");
  assert(
    isAction(proofUpload.uses, "actions/upload-artifact") &&
      proofUpload.with?.path === "apps/desktop/release-proof/linux/",
    "Linux CI must retain native package proof logs separately",
  );
  assert(
    Number(candidateUpload.with?.["retention-days"]) >= 90,
    "CI must retain the promoted candidates long enough for a later tag",
  );
  assert(
    Number(windowsUpload.with?.["retention-days"]) >= 90,
    "CI must retain the promoted Windows candidate long enough for a later tag",
  );
  assert(
    Number(proofUpload.with?.["retention-days"]) >= 14,
    "Linux CI package proof must be retained for at least 14 days",
  );
  assert(
    linuxJob.steps.indexOf(packageVerification) < linuxJob.steps.indexOf(candidateStage) &&
      linuxJob.steps.indexOf(candidateStage) < linuxJob.steps.indexOf(candidateUpload),
    "Linux CI must complete native validation before staging and uploading a candidate",
  );
  assert(
    windowsJob.steps.indexOf(windowsVerification) < windowsJob.steps.indexOf(windowsStage) &&
      windowsJob.steps.indexOf(windowsStage) < windowsJob.steps.indexOf(windowsUpload),
    "Windows CI must complete native validation before staging and uploading a candidate",
  );

  const linuxArm64Job = workflow.jobs?.["desktop-package-linux-arm64"];
  assert(
    linuxArm64Job?.["runs-on"] === "ubuntu-24.04-arm",
    "Linux arm64 package CI must run on an arm64 Ubuntu runner",
  );
  const arm64Steps = linuxArm64Job.steps ?? [];
  const arm64Configuration = stepNamed(linuxArm64Job, "Verify Linux package configuration");
  const arm64Packaging = stepNamed(linuxArm64Job, "Package Linux AppImage and deb");
  const arm64Baseline = stepNamed(
    linuxArm64Job,
    "Verify Linux arm64 packages stay within the Kylin glibc baseline",
  );
  const arm64PackageVerification = stepNamed(linuxArm64Job, "Verify Linux packages");
  const arm64CandidateStage = stepNamed(linuxArm64Job, "Stage validated Linux candidate");
  const arm64CandidateUpload = stepNamed(linuxArm64Job, "Upload immutable Linux CI candidate");
  const arm64ProofUpload = stepNamed(linuxArm64Job, "Upload Linux package proof");
  assert(
    runText(arm64Configuration).includes("verify:release-config"),
    "Linux arm64 package CI must validate release configuration before packaging",
  );
  assert(
    runText(arm64Packaging).includes("docker run") &&
      runText(arm64Packaging).includes("node:22-bullseye") &&
      runText(arm64Packaging).includes("run package:linux:arm64"),
    "Linux arm64 packaging must build inside the Debian 11 (glibc 2.31) container so node-pty matches the Kylin V10 SP1 baseline",
  );
  assert(
    runText(arm64Baseline).includes("verify-linux-glibc-baseline.mjs") &&
      runText(arm64Baseline).includes("--max-glibc 2.31"),
    "Linux arm64 CI must enforce the packaged native modules' glibc baseline",
  );
  assert(
    runText(arm64PackageVerification).includes("verify-linux-release.sh") &&
      runText(arm64PackageVerification).includes("--install"),
    "Linux arm64 package CI must run native archive and install lifecycle verification",
  );
  assert(
    runText(arm64CandidateStage).includes("release-artifacts.mjs stage") &&
      runText(arm64CandidateStage).includes("--platform linux-arm64") &&
      arm64Steps.indexOf(arm64Packaging) < arm64Steps.indexOf(arm64Baseline) &&
      arm64Steps.indexOf(arm64Baseline) < arm64Steps.indexOf(arm64PackageVerification) &&
      arm64Steps.indexOf(arm64PackageVerification) < arm64Steps.indexOf(arm64CandidateStage) &&
      arm64Steps.indexOf(arm64CandidateStage) < arm64Steps.indexOf(arm64CandidateUpload),
    "Linux arm64 CI must build on the glibc baseline, then verify and stage in order",
  );
  assert(
    isAction(arm64CandidateUpload.uses, "actions/upload-artifact") &&
      arm64CandidateUpload.with?.path === "apps/desktop/release-candidate/" &&
      arm64CandidateUpload.with?.["if-no-files-found"] === "error" &&
      arm64CandidateUpload.with?.overwrite !== true &&
      Number(arm64CandidateUpload.with?.["retention-days"]) >= 90,
    "Linux arm64 CI candidate upload must be immutable and retained for a later tag",
  );
  assert(
    isAction(arm64ProofUpload.uses, "actions/upload-artifact") &&
      arm64ProofUpload.with?.path === "apps/desktop/release-proof/linux-arm64/" &&
      Number(arm64ProofUpload.with?.["retention-days"]) >= 14 &&
      !String(arm64ProofUpload.with?.name).startsWith("ci-release-"),
    "Linux arm64 CI must retain native package proof logs separately",
  );

  const candidates = {
    linux: "ci-release-linux-${{ github.sha }}",
    "linux-arm64": "ci-release-linux-arm64-${{ github.sha }}",
    windows: "ci-release-windows-${{ github.sha }}",
  };
  assert(
    candidateUpload.with?.name === candidates.linux &&
      arm64CandidateUpload.with?.name === candidates["linux-arm64"] &&
      windowsUpload.with?.name === candidates.windows,
    "CI candidate artifact names must be the exact names the tag pipeline promotes",
  );
  assert(
    !String(proofUpload.with?.name).startsWith("ci-release-"),
    "CI proof artifacts must not match the candidate promotion pattern",
  );
  return candidates;
}

function validateBuilderConfig(config, desktopPackage, afterRemoveSource) {
  assert(config.mac?.notarize === true, "electron-builder must notarize the macOS app");
  assert(
    config.dmg?.sign === true,
    "DMG must be signed for Gatekeeper primary-signature verification",
  );
  assert(
    config.win?.signAndEditExecutable === true,
    "Windows packaging must preserve executable icon and version metadata",
  );

  const targets = new Set((config.win?.target ?? []).map(({ target }) => target));
  assert(targets.has("nsis"), "Windows packaging must include NSIS");
  assert(targets.has("portable"), "Windows packaging must include portable");

  const setupName = "${productName}-${version}-${arch}-setup.${ext}";
  const portableName = "${productName}-${version}-${arch}-portable.${ext}";
  assert(config.nsis?.artifactName === setupName, `NSIS artifactName must be ${setupName}`);
  assert(
    config.portable?.artifactName === portableName,
    `portable artifactName must be ${portableName}`,
  );
  assert(
    config.nsis.artifactName !== config.portable.artifactName,
    "NSIS and portable artifacts must not share a filename",
  );

  assert(
    desktopPackage.homepage === "https://github.com/minghinmatthewlam/pi-gui",
    "Desktop package metadata must provide the Debian Homepage",
  );
  assert(
    desktopPackage.scripts?.["package:linux"]?.includes(linuxPackageCommand),
    "pnpm Linux packaging must keep the canonical Linux package command",
  );
  assert(
    desktopPackage.scripts?.["package:linux:x64"]?.includes(
      "node scripts/run-electron-builder.mjs --linux --x64 --publish never",
    ) &&
      desktopPackage.scripts?.["package:linux:arm64"]?.includes(
        "node scripts/run-electron-builder.mjs --linux --arm64 --publish never",
      ),
    "pnpm Linux packaging must build AppImage and deb for both x64 and arm64",
  );
  assert(
    desktopPackage.scripts?.["package:linux:dir"]?.includes(
      "node scripts/run-electron-builder.mjs --linux --dir --publish never",
    ),
    "pnpm Linux directory packaging must retry GitHub binary downloads",
  );
  assert(
    desktopPackage.scripts?.["package:win"]?.includes("package-windows.mjs") &&
      desktopPackage.scripts?.["package:win:dir"]?.includes("package-windows.mjs"),
    "pnpm Windows packaging must keep the canonical Windows packager",
  );

  assert(config.linux?.executableName === "pi-gui", "Linux executable name must remain pi-gui");
  assert(
    config.linux?.maintainer === "Matthew Lam <minghinmatthew.lam@gmail.com>",
    "Linux package maintainer must include an email address",
  );
  assert(
    config.linux?.synopsis === "Codex-style desktop app for the pi coding agent",
    "Linux package synopsis must remain explicit",
  );
  assert(
    JSON.stringify(config.linux?.target) === JSON.stringify(["AppImage", "deb"]),
    "Linux packaging must declare AppImage and deb; each build selects x64 or arm64 explicitly",
  );

  assert(
    config.deb?.artifactName === "${productName}_${version}_${arch}.${ext}",
    "Debian artifact naming must remain deterministic",
  );
  assert(config.deb?.packageName === "pi-gui", "Debian package name must remain pi-gui");
  assert(config.deb?.packageCategory === "devel", "Debian Section must remain devel");
  assert(config.deb?.priority === "optional", "Debian Priority must remain optional");
  assert(
    config.deb?.afterRemove === "resources/linux/after-remove.sh",
    "Debian packaging must use the corrected removal hook",
  );
  assert(
    JSON.stringify(config.deb?.depends) === JSON.stringify(linuxDependencies),
    "Debian dependencies must match the validated runtime dependency set",
  );
  assert(
    afterRemoveSource.includes(
      "update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'",
    ) &&
      !afterRemoveSource.includes(
        "update-alternatives --remove '${executable}' '/usr/bin/${executable}'",
      ),
    "Debian removal must unregister the alternatives target, not the link",
  );
}

function validateGithubDownloadRetry(retrySource, packageWindowsSource, runElectronBuilderSource) {
  assert(
    retrySource.includes("cannot resolve https:") &&
      retrySource.includes("github") &&
      retrySource.includes("50[234]"),
    "GitHub download retry must match electron-builder 502/503/504 errors",
  );
  assert(
    runElectronBuilderSource.includes("withGithubDownloadRetry") &&
      runElectronBuilderSource.includes("ELECTRON_BUILDER_CACHE"),
    "electron-builder runner must retry GitHub downloads and keep a local binary cache",
  );
  assert(
    packageWindowsSource.includes('from "./run-electron-builder.mjs"') &&
      packageWindowsSource.includes("runElectronBuilder"),
    "Windows packaging must use the retrying electron-builder runner",
  );
}

function validateWorkflow(workflow, candidates, linuxVerifierSource, windowsVerifierSource) {
  const jobs = workflow.jobs ?? {};
  const releasePreflight = jobs["release-preflight"];
  const versionCheck = stepNamed(releasePreflight, "Verify release tag and product versions");
  assert(
    runText(versionCheck).includes("verify-release-version.mjs") &&
      runText(versionCheck).includes('--tag "$GITHUB_REF_NAME"'),
    "Release preflight must require the exact tag across product package versions",
  );

  const serializedWorkflow = JSON.stringify(jobs);
  for (const marker of [
    "electron-builder",
    "package:linux",
    "package:win",
    "run-electron-builder.mjs",
    "package-windows.mjs",
  ]) {
    assert(
      !serializedWorkflow.includes(marker),
      `Tag pipeline must promote the CI candidates instead of packaging again (found ${marker})`,
    );
  }

  const resolveJob = jobs["resolve-candidate"];
  const resolveNeeds = resolveJob?.needs;
  const resolveNeedsList = Array.isArray(resolveNeeds)
    ? resolveNeeds
    : typeof resolveNeeds === "string"
      ? [resolveNeeds]
      : [];
  assert(
    resolveNeedsList.includes("release-preflight") && resolveNeedsList.includes("wait-for-ci"),
    "Candidate resolution must wait for release version preflight and for CI to package the commit",
  );
  assert(
    resolveJob.permissions?.actions === "read" && resolveJob.permissions?.contents === "read",
    "Candidate resolution must read workflow runs and artifacts without release write access",
  );
  assert(
    resolveJob.outputs?.["run-id"] === "${{ steps.resolve.outputs.run-id }}",
    "Candidate resolution must publish the packaging run id",
  );
  const promotedNames = Object.fromEntries(
    Object.entries(candidates).map(([platform, name]) => [
      platform,
      name.replace("${{ github.sha }}", "$GITHUB_SHA"),
    ]),
  );
  const resolveStep = stepNamed(resolveJob, "Resolve the CI-packaged candidates");
  assert(
    runText(resolveStep).includes("resolve-ci-candidate.mjs") &&
      runText(resolveStep).includes('--commit "$GITHUB_SHA"') &&
      Object.values(promotedNames).every((name) => runText(resolveStep).includes(name)),
    "Candidate resolution must require every CI candidate of the tagged commit",
  );

  const releaseSteps = Object.entries(jobs).flatMap(([jobName, job]) =>
    (job.steps ?? [])
      .filter(({ uses }) => isAction(uses, "softprops/action-gh-release"))
      .map((step) => ({ jobName, step })),
  );
  assert(releaseSteps.length === 1, "Release workflow must have exactly one GitHub release action");
  assert(
    releaseSteps[0].jobName === "stage-draft",
    "Only the draft staging job may upload release assets",
  );
  assert(workflow.permissions?.contents === "read", "Release workflow must default to read access");

  for (const marker of [
    "--appimage-extract",
    '"$extracted/AppRun"',
    '"$extracted/pi-gui"',
    "resources/app.asar",
    "dpkg-deb --info",
    "dpkg-deb --contents",
    "dpkg-deb --control",
    "dpkg-deb --raw-extract",
    "ELECTRON_RUN_AS_NODE=1",
    "native-node-pty-runtime.txt",
    "chrome-sandbox-owner-mode.txt",
    "xvfb-run",
    "apt-get install -y",
    "apt-get purge -y",
    "desktop-file-utils",
    "xauth",
    "xvfb",
  ]) {
    assert(linuxVerifierSource.includes(marker), `Linux package verifier must contain: ${marker}`);
  }

  for (const marker of [
    "Assert-ArtifactFile $setup",
    "Assert-ArtifactFile $portable",
    "Start-Process `",
    '"/S"',
    '"t", $setup',
    '"t", $portable',
    '"x", "-y"',
    '"app-*.7z"',
    "Assert-X64Pe $installedApp",
    "Assert-X64Pe $portableApp",
  ]) {
    assert(
      windowsVerifierSource.includes(marker),
      `Windows package verifier must contain: ${marker}`,
    );
  }

  const stageDraft = jobs["stage-draft"];
  assert(
    JSON.stringify(stageDraft.needs) === JSON.stringify(["resolve-candidate"]),
    "Draft staging must wait for the resolved CI candidates",
  );
  assert(
    stageDraft.permissions?.contents === "write" && stageDraft.permissions?.actions === "read",
    "Draft staging needs release write permission and candidate read access",
  );

  const download = stepNamed(stageDraft, "Download the CI-packaged candidates");
  assert(
    isAction(download.uses, "actions/download-artifact"),
    "Draft staging must download the packaged candidates",
  );
  assert(
    download.with?.pattern === "ci-release-*-${{ github.sha }}" &&
      download.with?.path === "release-candidate" &&
      download.with?.["merge-multiple"] === true,
    "Draft staging must merge exactly the promoted candidate artifacts",
  );
  assert(
    download.with?.["run-id"] === "${{ needs.resolve-candidate.outputs.run-id }}" &&
      download.with?.["github-token"] === "${{ github.token }}",
    "Draft staging must download from the resolved packaging run",
  );
  for (const platform of Object.keys(candidates)) {
    assert(
      /^ci-release-[a-z0-9-]+-\$\{\{ github\.sha \}\}$/.test(candidates[platform]),
      `Promoted ${platform} candidate names must stay bound to the committed sha`,
    );
  }

  const steps = stageDraft.steps ?? [];
  const candidateIndex = steps.findIndex(
    ({ name }) => name === "Validate combined release candidate",
  );
  const stateCheck = stepNamed(stageDraft, "Check existing release state");
  const stateCheckIndex = steps.indexOf(stateCheck);
  const replaceStep = stepNamed(stageDraft, "Replace the existing release");
  const replaceIndex = steps.indexOf(replaceStep);
  const uploadIndex = steps.findIndex(({ uses }) => isAction(uses, "softprops/action-gh-release"));
  assert(
    candidateIndex >= 0 &&
      candidateIndex < stateCheckIndex &&
      stateCheckIndex < replaceIndex &&
      replaceIndex < uploadIndex,
    "Candidate validation, the fail-closed state lookup, and any authorized replacement must precede draft upload",
  );
  assert(
    runText(stateCheck).includes("github-release-state.mjs") &&
      !runText(stateCheck).includes("gh release view"),
    "Existing release lookup must use the fail-closed API state checker",
  );

  const dispatch = workflow.on?.workflow_dispatch;
  assert(
    dispatch?.inputs?.replace_release?.type === "boolean" &&
      dispatch.inputs.replace_release.default === false,
    "Replacing an existing release must be an explicit, opt-in dispatch input",
  );
  assert(
    stageDraft.env?.REPLACE_RELEASE === "${{ inputs.replace_release }}" &&
      runText(stateCheck).includes('"$REPLACE_RELEASE" = "true"') &&
      runText(stateCheck).includes("github-release-state.mjs --replace-release"),
    "Only a dispatch that asks for replacement may authorize the state checker to accept an existing release",
  );
  assert(
    typeof replaceStep.if === "string" &&
      replaceStep.if.includes("env.REPLACE_RELEASE == 'true'") &&
      replaceStep.if.includes("steps.release-state.outputs.state != 'absent'"),
    "Replacement must run only for an authorized dispatch that found an existing release",
  );
  assert(
    runText(replaceStep).includes("gh api") &&
      runText(replaceStep).includes("/releases/${{ steps.release-state.outputs.id }}") &&
      !runText(replaceStep).includes("--cleanup-tag"),
    "Replacement must delete exactly the known release and keep the tag",
  );
  assert(
    runText(replaceStep).includes("github-release-state.mjs"),
    "Replacement must fail closed unless the tag has no release left",
  );

  const release = releaseSteps[0].step;
  assert(release.with?.draft === true, "Release assets must be uploaded to a draft");
  assert(
    release.with?.fail_on_unmatched_files === true,
    "Draft upload must fail on unmatched artifact paths",
  );

  const draftVerifiers = [
    ["verify-draft-linux", "Verify draft Linux packages"],
    ["verify-draft-linux-arm64", "Verify draft Linux arm64 packages"],
    ["verify-draft-windows", "Verify draft Windows packages"],
  ];
  for (const [jobName, trustStep] of draftVerifiers) {
    const job = jobs[jobName];
    assert(job?.needs === "stage-draft", `${jobName} must wait for draft staging`);
    assert(
      job.permissions?.contents === "write",
      `${jobName} needs push access to read draft releases`,
    );
    assert(
      runText(stepNamed(job, "Download draft release")).includes("gh release download"),
      `${jobName} must download the draft release`,
    );
    assert(
      runText(stepNamed(job, "Verify draft manifests and bytes")).includes("--platform all"),
      `${jobName} must verify the complete draft byte set`,
    );
    stepNamed(job, trustStep);
  }
  assert(
    runText(stepNamed(jobs["verify-draft-linux"], "Verify draft Linux packages")).includes(
      "verify-linux-release.sh",
    ) &&
      runText(stepNamed(jobs["verify-draft-linux"], "Verify draft Linux packages")).includes(
        "--install",
      ),
    "Downloaded draft Linux packages must be installed and validated",
  );
  assert(
    runText(stepNamed(jobs["verify-draft-windows"], "Verify draft Windows packages")).includes(
      "-SmokePackages",
    ),
    "Downloaded draft Windows packages must be installed and extracted",
  );

  const publish = jobs.publish;
  assert(
    JSON.stringify(publish.needs) ===
      JSON.stringify(["verify-draft-linux", "verify-draft-linux-arm64", "verify-draft-windows"]),
    "Final publication must wait for all native draft trust checks",
  );
  assert(
    publish.environment === "release",
    "Final publication must use the release environment gate",
  );
  assert(
    publish.permissions?.contents === "write",
    "Final publication needs release write permission",
  );

  const publishSteps = publish.steps ?? [];
  const requireIndex = publishSteps.findIndex(({ name }) => name === "Require the validated draft");
  const revalidateIndex = publishSteps.findIndex(
    ({ name }) => name === "Revalidate draft bytes before publication",
  );
  const publishIndex = publishSteps.findIndex(({ name }) => name === "Publish validated draft");
  const publishedVerifyIndex = publishSteps.findIndex(
    ({ name }) => name === "Verify published release bytes",
  );
  assert(
    requireIndex >= 0 &&
      requireIndex < revalidateIndex &&
      revalidateIndex < publishIndex &&
      publishIndex < publishedVerifyIndex,
    "Draft state, bytes, publication, and public-byte verification must remain ordered",
  );
  assert(
    runText(publishSteps[requireIndex]).includes("github-release-state.mjs --require-draft"),
    "Final publication must fail closed unless the validated draft still exists",
  );
  assert(
    !JSON.stringify(publish).includes("--replace-release") &&
      !JSON.stringify(publish).includes("gh api"),
    "Final publication must never replace an existing release or delete a published one",
  );
  assert(
    runText(publishSteps[revalidateIndex]).includes("--platform all"),
    "Final publication must revalidate unchanged draft bytes",
  );
  assert(
    runText(publishSteps[publishIndex]).includes("--draft=false"),
    "Only the final gated job may publish the validated draft",
  );
  assert(
    runText(publishSteps[publishedVerifyIndex]).includes("--platform all"),
    "Published release bytes must be redownloaded and verified",
  );

  const draftClears = Object.entries(jobs).flatMap(([jobName, job]) =>
    (job.steps ?? []).filter((step) => runText(step).includes("--draft=false")).map(() => jobName),
  );
  assert(
    JSON.stringify(draftClears) === JSON.stringify(["publish"]),
    "Exactly one final job may clear the draft flag",
  );

  const writeJobs = Object.entries(jobs)
    .filter(([, job]) => job.permissions?.contents === "write")
    .map(([jobName]) => jobName);
  assert(
    JSON.stringify(writeJobs) ===
      JSON.stringify(["stage-draft", ...draftVerifiers.map(([jobName]) => jobName), "publish"]),
    "Only draft staging, draft verification, and final publication may have release write permission",
  );

  const publishedVerifiers = [
    ["verify-published-linux", "Verify published Linux packages"],
    ["verify-published-linux-arm64", "Verify published Linux arm64 packages"],
    ["verify-published-windows", "Verify published Windows packages"],
  ];
  for (const [jobName, trustStep] of publishedVerifiers) {
    const job = jobs[jobName];
    assert(job?.needs === "publish", `${jobName} must wait for publication`);
    assert(
      runText(stepNamed(job, "Download published release")).includes("gh release download"),
      `${jobName} must redownload the published release`,
    );
    assert(
      runText(stepNamed(job, "Verify published manifests and bytes")).includes("--platform all"),
      `${jobName} must verify the complete published byte set`,
    );
    stepNamed(job, trustStep);
  }
  assert(
    runText(stepNamed(jobs["verify-published-linux"], "Verify published Linux packages")).includes(
      "verify-linux-release.sh",
    ) &&
      runText(
        stepNamed(jobs["verify-published-linux"], "Verify published Linux packages"),
      ).includes("--install"),
    "Published Linux packages must be installed and validated",
  );
  assert(
    runText(
      stepNamed(jobs["verify-published-windows"], "Verify published Windows packages"),
    ).includes("-SmokePackages"),
    "Published Windows packages must be installed and extracted",
  );
}

const [
  builderConfig,
  ciWorkflow,
  workflow,
  linuxVerifierSource,
  windowsVerifierSource,
  desktopPackageSource,
  afterRemoveSource,
  retrySource,
  packageWindowsSource,
  runElectronBuilderSource,
] = await Promise.all([
  parseYaml("apps/desktop/electron-builder.yml"),
  parseYaml(".github/workflows/ci.yml"),
  parseYaml(".github/workflows/release.yml"),
  readFile(path.join(scriptDir, "verify-linux-release.sh"), "utf8"),
  readFile(path.join(scriptDir, "verify-windows-release.ps1"), "utf8"),
  readFile(path.join(scriptDir, "..", "package.json"), "utf8"),
  readFile(path.join(scriptDir, "..", "resources", "linux", "after-remove.sh"), "utf8"),
  readFile(path.join(scriptDir, "github-download-retry.mjs"), "utf8"),
  readFile(path.join(scriptDir, "package-windows.mjs"), "utf8"),
  readFile(path.join(scriptDir, "run-electron-builder.mjs"), "utf8"),
]);

await assertWorkflowActionPolicy(repoDir);
await validateConfiguration(builderConfig, new DebugLogger(false));
validateBuilderConfig(builderConfig, JSON.parse(desktopPackageSource), afterRemoveSource);
const candidates = validateCiWorkflow(ciWorkflow);
validateWorkflow(workflow, candidates, linuxVerifierSource, windowsVerifierSource);
validateGithubDownloadRetry(retrySource, packageWindowsSource, runElectronBuilderSource);
console.log("Release package and workflow configuration are valid.");
