import { settings } from "../config.ts";

const entries = new Map<string, { expires: number; value: Promise<unknown> }>();

// Shares in-flight and recent identical requests. Failures (null) are not kept, and every
// caller gets its own copy because tools mutate the listings they receive.
export async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const existing = entries.get(key);
  const entry = existing && existing.expires > now ? existing : { expires: now + settings.cacheTtlMs, value: load() };
  if (entry !== existing) {
    entries.set(key, entry);
    entry.value.then(
      (value) => {
        if (value == null && entries.get(key) === entry) entries.delete(key);
      },
      () => entries.delete(key),
    );
  }
  const value = await entry.value;
  return (value == null ? value : structuredClone(value)) as T;
}
