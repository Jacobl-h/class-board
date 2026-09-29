import { defineConfig, devices } from '@playwright/test';

// Firefox and WebKit only run the focus-mode test (the Popover API is verified in Chromium only),
// and only when their browsers are installed: npx playwright install firefox webkit
const otherBrowsers = process.env.E2E_ALL_BROWSERS
  ? [
      { name: 'firefox', testMatch: /focus\.spec\.ts/, use: { ...devices['Desktop Firefox'] } },
      { name: 'webkit', testMatch: /focus\.spec\.ts/, use: { ...devices['Desktop Safari'] } },
    ]
  : [];

export default defineConfig({
  testDir: './tests',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 4,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }, ...otherBrowsers],
  webServer: [
    {
      // The Worker answers "/" with 404, so wait for the port; a `url` check would time out.
      command: 'npm run dev -w worker', // the script already passes --port 8787
      port: 8787,
      cwd: '..',
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'npm run dev -w web -- --port 5173 --strictPort',
      port: 5173,
      cwd: '..',
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
