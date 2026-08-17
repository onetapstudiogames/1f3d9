import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.E2E_PORT ?? 41_739)
const baseURL = `https://127.0.0.1:${port}`
const mobile = process.env.E2E_MOBILE === 'true'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL,
    ignoreHTTPSErrors: true,
    // This suite handles disposable credentials. Never persist browser or
    // network recordings that could capture them, even when a test fails.
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{
    name: mobile ? 'mobile-chromium' : 'chromium',
    use: { ...devices[mobile ? 'Pixel 5' : 'Desktop Chrome'] },
  }],
  webServer: {
    command: 'node --experimental-strip-types e2e/oauth-test-server.ts',
    url: `${baseURL}/__e2e/health`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { E2E_PORT: String(port) },
  },
})
