import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    // 15s per test — several integration cases ship 50-80 sequential SELF.fetch
    // calls (rate-limit anti-enum, hibernation roundtrips, R2 blob putget) that
    // creep past vitest's 5s default when the workerd isolate is shared with
    // the full suite (singleWorker=true below). 15s gives comfortable headroom
    // while still catching genuine hangs.
    testTimeout: 15000,
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        // Default-on isolatedStorage incompatible with the new SQLite-backed
        // DO migration (new_sqlite_classes in wrangler.toml): the pool's
        // stack-frame cleanup expects only `.sqlite` files but workerd emits
        // `.sqlite-shm` and `.sqlite-wal` companions when WAL mode is on.
        // Each integration test uses a unique roomId via uniqueRoomId(), so
        // shared storage is safe; rooms never collide.
        isolatedStorage: false,
        singleWorker: true,
      },
    },
  },
});
