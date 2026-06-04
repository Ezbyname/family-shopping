// playwright.config.js — Family Shopping E2E test configuration
import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,  // Firebase listeners need sequential access per test group
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : 1,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list'], ['html', { open: 'on-failure' }]],

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
    locale: 'he-IL',
    // Hebrew RTL — don't assume LTR element ordering
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },

  projects: [
    // Mobile-first: primary audience is Israeli mobile users
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'], locale: 'he-IL' },
    },
    // Desktop check
    {
      name: 'desktop-chrome',
      use: { ...devices['Desktop Chrome'], locale: 'he-IL' },
    },
    // iOS Safari (PWA installs)
    {
      name: 'mobile-safari',
      use: { ...devices['iPhone 13'], locale: 'he-IL' },
    },
  ],

  // Start a static server when running locally (no server in CI — uses deployed URL)
  webServer: process.env.CI ? undefined : {
    command: 'npx serve .. -l 3000 --no-clipboard',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 15_000,
  },
});
