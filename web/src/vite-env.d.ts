/// <reference types="svelte" />
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ATTN_RELAY_URL?: string;
  /** Mint share invites for this public origin instead of the app's own
   * (e.g. a localhost owner issuing staging.attn.sh links). */
  readonly VITE_ATTN_SHARE_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
