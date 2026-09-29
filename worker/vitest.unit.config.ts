import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// No wrangler config and no `main`: src/index.ts is never loaded, so pure-module
// tests can't be broken by half-written Durable Object code.
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2026-09-01',
        compatibilityFlags: ['nodejs_compat'],
      },
    }),
  ],
  test: {
    include: ['test/unit/**/*.test.ts'],
  },
});
