import { resolve } from 'node:path';

/** Load the repo-level .env (shared with the Python jobs), then api/.env if present.
 *  Imported by the database layer so the server and the tests read the same settings. */
for (const file of [resolve(process.cwd(), '..', '.env'), resolve(process.cwd(), '.env')]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // file not present: fine
  }
}
