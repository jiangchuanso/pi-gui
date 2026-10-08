# CI baseline and adoption plan

The current design is renderer → narrow preload API → main-process app store →
Pi SDK driver → Pi runtime. Desktop UI state and Pi session state have separate
persistence owners. The first CI pass strengthens verification of this design;
it does not change those boundaries.

## Shared baseline

Run `pnpm check` locally and in the existing CI typecheck job. It runs:

1. `pnpm format:check`: pinned Prettier checks source, tests, scripts, styles,
   configuration, and Markdown. `pnpm format` fixes formatting locally. Generated
   output, lockfiles, dependencies, and local artifacts are excluded. The
   100-column print width is a wrapping target, not a hard length limit.
2. `pnpm lint`: builds shared package declarations first so a clean checkout
   has the same type information as a developer checkout, then runs ESLint correctness checks on app, package, video, test and helper
   source. It rejects debugger statements, async Promise executors, duplicate
   cases/keys, unreachable code and other configured errors. It does not format
   files or ban explicit `any`. Type-aware rules also reject unhandled/misused
   promises and unsafe assignment, argument, call, member access, and return
   operations on `any`. A bare `void` does not silence the promise rule.
   Compiler escape comments `@ts-nocheck` and `@ts-ignore` fail lint;
   `@ts-expect-error` requires a description. Guard tests compare pnpm's discovered
   workspaces with the real typed-lint configuration, so adding a workspace
   without typed-lint coverage fails the baseline. Generated-output exclusions
   are scoped to output locations, not similarly named folders inside source.
3. `pnpm check:architecture`: checks renderer runtime imports and reachable local
   helpers. It rejects Node, Electron, Pi runtime, and main/preload implementation
   dependencies. Explicit type-only imports and pure shared helpers remain valid.
4. `pnpm typecheck`: builds shared declarations, then checks every workspace,
   including the website, video source, and extension helper. It also checks both
   desktop extension examples. First, `check:workspaces` asks pnpm for
   its workspace list and rejects missing or empty typecheck scripts, so a new
   workspace cannot silently skip checking. This checks script presence, not
   whether a deliberately misleading script performs a real typecheck. Existing strict TypeScript settings
   remain in place.
5. `pnpm test:baseline`: guard tests, driver and extension-helper tests, both
   desktop extension examples and browser-bundle freshness, release-helper tests,
   and desktop unit tests (including failed-action state preservation).

Guard tests exercise the actual lint configuration with invalid and valid input.
They also run Playwright discovery with CI enabled and prove a focused `.only`
test fails while an ordinary test is discovered. Discovery launches no browser.
Root `pnpm e2e` delegates to the desktop core command, which builds first and
uses the canonical desktop Playwright configuration. The root Playwright config
shares that configuration instead of maintaining weaker independent defaults.

The Electron Core suite runs as a single job per platform. Pull
requests run it on Ubuntu under Xvfb and openbox with two Playwright workers, so
PRs don't queue for the account's few macOS runners. Pushes to `main` run it on
macOS with one worker, so macOS-only specs and regressions surface there, after
merge. The run must pass the stable `desktop-core` aggregate. A JSON report,
the file timing summary, and failure artifacts are retained. Discovery guards
still prove the suite splits into four `--shard=N/4` groups covering every test
exactly once, which is how the job would scale back out if run time required it.

Core includes credential-free local-extension and injected-event regression
coverage. Real-provider tests live in `tests/live`; real OS focus/clipboard
coverage lives in `tests/native`. Neither a stubbed event nor an all-skipped
provider suite establishes real-provider proof. Node-only tests, including
local Git worktree contracts, run in the baseline unit lane.

`pnpm verify:release-config` also enforces the GitHub Actions Node 24 allowlist
for every workflow. Guard tests cover that policy. Application Node stays 22;
action runtimes are a separate pin.

The website build, Linux installation/package and
Windows package jobs remain separate. `pnpm check` alone does not prove these
surfaces. Real-provider and native desktop verification retain their own lanes.
The final `CI required` job accepts only success from every required job.
See [merge enforcement](merge-enforcement.md) for its contract and remote
activation status. Repository branch rules must require this result before it
blocks merges; local tests alone do not establish remote enforcement.

CI is also the only place a release is packaged. `desktop-package-linux` (x64),
`desktop-package-linux-arm64` and `desktop-package-windows` stage and upload the
immutable candidate for their own commit (`ci-release-linux-<sha>`,
`ci-release-linux-arm64-<sha>` / `ci-release-windows-<sha>`, retained 90 days)
after native install/launch verification on the matching architecture. The arm64
candidate is built inside a Debian 11 (glibc 2.31) container so the compiled
`node-pty` native module loads on Kylin V10 SP1, whose glibc is 2.31; the
`verify-linux-glibc-baseline` guard fails the job if any packaged ELF needs a
newer glibc than that baseline.

Packaging runs on pushes to `main` and on an explicit `workflow_dispatch`, never
on tag pushes. A tag names a commit `main` already packaged, so filtering tags
into the packaging trigger would build that commit twice while the tag run and the
main run overlap. A tag push starts only the tag pipeline, which resolves the
successful packaging run of the tagged commit, downloads those exact bytes and
promotes them through draft, native and published verification, so a tagged
commit is never packaged twice. A tag whose commit has no successful packaging
run, or whose candidates have expired, fails closed instead of rebuilding;
rerun that commit's CI run to repackage it, or dispatch the packaging workflow for
a commit it never built.

Staging a draft also fails closed when the tag already has a release, so an
accidental rerun can never overwrite assets someone downloaded. Releasing the
same version again is an explicit operation: dispatch `release.yml` against the
tag with `replace_release: true`, and the pipeline deletes that release (draft or
published, and with it every published asset) before staging a fresh draft. A tag
push never carries the input, so a tag push alone cannot replace anything.

`ci.yml` also accepts `workflow_dispatch`, because a run can only start from an
event: a commit that never produced a run (a fork whose workflow registration
GitHub dropped, or a commit that never landed on `main`, for instance) has nothing
to rerun, and pushing it again emits no event. A dispatched run reports the
selected ref's commit as `github.sha`, so dispatching against a tag packages
exactly the commit that tag points at and the candidate names still match what the
tag pipeline promotes. The tag pipeline waits for the commit's packaging run
until one of its runs succeeds, which is the state candidate resolution requires;
it stops only when every run of the commit has already finished unsuccessfully,
and after a 15-minute grace period when the commit has no run at all, rather than
polling to its deadline. `verify:release-config` rejects a `ci.yml` push trigger
that filters tags, so the double packaging cannot return silently.

## Next decisions, in order

1. Strengthen IPC contracts: main and preload currently rely on annotations and
   casts. Keep one authoritative contract and validate meaningful external data
   boundaries. Avoid introducing a generic framework without a concrete need.
2. Validate saved JSON at its owning storage boundary, with regression tests
   proving invalid shapes fail clearly without overwriting existing data.
   The mandatory schema-skew test now fails if its required projection is absent;
   platform capability skips and credential-dependent lanes remain separate.

For every new rule, show a representative violation fail, restore a valid case,
and run the affected product lane. Retain clear evidence of passed, failed and
blocked coverage; a settings smoke does not establish a working conversation.

## Renderer architecture guard

`scripts/check-renderer-boundary.mjs` parses TypeScript syntax and uses the
renderer tsconfig to resolve imports. It follows local runtime imports and
re-exports through workspace aliases and `.js` specifiers pointing at TypeScript
source. Cycles are visited once. It checks resolved npm package identities too.

For example, renderer → shared barrel → helper → `node:fs` fails at the helper.
The repair is to request the operation through the preload API. A type-only
import from that same module is allowed because it loads no runtime code.

Literal dynamic imports and `require` calls are checked; computed module loading
fails because its destination cannot be established. Vite `import.meta.glob`
also fails; use literal imports so every dependency can be checked. Unresolved runtime imports
and runtime imports backed only by local declaration files also fail. Tests
prove representative forbidden imports fail and valid browser code passes.
Worker and SharedWorker module URLs are checked too. Use whole-statement
`import type` or `export type` for erased dependencies: inline type specifiers
can preserve module side effects under `verbatimModuleSyntax`, so the guard
treats those statements as runtime dependencies.

Scope: this checks first-party static module dependencies. It does not audit
third-party package internals, arbitrary runtime code evaluation, IPC payload
validation, or hostile changes to the guard itself. Review and repository rules
still need to protect the checks.
