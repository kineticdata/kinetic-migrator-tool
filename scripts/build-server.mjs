// Bundles the server into dist/server.mjs with esbuild's API (no shell
// quoting: the banner holds quotes and semicolons that cmd.exe and POSIX
// shells treat differently).
import { build } from 'esbuild';

await build({
  entryPoints: ['app/server/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/server.mjs',
  // Bundled CommonJS dependencies call require(); ESM has none.
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  logLevel: 'info',
});
