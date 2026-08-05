# Governed review surface: multi-graph freehold, code viewer, git-proposal Inbox, GitHub connector

Date: 2026-08-04
Status: approved design, pre-implementation
Upstream program design: allod repo, `docs/superpowers/specs/2026-08-04-governed-code-review-design.md` (milestones 1-3 shipped there; this document is milestone 4, which lives in freehold plus a bounded set of allod-side changes).

## Goal

Freehold becomes the review surface for governed git repositories: it opens
repo governance graphs alongside its memory graph, renders the derived code
graph with classification controls, lists undecided commits as proposals
with checklist and blast radius, signs decisions into
`refs/notes/allod-decisions`, and connects to GitHub for events and
comment ingest.

Decisions fixed during design:

- Viewer role: browse + govern — classification from the UI (basis
  `manual`), not read-only.
- Graph access: multi-graph daemon (registry + per-graph services), not a
  second daemon instance and not a read-only mirror.
- Scope: all four sub-projects in this milestone, ordered 1→2→3→4.
- Decisions auto-push to origin on approve, controlled by a per-graph
  setting (default on when the checkout has a remote); push failure
  renders as decision-saved-locally with retry, never silent.
- Key storage: `KeyBackend` abstraction; `file` (relocated out of the
  repo) and macOS Keychain (Touch ID-gated) backends in this milestone;
  YubiKey PIV (firmware 5.7+) specified as a future backend behind the
  same interface. FIDO2/WebAuthn passkeys are structurally out: allod
  signatures are raw ed25519 and those authenticators sign only their own
  challenge envelopes; Secure Enclave is P-256-only.
- GitHub comment sync stays one-way ingest (program-design decision).

## Sub-project 1: foundation — multi-graph daemon + key backends + wasm surface

**Status: shipped 2026-08-05**

**Deviations from design:**

- `@allod/core` is declared as a `link:` dependency pointing at the local allod checkout (`link:../../../../allod/packages/core`). This is a LOCAL DEV ONLY configuration. Swap to a published release tarball before push or CI.
- The `review` ontology is vendored in `packages/core/assets/review-ontology.yaml` with the `imports:` block stripped. The wasm `install_package` path does not process cross-package imports and requires the document to start with `ontology:`. The strip is applied at registration time by `GraphManager.registerRepo`.
- Engine facts for SP3 (code viewer + Inbox): the wasm engine enforces node type resolution at commit time. The `code` and `eng` ontologies must be installed in a repo graph before creating nodes typed `code/SourceFile@1` or `eng/ChangeRequest@1`, and before creating `reviews` or `concerns` edges that reference those typed targets. The `review` ontology alone is not sufficient. Install code, then eng (in that order, because eng edge types reference code node types). Node endpoints must be committed and admitted before edges that reference them can be committed in a separate changeset.

### GraphManager (packages/core)

A `graphs` registry persisted in freehold's PGlite:
`{ id, name, path, kind: memory | repo, autoPushNotes, embedder: hash | semantic }`.
Each entry owns a `Freehold` instance — wasm graph handle, `withGraph`
mutex, PGlite index tables scoped by graph id. The existing memory graph
is the seeded default entry with unchanged behavior. Repo graph
registration validates `<path>/.allod/graph.yaml`, records the `origin`
remote for later GitHub linkage, installs the `review` ontology package
into the graph if absent (via the install-schema path), and indexes with
the hash embedder by default (semantic embedding is per-graph opt-in;
embedding thousands of code nodes at registration is not acceptable
registration latency). Repo graphs are the only place freehold shells to
`git` (notes read/write, diff-tree, commit metadata, push).

### API and MCP

`/api/v1/graphs` (list, register, settings) and
`/api/v1/graphs/:id/...` mirroring the existing knowledge, governance,
and schema routes. Existing unscoped routes alias to the default graph;
the current console and MCP tools work unmodified. MCP tools gain an
optional `graph` parameter with the same defaulting.

### Console shell

A graph switcher with persisted selection. Existing areas render the
selected graph; memory-specific affordances hide for repo graphs; the
Code area (sub-project 2) appears only for repo graphs.

### KeyBackend (allod CLI + freehold)

Trait with two operations: resolve (principal name → signing capability)
and sign (message bytes → ed25519 signature). Backends:

- `file`: YAML keypair at `~/.local/share/allod/keys/<graph-id>/<name>.yaml`
  (graph id from `graph.yaml`); `.allod/keys/` remains a read fallback for
  existing graphs. `allod init` writes the `.gitignore` entry for
  `.allod/keys/` regardless, and new keys are created at the XDG path.
- `keychain` (macOS): the ed25519 secret stored as a Keychain item with
  biometric access control; retrieval prompts Touch ID; signing happens
  in-process after retrieval. A CLI command migrates a file key into the
  Keychain.
- `yubikey-piv` (deferred): raw ed25519 via PIV on firmware 5.7+ or the
  OpenPGP applet; same trait, landed later.

The allod CLI signs through the abstraction everywhere it currently loads
keys; freehold's decide path (native and git) signs through the same
abstraction so the console's approve action can trigger the biometric
prompt. The graph stores only public keys, as today — backends change
where secrets live, never the signature or verification format.

### wasm additions (allod repo, crates/allod-wasm)

- `git_checklist(repo_name, target_ref, ops)` → matched rules + reviewer
  requirements: binds `policy::evaluate_git` with the graph's state and
  registry as the derived context. `ops` is the (verb, path) list freehold
  computes by shelling `git diff-tree --no-renames` (first parent, `--root`
  for parentless commits — same determinism rules as the CLI).
- `git_satisfaction(subject, checklist, decisions)` → unmet list: binds
  `policy::reviewers_unmet`; `decisions` is the parsed content of the
  commit's note, supplied by freehold.
- `git_decision_record(subject, verdict, by)` → the signed decision
  record (subject `git:<sha>`, policy context, verdict, timestamp,
  signed decider) built exactly as `allod git decide` builds it; freehold
  appends it to the notes ref and pushes per the graph setting.

No git inside wasm; no policy logic in TypeScript. The same split as
CLI/CI: freehold supplies bytes only git can produce, wasm owns matching,
reach, and signatures.

## Sub-project 2: code viewer

**Status: shipped 2026-08-05**

**Deviations from design:**

- Blob link format is `git:HEAD:<path>` (using `/blob/HEAD/` path component) rather than the default-branch name. The daemon has no reliable way to resolve the default-branch name at index time without a live `git ls-remote` call; HEAD is used as a stable stand-in. Links are resolved to the correct commit on GitHub.
- The graph tab (React Flow neighborhood view) lives on the file page rather than as a separate tab in the Code area. The neighborhood is scoped to the selected file by default, matching the spec intent.
- `code/regions` resolves the repo name from `basename(graphDir)` — the filesystem directory name of the checkout — not from the graph registry id. Policy rules written with `repo: <basename>` match correctly; rules using other selectors are unaffected.
- A fifth endpoint `code/neighborhood?path=` is exposed under `/graphs/:id/` beyond the four endpoints specified (`code/tree`, `code/file`, `code/item`, `code/regions`). It returns the React Flow node and edge payload for the file-scoped neighborhood and is consumed by the graph tab on the file page.
- `git_checklist` is called with `refs/heads/main` hardcoded as the target ref; repos with a different default branch will receive incomplete region results.

A Code area for repo graphs, two-pane like the Memory workspace:

- Tree pane: file tree derived from `SourceFile` paths; language and
  classification chips; directories roll up the classifications beneath
  them.
- File page: path, language, `git:` blob ref (linked to the GitHub blob
  when the remote is known), classifications, declared items — each
  Function/Type with signature, span, classification chips, and an
  expandable blast radius (callers in / calls out via `calls` edges).
  Classify on files and items: taxonomy term picker, basis fixed
  `manual`, signed through the key backend, outcome in saved/pending
  vocabulary; held classifications appear in the Inbox.
- Graph tab: the existing React Flow machinery with code node types and
  `declares`/`calls` edges, scoped to the selected file's neighborhood by
  default. Whole-graph rendering is a non-goal (the allod graph carries
  ~3,900 derivation ops).
- Governed-paths panel: for each region-keyed policy rule, the paths
  currently in reach (server-side equivalent of the Rust `path_regions`),
  exposed at `code/regions`. Answers what touching a path costs in review
  requirements before any commit exists.

API: `code/tree`, `code/file?path=`, `code/item/:nodeId`, `code/regions`
under `/graphs/:id/`, all reading wasm state through the per-graph lock;
code search rides the per-graph index.

## Sub-project 3: git-proposal Inbox + decide-to-notes

- Enumeration: freehold lists the checkout's branch heads plus main's
  HEAD, evaluates each (wasm bindings + git-computed ops + note-read
  decisions), and shows undecided ones beside native proposals. No
  registration step: per §3.3 the commit is the proposal; the Inbox is a
  view over refs × decisions.
- Proposal card: commit metadata, per-role checklist with satisfied/unmet,
  touched paths with in-region badges, blast radius for touched Rust items
  (viewer components reused), and check-run status once the connector
  exists.
- Review artifacts: a `Review` (verdict + body) with path-anchored
  `ReviewComment`s, stored as native nodes under the `review` ontology;
  the decision record's basis references the review.
- Decide: `git_decision_record` through the key backend (Touch ID here if
  keychain), append to `refs/notes/allod-decisions`, auto-push per
  setting. Reject records verdict `reject` the same way.
- Stale-derivation honesty: diff paths with no `SourceFile` node are
  labeled not-yet-indexed with re-index guidance (`allod git index`),
  never silently shown as reachless.

## Sub-project 4: GitHub connector

One event-handler core behind two auth modes and two transports:

- Credential mode: token from `gh auth token`, fallback to the git
  credential helper; polling transport.
- App mode: valet dev-v2's manifest flow — server-built manifest,
  HMAC-signed state, browser form-POST to GitHub's app-creation page,
  `/app-manifests/{code}/conversions` exchange, credentials encrypted in
  PGlite (PEM, webhook secret, client secret; app id/slug as metadata),
  installation tokens minted with an app JWT and cached with an expiry
  margin; settings wizard with the webhook toggle gated on a configured
  public URL. Webhooks (`push`, `pull_request`, `pull_request_review`,
  `issue_comment`) validated by `X-Hub-Signature-256`; polling remains
  the fallback; a startup catch-up poll covers missed deliveries.
- Repo linkage: derived from the checkout's `origin` remote, confirmed at
  graph registration.
- Events: push/PR events refresh the proposal list; comment/review events
  ingest one-way as `ReviewComment` nodes with external provenance
  (GitHub actor as claimed identity, comment id as dedup key; edits
  update, deletions tombstone). Check-run status (including the
  governance check) is read and shown on proposal cards. No posting back
  to GitHub in this milestone.

## Error handling

- Missing signing key: governance actions disabled with the reason shown,
  per graph.
- Notes push rejected: decision stays local, visible retry; never silent.
- Registered checkout deleted or moved: that graph shows unavailable;
  others unaffected.
- Stale derived graph: see sub-project 3.
- Concurrency: all wasm access through the per-graph `withGraph` lock
  (the wasm-bindgen recursive-use crash class).
- wasm eval bindings validate input shapes and return structured errors.

## Testing

- GraphManager: registry CRUD, per-graph index isolation.
- wasm bindings: vitest interop tests asserting checklist / satisfaction /
  decision-record parity with the Rust CLI's outputs on a shared fixture
  repo (the `allod-substrate-git` fixture shapes).
- Viewer API: endpoint tests over a materialized fixture graph.
- Inbox e2e: scripted repo — branch touching a classified path → card
  shows the region requirement → decide → notes ref updated → re-eval
  green.
- Connector: webhook signature validation, poll/webhook parity (identical
  graph writes through both transports), ingest dedup under redelivery,
  mocked GitHub API.
- Key backends: file backend fully automated; keychain covered by a
  manual test checklist (CI has no keychain).

## Out of scope

- Posting review content back to GitHub (bidirectional sync).
- YubiKey PIV backend (specified above, built later).
- Whole-graph code visualization.
- Semantic embedding of code graphs by default (per-graph opt-in exists).
- Item-level extraction beyond Rust (file-level reach covers all
  languages; the extractor gap is an allod-side follow-on).
