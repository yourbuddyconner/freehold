import type { BaseOpts } from "../run.js";
import { handleError, makeClient, output } from "../run.js";

export async function runStatus(opts: BaseOpts): Promise<void> {
  const client = makeClient(opts);
  try {
    const result = await client.health();
    output(result, opts.json, (d) => {
      const r = d as { status: string };
      console.log(`Freehold status: ${r.status}`);
    });
    process.exit(0);
  } catch (err) {
    handleError(err);
  }
}
