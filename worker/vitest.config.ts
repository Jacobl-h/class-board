import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // Renamed so `env.BROWSER` is undefined in tests. A real binding would download and
        // launch Chrome on first use; screenshot tests inject a fake Shooter instead.
        browserRendering: { binding: 'UNUSED_BROWSER' },
        // Fixed test bindings. They override wrangler.jsonc vars and worker/.dev.vars, so
        // editing production values can't change what the tests see.
        bindings: {
          TEACHER_CODE: 'test-code',
          BOARD_ORIGIN: 'https://jacobl-h.github.io',
          PUBLIC_URL: 'http://localhost:8787',
          ALLOWED_ORIGINS: 'https://jacobl-h.github.io,http://localhost:5173',
          DAILY_MESSAGE_BUDGET: '2000000',
        },
      },
    }),
  ],
  test: {
    include: ['test/*.test.ts'],
    exclude: ['test/unit/**'],
  },
});
