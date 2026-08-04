import type { BaseOpts } from "../run.js";
import { checkHeld, handleError, makeClient, output } from "../run.js";

export interface RememberOpts extends BaseOpts {
  content: string;
  agent: string;
}

export async function runRemember(opts: RememberOpts): Promise<void> {
  const client = makeClient(opts);
  try {
    const result = await client.remember({ agent: opts.agent, content: opts.content });
    checkHeld(result);
    output(result, opts.json, (d) => {
      const r = d as { status: string; noteId?: string; changeset?: string };
      console.log(`Remembered [${r.status}]`);
      if (r.noteId) console.log(`  Note ID:   ${r.noteId}`);
      if (r.changeset) console.log(`  Changeset: ${r.changeset}`);
    });
    process.exit(0);
  } catch (err) {
    handleError(err);
  }
}
