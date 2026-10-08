// Vite configuration for the web app; builds to dist/web.
//
// Development (`npm run dev`): Vite serves the web app on WEB_DEV_PORT and
// proxies /api plus the launch link (`/?key=…`, which sets the session
// cookie) to the API server on DEV_PORT. The API server is started as a child
// process (tsx watch) unless KM_API=external, in which case run it yourself
// with `npm run dev:server`. KM_WORKSPACE picks the workspace folder.
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DEV_PORT, HOST } from '../server/config.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
const repo = fileURLToPath(new URL('../..', import.meta.url));
const WEB_DEV_PORT = 5173;
const apiTarget = `http://${HOST}:${DEV_PORT}`;

// Starts the API server next to Vite and prints the launch link on Vite's port.
function apiServer(): Plugin {
  let child: ChildProcess | null = null;
  const stop = () => {
    child?.kill();
    child = null;
  };
  return {
    name: 'kinetic-migrate-api',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      if (process.env.KM_API === 'external') return;
      stop();
      const tsx = createRequire(import.meta.url).resolve('tsx/cli');
      const args = [tsx, 'watch', '--clear-screen=false', 'app/server/main.ts', '--dev'];
      if (process.env.KM_WORKSPACE) args.push('--workspace', process.env.KM_WORKSPACE);
      child = spawn(process.execPath, args, { cwd: repo, stdio: ['ignore', 'pipe', 'inherit'] });
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (text: string) => {
        for (const line of text.split('\n')) {
          if (!line) continue;
          const m = line.match(/https?:\/\/[^/\s]+\/\?key=(\S+)/);
          if (m) server.config.logger.info(`\n  kinetic-migrate (dev): open http://localhost:${WEB_DEV_PORT}/?key=${m[1]}\n`);
          else process.stdout.write(`${line}\n`);
        }
      });
      server.httpServer?.once('close', stop);
      process.once('exit', stop);
    },
  };
}

export default defineConfig({
  root,
  plugins: [react(), apiServer()],
  css: { postcss: repo },
  server: {
    host: 'localhost',
    port: WEB_DEV_PORT,
    strictPort: true,
    proxy: {
      // changeOrigin gives the API server the Host it expects (127.0.0.1:<DEV_PORT>).
      '/api': { target: apiTarget, changeOrigin: true },
      '^/\\?key=': { target: apiTarget, changeOrigin: true },
    },
  },
  build: { outDir: fileURLToPath(new URL('../../dist/web', import.meta.url)), emptyOutDir: true },
});
