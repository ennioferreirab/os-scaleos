import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import capnwebValidate from 'capnweb-validate/vite'

/**
 * Tests run inside workerd (via vitest-pool-workers) so they exercise the same runtime APIs as
 * production -- e.g. Uint8Array.toHex/fromHex and crypto.subtle used by the sharing module. Most
 * tests import modules directly; the main Worker and a test-only SQLite DO binding support the
 * Overseer cost-persistence integration test without loading the full deployment configuration.
 */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: './src/server.ts',
      miniflare: {
        compatibilityDate: '2026-02-02',
        compatibilityFlags: ['experimental', 'nodejs_compat'],
        bindings: {
          ORG_ID: '10000000-0000-4000-8000-000000000001',
          BOOTSTRAP_ADMIN_SUB: '20000000-0000-4000-8000-000000000002',
          AUTH_PUBLIC_URL: 'https://auth.example.test',
          OS_PUBLIC_URL: 'https://os.example.test',
          SUPABASE_SECRET_KEY: 'test-secret-key-not-a-real-credential',
          DIRECTORY_SERVICE_TOKEN: 'test-directory-service-token',
        },
        kvNamespaces: ['BLUEPRINTS'],
        durableObjects: {
          TEST_OVERSEER: { className: 'OverseerDurableObject', useSQLite: true },
          TEST_ADMIN_SETTINGS: { className: 'AdminSettings', useSQLite: true },
          TEST_ORGANIZATION_DIRECTORY: {
            className: 'OrganizationDirectoryDurableObject',
            useSQLite: true,
          },
        },
      },
    }),
  ],
  test: {
    include: ['__tests__/*.test.ts'],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ['../../scripts/assert-workerd.ts'],
  },
})
