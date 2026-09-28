/**
 * vitest globalSetup for the integration project: bundle the server once (build/dev/index.js) so
 * the end-to-end tests spawn the compiled server built from the current source.
 */
import { buildDev } from '../scripts/build-dev.mjs';

export default async function setup(): Promise<void> {
  await buildDev();
}
