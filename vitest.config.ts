// Vitest configuration: web tests only (server tests run with node --test).
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  css: { postcss: '.' },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['app/web/**/*.test.{ts,tsx}'],
    setupFiles: ['app/web/src/test-setup.ts'],
  },
});
