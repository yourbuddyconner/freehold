import {
  GraphManager,
  hashEmbedder,
  loadConfig,
  makeEmbedder,
  syncIndex,
  getConnector,
  makeTokenClient,
  deriveEncKey,
  getSecret,
  startPoller,
} from "@freehold/core";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

async function main() {
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

  // Start pollers for all registered repo graphs with credential-mode connector configs.
  // Each poller runs in the background; the daemon lifetime is the stop condition.
  const pollerHandles: Array<{ stop(): void }> = [];
  manager.list().then(async (entries) => {
    for (const entry of entries) {
      if (entry.kind !== "repo") continue;
      try {
        const fh = await manager.get(entry.id);
        const cfg = await getConnector(fh.db, entry.id);
        if (!cfg || cfg.mode !== "credential") continue;

        const encKey = deriveEncKey(config.token);
        const handle = startPoller(
          fh,
          async () => getConnector(fh.db, entry.id),
          async () => {
            const token = await getSecret(fh.db, entry.id, "webhookSecret", encKey);
            if (!token) throw new Error("no stored token for graph " + entry.id);
            return makeTokenClient(token);
          }
        );
        pollerHandles.push(handle);
        console.log(`[freehold] connector poller started for graph ${entry.id}`);
      } catch (err) {
        console.warn(`[freehold] connector poller start failed for ${entry.id}: ${err}`);
      }
    }
  }).catch((err) => {
    console.warn(`[freehold] connector poller boot failed: ${err}`);
  });

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
