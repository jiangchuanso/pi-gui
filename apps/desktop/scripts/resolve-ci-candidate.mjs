import { appendFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const GITHUB_API = "https://api.github.com";
const REPOSITORY_PATTERN = /^[^/\s]+\/[^/\s]+$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const MAX_PAGES = 20;

async function responseMessage(response) {
  try {
    const body = await response.json();
    return typeof body?.message === "string" ? `: ${body.message}` : "";
  } catch {
    return "";
  }
}

async function fetchJson(fetchImpl, url, token, label) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch (error) {
    throw new Error(
      `GitHub ${label} lookup failed before an authoritative response: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `GitHub ${label} lookup returned HTTP ${response.status}${await responseMessage(response)}`,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`GitHub ${label} lookup returned unreadable JSON`);
  }
}

async function listWorkflowRuns({ fetchImpl, token, repository, workflow, commit }) {
  const runs = [];
  const endpoint = `${GITHUB_API}/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs`;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    // Pull requests report their synthetic merge commit as github.sha, so their
    // candidate artifacts can never match the tagged commit's artifact names.
    const url = `${endpoint}?head_sha=${commit}&exclude_pull_requests=true&per_page=100&page=${page}`;
    const body = await fetchJson(fetchImpl, url, token, "workflow-run");
    if (!Array.isArray(body?.workflow_runs)) {
      throw new Error("GitHub workflow-run lookup did not return a run list");
    }
    runs.push(...body.workflow_runs);
    if (body.workflow_runs.length < 100) {
      return runs;
    }
  }
  throw new Error(`GitHub workflow-run lookup exceeded ${MAX_PAGES} pages for ${commit}`);
}

async function listArtifacts({ fetchImpl, token, repository, runId }) {
  const artifacts = new Map();
  const endpoint = `${GITHUB_API}/repos/${repository}/actions/runs/${String(runId)}/artifacts`;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = await fetchJson(
      fetchImpl,
      `${endpoint}?per_page=100&page=${page}`,
      token,
      "workflow-artifact",
    );
    if (!Array.isArray(body?.artifacts)) {
      throw new Error("GitHub workflow-artifact lookup did not return an artifact list");
    }
    for (const artifact of body.artifacts) {
      if (typeof artifact?.name === "string") {
        artifacts.set(artifact.name, { id: artifact.id, expired: artifact.expired === true });
      }
    }
    if (body.artifacts.length < 100) {
      return artifacts;
    }
  }
  throw new Error(`GitHub workflow-artifact lookup exceeded ${MAX_PAGES} pages for run ${runId}`);
}

function isSuccessfulRun(run, commit) {
  return (
    run?.conclusion === "success" &&
    typeof run?.head_sha === "string" &&
    run.head_sha.toLowerCase() === commit.toLowerCase()
  );
}

/**
 * Find the successful run of the packaging workflow that produced the release
 * candidate artifacts for `commit`, so the tag pipeline can promote those exact
 * bytes instead of packaging the same commit a second time.
 */
export async function resolveCiCandidate({
  repository,
  workflow,
  commit,
  artifacts,
  token,
  fetchImpl = fetch,
}) {
  if (!REPOSITORY_PATTERN.test(repository ?? "")) {
    throw new Error(`Invalid GitHub repository: ${String(repository)}`);
  }
  if (typeof workflow !== "string" || workflow.length === 0 || workflow.includes("/")) {
    throw new Error(`Invalid workflow file name: ${String(workflow)}`);
  }
  if (!COMMIT_PATTERN.test(commit ?? "")) {
    throw new Error(`Candidate commit must be a 40-character Git SHA: ${String(commit)}`);
  }
  const required = Array.isArray(artifacts) ? artifacts : [];
  if (required.length === 0 || required.some((name) => typeof name !== "string" || !name)) {
    throw new Error("At least one required candidate artifact name is needed");
  }
  if (new Set(required).size !== required.length) {
    throw new Error(`Duplicate required candidate artifact: ${required.join(", ")}`);
  }
  if (!token) {
    throw new Error("GH_TOKEN is required for an authoritative workflow-run lookup");
  }

  const attempts = await listWorkflowRuns({ fetchImpl, token, repository, workflow, commit });
  const runs = attempts.filter((run) => isSuccessfulRun(run, commit));
  if (runs.length === 0) {
    throw new Error(
      `No successful ${workflow} run packaged ${commit}; wait for CI to pass on this commit before tagging it`,
    );
  }

  const seen = new Map();
  for (const run of runs) {
    const available = await listArtifacts({ fetchImpl, token, repository, runId: run.id });
    const missing = required.filter((name) => !available.has(name));
    if (missing.length === 0) {
      const expired = required.filter((name) => available.get(name).expired);
      if (expired.length > 0) {
        throw new Error(
          `Candidate artifacts of ${workflow} run ${String(run.id)} for ${commit} have expired: ${expired.join(", ")}; rerun that workflow to repackage this commit`,
        );
      }
      return { runId: run.id, artifactIds: required.map((name) => available.get(name).id) };
    }
    for (const name of missing) {
      seen.set(name, (seen.get(name) ?? 0) + 1);
    }
  }

  throw new Error(
    `No successful ${workflow} run for ${commit} published ${required.join(", ")} (missing in ${runs.length} run(s): ${[...seen.keys()].join(", ")}); repackage the commit in CI before releasing`,
  );
}

async function main() {
  const { values } = parseArgs({
    options: {
      workflow: { type: "string", default: "ci.yml" },
      commit: { type: "string" },
      artifact: { type: "string", multiple: true },
    },
  });

  const candidate = await resolveCiCandidate({
    repository: process.env.GITHUB_REPOSITORY ?? "",
    workflow: values.workflow,
    commit: values.commit ?? "",
    artifacts: values.artifact ?? [],
    token: process.env.GH_TOKEN ?? "",
  });

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    await appendFile(outputFile, `run-id=${String(candidate.runId)}\n`, "utf8");
  }
  console.log(
    `Promoting ${values.artifact.join(", ")} from ${values.workflow} run ${String(candidate.runId)} of ${values.commit}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
