import { defineConfig } from 'vitest/config';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  base: './',
  plugins: [
    nodePolyfills({
      include: ['buffer', 'events', 'util', 'process'],
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
  build: {
    target: 'es2022',
  },
  test: {
    environment: 'node',
    testTimeout: 30000,
  },
});
