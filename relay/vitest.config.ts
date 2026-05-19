import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
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
