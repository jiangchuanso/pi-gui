import assert from "node:assert/strict";
import test from "node:test";
import { resolveCiCandidate } from "./resolve-ci-candidate.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OTHER_COMMIT = "fedcba9876543210fedcba9876543210fedcba98";
const LINUX = `ci-release-linux-${COMMIT}`;
const WINDOWS = `ci-release-windows-${COMMIT}`;
const RUNS_URL = `https://api.github.com/repos/minghinmatthewlam/pi-gui/actions/workflows/ci.yml/runs?head_sha=${COMMIT}&exclude_pull_requests=true&per_page=100&page=1`;

const baseOptions = {
  repository: "minghinmatthewlam/pi-gui",
  workflow: "ci.yml",
  commit: COMMIT,
  artifacts: [LINUX, WINDOWS],
  token: "test-token",
};

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function run(id, sha, conclusion = "success") {
  return { id, head_sha: sha, conclusion, status: "completed", event: "push" };
}

function runsResponse(runs) {
  return jsonResponse(200, { workflow_runs: runs });
}

function artifactsResponse(entries) {
  return jsonResponse(200, {
    artifacts: entries.map(([id, name, expired]) => ({ id, name, expired })),
  });
}

function artifactsUrl(runId) {
  return `https://api.github.com/repos/minghinmatthewlam/pi-gui/actions/runs/${runId}/artifacts?per_page=100&page=1`;
}

function routingFetch(routes) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    const response = routes[url];
    assert(response, `Unexpected request ${url}`);
    return typeof response === "function" ? response() : response;
  };
  return { fetchImpl, requests };
}

test("resolves the successful run that published both candidate artifacts", async () => {
  const { fetchImpl, requests } = routingFetch({
    [RUNS_URL]: runsResponse([run(11, OTHER_COMMIT, "failure"), run(12, COMMIT)]),
    [artifactsUrl(12)]: artifactsResponse([
      [31, LINUX, false],
      [32, WINDOWS, false],
    ]),
  });

  const result = await resolveCiCandidate({ ...baseOptions, fetchImpl });

  assert.deepEqual(result, { runId: 12, artifactIds: [31, 32] });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.headers.Authorization, "Bearer test-token");
});

test("skips successful runs whose candidates were replaced by an earlier run", async () => {
  const { fetchImpl } = routingFetch({
    [RUNS_URL]: runsResponse([run(21, COMMIT), run(20, COMMIT)]),
    [artifactsUrl(21)]: artifactsResponse([[41, LINUX, false]]),
    [artifactsUrl(20)]: artifactsResponse([
      [42, LINUX, false],
      [43, WINDOWS, false],
    ]),
  });

  const result = await resolveCiCandidate({ ...baseOptions, fetchImpl });

  assert.deepEqual(result, { runId: 20, artifactIds: [42, 43] });
});

test("fails closed when no successful run packages the commit", async () => {
  const { fetchImpl } = routingFetch({
    [RUNS_URL]: runsResponse([run(31, COMMIT, "failure")]),
  });

  await assert.rejects(
    resolveCiCandidate({ ...baseOptions, fetchImpl }),
    /No successful ci\.yml run packaged/,
  );
});

test("fails closed when a successful run stopped short of both candidates", async () => {
  const { fetchImpl } = routingFetch({
    [RUNS_URL]: runsResponse([run(41, COMMIT)]),
    [artifactsUrl(41)]: artifactsResponse([[51, LINUX, false]]),
  });

  await assert.rejects(
    resolveCiCandidate({ ...baseOptions, fetchImpl }),
    new RegExp(`No successful ci\\.yml run for ${COMMIT} published .*${WINDOWS}`),
  );
});

test("fails closed on expired candidates instead of prompting a rebuild", async () => {
  const { fetchImpl } = routingFetch({
    [RUNS_URL]: runsResponse([run(51, COMMIT)]),
    [artifactsUrl(51)]: artifactsResponse([
      [61, LINUX, true],
      [62, WINDOWS, false],
    ]),
  });

  await assert.rejects(
    resolveCiCandidate({ ...baseOptions, fetchImpl }),
    new RegExp(`have expired: ${LINUX}; rerun that workflow`),
  );
});

test("surfaces an unreadable workflow-run response", async () => {
  const { fetchImpl } = routingFetch({
    [RUNS_URL]: () => new Response("not json", { status: 200 }),
  });

  await assert.rejects(
    resolveCiCandidate({ ...baseOptions, fetchImpl }),
    /workflow-run lookup returned unreadable JSON/,
  );
});

test("rejects incomplete or ambiguous promotion requests", async () => {
  const unreachableFetch = async () => {
    throw new Error("A rejected promotion request must not call GitHub");
  };
  const cases = [
    [{ commit: "HEAD" }, /Candidate commit must be a 40-character Git SHA/],
    [{ repository: "pi-gui" }, /Invalid GitHub repository/],
    [{ workflow: "workflows/ci.yml" }, /Invalid workflow file name/],
    [{ artifacts: [] }, /At least one required candidate artifact name is needed/],
    [{ artifacts: [LINUX, LINUX] }, /Duplicate required candidate artifact/],
    [{ token: "" }, /GH_TOKEN is required/],
  ];

  for (const [overrides, expected] of cases) {
    await assert.rejects(
      resolveCiCandidate({ ...baseOptions, ...overrides, fetchImpl: unreachableFetch }),
      expected,
    );
  }
});
