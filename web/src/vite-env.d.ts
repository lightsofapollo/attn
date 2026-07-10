/// <reference types="svelte" />
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ATTN_RELAY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
