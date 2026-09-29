import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.ts'],
    environmentOptions: {
      happyDOM: {
        // happy-dom 20 fetches an attached <iframe src> over the real network; tests must never do that.
        settings: { navigation: { disableChildFrameNavigation: true } },
      },
    },
  },
});
