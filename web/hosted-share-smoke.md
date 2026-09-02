# Hosted image and import smoke test

Run the app with `task dev:app`, then open `http://127.0.0.1:5173/open`.

1. Choose **Files or folder** → **Folder**, select `tests/fixtures`, and open
   `images.md` in the new workspace. The Pexels image should render for the
   owner; `./gone.png` should remain a truthful missing-file placeholder.
2. Open the share control, create a review link, and visit it in a private
   second browser context. The Pexels image remains blocked until **Load
   external images** is chosen; after opting in it renders, and a reload resets
   the choice.
3. In the sidebar, use the single **Add files** well. Its menu must offer
   **Files** and **Folder**; folder imports retain nested paths. Expand and
   collapse nested folders: closed chevrons point right, open chevrons point
   down, and row hover/active fills stay inside the vertical folder guide.

Use `/open` for a fresh import when an existing workspace already contains the
same path. Hosted workspaces deliberately reject duplicate paths rather than
silently overwriting durable content; the editor exposes an **Open fresh
import** link after that conflict.

The deterministic lifecycle gate is `npm run test:share-ui:live` (or
`ATTN_SHARE_UI_EXTERNAL=1 npm run test:share-ui:live` with externally managed
local relay and Vite servers). It covers the exact Pexels URL, reviewer consent,
reload/offline durability, and the existing unsafe/missing-image fallbacks.
