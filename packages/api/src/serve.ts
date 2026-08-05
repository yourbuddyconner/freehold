import { Freehold, hashEmbedder, loadConfig, makeEmbedder, syncIndex } from "@freehold/core";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

async function main() {
  const home = process.env.FREEHOLD_HOME;
  const config = loadConfig(home);

  console.log(`[freehold] booting — home: ${home ?? "~/.freehold"}`);

  const fh = await Freehold.open(home);
  const embedder = config.embedder === "hash" ? hashEmbedder : makeEmbedder(config);

  // Listen first; sync and model warmup run in the background. Embedding
  // happens in a worker thread, so the daemon stays responsive while the
  // index catches up — recently written items appear in listings as the
  // sync reaches them.
  embedder
    .embed(["warmup"])
    .then(() => console.log("[freehold] embedder ready"))
    .catch((err) => console.warn(`[freehold] embedder warmup failed: ${err}`));
  syncIndex(fh, embedder)
    .then(() => console.log("[freehold] index in sync"))
    .catch((err) => console.warn(`[freehold] index sync failed: ${err}`));

  const app = createApp(fh, embedder, config);

  serve(
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

main().catch((err) => {
  console.error("[freehold] fatal:", err);
  process.exit(1);
});
