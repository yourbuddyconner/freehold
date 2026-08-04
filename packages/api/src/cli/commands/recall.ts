import type { BaseOpts } from "../run.js";
import { handleError, makeClient, output } from "../run.js";

export interface RecallOpts extends BaseOpts {
  query: string;
}

export async function runRecall(opts: RecallOpts): Promise<void> {
  const client = makeClient(opts);
  try {
    const result = await client.recall(opts.query);
    output(result, opts.json, (d) => {
      const r = d as {
        results: Array<{ id: string; type: string; content?: unknown; score: number }>;
      };
      if (r.results.length === 0) {
        console.log("No results found.");
        return;
      }
      for (const item of r.results) {
        const preview =
          typeof item.content === "string"
            ? item.content.slice(0, 80)
            : JSON.stringify(item.content ?? "").slice(0, 80);
        console.log(`[${item.score.toFixed(3)}] ${item.type} — ${preview}`);
      }
    });
    process.exit(0);
  } catch (err) {
    handleError(err);
  }
}
