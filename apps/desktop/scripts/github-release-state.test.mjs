import assert from "node:assert/strict";
import test from "node:test";
import { checkGithubReleaseState } from "./github-release-state.mjs";

const baseOptions = {
  repository: "minghinmatthewlam/pi-gui",
  tag: "v0.1.0-beta.34",
  token: "test-token",
};

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sequenceFetch(...responses) {
  let index = 0;
  return async () => {
    const response = responses[index];
    index += 1;
    if (response instanceof Error) {
      throw response;
    }
    assert(response, `Unexpected request ${index}`);
    return response;
  };
}

test("accepts an authoritative 404 when no release may exist yet", async () => {
  const result = await checkGithubReleaseState({
    ...baseOptions,
    fetchImpl: sequenceFetch(jsonResponse(404, { message: "Not Found" }), jsonResponse(200, [])),
  });
  assert.deepEqual(result, { state: "absent" });
});

test("accepts an existing draft only when publication requires it", async () => {
  const requests = [];
  const result = await checkGithubReleaseState({
    ...baseOptions,
    requireDraft: true,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return requests.length === 1
        ? jsonResponse(404, { message: "Not Found" })
        : jsonResponse(200, [{ id: 59, tag_name: baseOptions.tag, draft: true }]);
    },
  });
  assert.deepEqual(result, { state: "draft", id: 59 });
  assert.equal(
    requests[0].url,
    "https://api.github.com/repos/minghinmatthewlam/pi-gui/releases/tags/v0.1.0-beta.34",
  );
  assert.equal(
    requests[1].url,
    "https://api.github.com/repos/minghinmatthewlam/pi-gui/releases?per_page=100&page=1",
  );
  assert.equal(requests[1].options.headers.Authorization, "Bearer test-token");
});

test("rejects an existing draft before the sole asset upload", async () => {
  await assert.rejects(
    checkGithubReleaseState({
      ...baseOptions,
      fetchImpl: sequenceFetch(
        jsonResponse(404, { message: "Not Found" }),
        jsonResponse(200, [{ id: 59, tag_name: baseOptions.tag, draft: true }]),
      ),
    }),
    /already exists; refusing to replace its assets/,
  );
});

test("rejects an already-published release", async () => {
  await assert.rejects(
    checkGithubReleaseState({
      ...baseOptions,
      fetchImpl: async () => jsonResponse(200, { id: 59, tag_name: baseOptions.tag, draft: false }),
    }),
    /already published/,
  );
});

test("reports an authored replacement of a published release", async () => {
  const result = await checkGithubReleaseState({
    ...baseOptions,
    replaceRelease: true,
    fetchImpl: async () => jsonResponse(200, { id: 59, tag_name: baseOptions.tag, draft: false }),
  });
  assert.deepEqual(result, { state: "published", id: 59 });
});

test("reports an authored replacement of a leftover draft", async () => {
  const result = await checkGithubReleaseState({
    ...baseOptions,
    replaceRelease: true,
    fetchImpl: sequenceFetch(
      jsonResponse(404, { message: "Not Found" }),
      jsonResponse(200, [{ id: 59, tag_name: baseOptions.tag, draft: true }]),
    ),
  });
  assert.deepEqual(result, { state: "draft", id: 59 });
});

test("still proves an absent release when replacement is authorized", async () => {
  const result = await checkGithubReleaseState({
    ...baseOptions,
    replaceRelease: true,
    fetchImpl: sequenceFetch(jsonResponse(404, { message: "Not Found" }), jsonResponse(200, [])),
  });
  assert.deepEqual(result, { state: "absent" });
});

test("refuses to combine replacement with the final publication gate", async () => {
  await assert.rejects(
    checkGithubReleaseState({
      ...baseOptions,
      requireDraft: true,
      replaceRelease: true,
      fetchImpl: sequenceFetch(jsonResponse(404, { message: "Not Found" })),
    }),
    /cannot be combined with replacing a release/,
  );
});

test("fails closed on a replaceable release without a usable id", async () => {
  await assert.rejects(
    checkGithubReleaseState({
      ...baseOptions,
      replaceRelease: true,
      fetchImpl: async () => jsonResponse(200, { tag_name: baseOptions.tag, draft: false }),
    }),
    /valid release id/,
  );
  await assert.rejects(
    checkGithubReleaseState({
      ...baseOptions,
      replaceRelease: true,
      fetchImpl: sequenceFetch(
        jsonResponse(404, { message: "Not Found" }),
        jsonResponse(200, [{ id: 0, tag_name: baseOptions.tag, draft: true }]),
      ),
    }),
    /valid release id/,
  );
});

test("fails closed on transport, auth, rate-limit, and API errors", async () => {
  await assert.rejects(
    checkGithubReleaseState({
      ...baseOptions,
      fetchImpl: async () => {
        throw new Error("socket closed");
      },
    }),
    /before an authoritative response/,
  );

  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(
      checkGithubReleaseState({
        ...baseOptions,
        fetchImpl: async () => jsonResponse(status, { message: `status ${status}` }),
      }),
      new RegExp(`HTTP ${status}`),
    );
  }

  await assert.rejects(
    checkGithubReleaseState({
      ...baseOptions,
      fetchImpl: sequenceFetch(
        jsonResponse(404, { message: "Not Found" }),
        jsonResponse(403, { message: "rate limited" }),
      ),
    }),
    /draft-release lookup returned HTTP 403/,
  );
});

test("fails closed on malformed success responses", async () => {
  await assert.rejects(
    checkGithubReleaseState({
      ...baseOptions,
      fetchImpl: async () => jsonResponse(200, { id: 59 }),
    }),
    /malformed state/,
  );
  await assert.rejects(
    checkGithubReleaseState({
      ...baseOptions,
      fetchImpl: sequenceFetch(
        jsonResponse(404, { message: "Not Found" }),
        jsonResponse(200, [{ tag_name: baseOptions.tag, draft: true }]),
      ),
    }),
    /valid release id/,
  );
});

test("requires an existing draft before final publication", async () => {
  await assert.rejects(
    checkGithubReleaseState({
      ...baseOptions,
      requireDraft: true,
      fetchImpl: sequenceFetch(jsonResponse(404, { message: "Not Found" }), jsonResponse(200, [])),
    }),
    /Required draft release/,
  );
});

test("paginates authenticated release listings before finding the required draft", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    tag_name: `v0.0.${index}`,
    draft: false,
  }));
  const result = await checkGithubReleaseState({
    ...baseOptions,
    requireDraft: true,
    fetchImpl: sequenceFetch(
      jsonResponse(404, { message: "Not Found" }),
      jsonResponse(200, firstPage),
      jsonResponse(200, [{ id: 999, tag_name: baseOptions.tag, draft: true }]),
    ),
  });
  assert.deepEqual(result, { state: "draft", id: 999 });
});
