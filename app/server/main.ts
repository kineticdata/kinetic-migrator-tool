// Server entry point (placeholder; the real server arrives in Phase 2).
import { HOST, DEV_PORT } from './config.ts';

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  console.log(`kinetic-migrate server scaffold (${HOST}:${DEV_PORT})`);
}
