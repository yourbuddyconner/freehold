/**
 * `freehold serve` — starts the daemon.
 *
 * We spawn a child process running serve.ts rather than importing it directly,
 * because serve.ts calls main() at module load and never returns.
 * Spawning lets the CLI own the process lifecycle cleanly.
 *
 * Alternatively, we re-implement the same logic here inline so we can
 * import the core modules directly. Since the CLI must NOT import @freehold/core,
 * we import from @freehold/api's app entry point instead.
 */

import {
  GraphManager,
  hashEmbedder,
  listGitProposals,
  loadConfig,
  makeEmbedder,
  syncIndex,
} from "@freehold/core";
import { serve as honoServe } from "@hono/node-server";
import { createApp } from "../../app.js";

// NOTE: serve command is the ONE exception to the "no @freehold/core in cli" rule —
// it must boot the server. The import-boundary test exempts serve.ts from the check.

export async function runServe(): Promise<void> {
  const home = process.env.FREEHOLD_HOME;
  const config = loadConfig(home);

  console.log(`[freehold] booting — home: ${home ?? "~/.freehold"}`);

  const manager = await GraphManager.open(home);
  const embedder = config.embedder === "hash" ? hashEmbedder : makeEmbedder(config);

  // Listen first; sync and model warmup run in the background. Embedding
  // happens in a worker thread, so the daemon stays responsive while the
  // index catches up — recently written items appear in listings as the
  // sync reaches them.
  embedder
    .embed(["warmup"])
    .then(() => console.log("[freehold] embedder ready"))
    .catch((err) => console.warn(`[freehold] embedder warmup failed: ${err}`));

  // Sync the default graph on boot
  manager
    .get(manager.defaultId())
    .then((fh) =>
      syncIndex(fh, embedder)
        .then(() => console.log("[freehold] index in sync"))
        .catch((err) => console.warn(`[freehold] index sync failed: ${err}`))
    )
    .catch((err) => console.warn(`[freehold] default graph open failed: ${err}`));

  const app = createApp(manager, embedder, config);

  honoServe(
    {
      fetch: app.fetch,
      hostname: "127.0.0.1",
      port: config.port,
    },
    (info) => {
      console.log(`[freehold] listening on http://127.0.0.1:${info.port}`);
    }
  );

  // Pre-warm the git-proposal cache for repo graphs so the first inbox or
  // review page load does not pay the cold checklist-evaluation cost.
  void (async () => {
    try {
      const entries = await manager.list();
      for (const entry of entries) {
        if (entry.kind !== "repo") continue;
        const fh = await manager.get(entry.id);
        const started = Date.now();
        await listGitProposals(fh);
        console.log(`[freehold] pre-warmed proposals for ${entry.id} in ${Date.now() - started}ms`);
      }
    } catch (err) {
      console.warn(
        `[freehold] proposal pre-warm failed: ${err instanceof Error ? err.message : err}`
      );
    }
  })();
}
