import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    // Keeps every test off the real search cache; the cache tests set their own TTLs.
    // Blank mail settings win over a real .env, so no test can wait for an address or send a real email.
    env: { SEARCH_CACHE_TTL_MS: "0", SEARCH_FALLBACK_CACHE_TTL_MS: "0", MAIL_USER: "", APP_PASSWORD: "" },
  },
});
