// Local development commands; see packages/edge/src/local.ts.
import { main } from '../packages/edge/src/local.ts';

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
