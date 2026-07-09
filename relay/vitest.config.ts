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
        miniflare: {
          bindings: {
            // Tests do not receive Cloudflare edge headers by default. The
            // explicit escape hatch creates a per-room development bucket;
            // production/staging intentionally omit it.
            QUOTA_IP_HASH_KEY: "vitest-only-quota-ip-hmac-key-material-32",
            BLOB_CAP_SIGNING_KEY: "vitest-only-blob-cap-signing-key-32-bytes",
            QUOTA_ALLOW_UNATTRIBUTED_CREATES: "true",
            // Low source live cap makes Worker integration boundaries cheap;
            // existing tests use per-room unattributed buckets and do not
            // share it. Global ceilings are intentionally generous because
            // isolatedStorage=false shares the singleton across the suite.
            QUOTA_MAX_LIVE_ROOMS_PER_SOURCE: "2",
            QUOTA_MAX_ALLOCATED_BYTES_PER_SOURCE_24H: "62914560",
            QUOTA_GLOBAL_MAX_LIVE_ROOMS: "10000",
            QUOTA_GLOBAL_MAX_RESERVED_BYTES: "1099511627776",
          },
        },
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
