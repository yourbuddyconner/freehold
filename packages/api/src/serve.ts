import {
  GraphManager,
  deriveEncKey,
  getConnector,
  getSecret,
  hashEmbedder,
  loadConfig,
  makeAppClient,
  makeEmbedder,
  makeTokenClient,
  pollOnce,
  startPoller,
  syncIndex,
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
  manager
    .list()
    .then(async (entries) => {
      for (const entry of entries) {
        if (entry.kind !== "repo") continue;
        try {
          const fh = await manager.get(entry.id);
          const cfg = await getConnector(fh.db, entry.id);
          if (!cfg) continue;

          const encKey = deriveEncKey(config.token);

          // Catch-up poll at startup for webhook-enabled graphs (webhooks may have
          // fired while the daemon was down; run one poll to close the gap).
          if (cfg.webhooksEnabled) {
            let catchUpClient = null;
            if (cfg.mode === "credential") {
              const credToken = await getSecret(fh.db, entry.id, "credentialToken", encKey);
              if (credToken) {
                catchUpClient = makeTokenClient(credToken);
              }
            } else if (cfg.mode === "app") {
              catchUpClient = await makeAppClient({ db: fh.db, graphId: entry.id }, encKey).catch(
                () => null
              );
            }
            if (catchUpClient) {
              pollOnce(fh, cfg, catchUpClient).catch((e) =>
                console.error(`[connector] startup catch-up poll failed for ${entry.id}:`, e)
              );
            }
          }

          if (cfg.mode !== "credential" && cfg.mode !== "app") continue;

          const handle = startPoller(
            fh,
            async () => getConnector(fh.db, entry.id),
            async () => {
              const latestCfg = await getConnector(fh.db, entry.id);
              if (!latestCfg) throw new Error(`no connector config for graph ${entry.id}`);
              if (latestCfg.mode === "credential") {
                const token = await getSecret(fh.db, entry.id, "credentialToken", encKey);
                if (!token) throw new Error(`no stored token for graph ${entry.id}`);
                return makeTokenClient(token);
              }
              if (latestCfg.mode === "app") {
                const client = await makeAppClient({ db: fh.db, graphId: entry.id }, encKey);
                if (!client) throw new Error(`app client not available for graph ${entry.id}`);
                return client;
              }
              throw new Error(`unsupported connector mode ${latestCfg.mode}`);
            }
          );
          pollerHandles.push(handle);
          console.log(`[freehold] connector poller started for graph ${entry.id}`);
        } catch (err) {
          console.warn(`[freehold] connector poller start failed for ${entry.id}: ${err}`);
        }
      }
    })
    .catch((err) => {
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
