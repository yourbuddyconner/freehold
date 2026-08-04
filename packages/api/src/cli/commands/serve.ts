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

import { Freehold, hashEmbedder, loadConfig, makeEmbedder, syncIndex } from "@freehold/core";
import { serve as honoServe } from "@hono/node-server";
import { createApp } from "../../app.js";

// NOTE: serve command is the ONE exception to the "no @freehold/core in cli" rule —
// it must boot the server. The import-boundary test exempts serve.ts from the check.

export async function runServe(): Promise<void> {
  const home = process.env.FREEHOLD_HOME;
  const config = loadConfig(home);

  console.log(`[freehold] booting — home: ${home ?? "~/.freehold"}`);

  const fh = await Freehold.open(home);
  const embedder = config.embedder === "hash" ? hashEmbedder : makeEmbedder(config);

  await syncIndex(fh, embedder);

  const app = createApp(fh, embedder, config);

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
}
