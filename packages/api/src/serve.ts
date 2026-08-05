import { Freehold, hashEmbedder, loadConfig, makeEmbedder, syncIndex } from "@freehold/core";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

async function main() {
  const home = process.env.FREEHOLD_HOME;
  const config = loadConfig(home);

  console.log(`[freehold] booting — home: ${home ?? "~/.freehold"}`);

  const fh = await Freehold.open(home);
  const embedder = config.embedder === "hash" ? hashEmbedder : makeEmbedder(config);

  await syncIndex(fh, embedder);

  // Load the embedding model now, not on the first search: the ONNX load
  // blocks the event loop for tens of seconds, and at boot nobody is waiting.
  embedder
    .embed(["warmup"])
    .then(() => console.log("[freehold] embedder ready"))
    .catch((err) => console.warn(`[freehold] embedder warmup failed: ${err}`));

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
