<script lang="ts">
  import type { Snippet } from 'svelte';
  import BrandMark from '../../lib/BrandMark.svelte';
  import type { PersistenceMode } from './types';

  interface Props {
    mode: PersistenceMode;
    actions?: Snippet;
  }

  const { mode, actions }: Props = $props();
</script>

<!-- The storage badge is gone (user ruling, 2026-08-20): icon-only, it read as
     decoration rather than a control, and a header ornament nobody believes is
     clickable is worse than no header ornament.

     Where each state is still said: `session-only`, `unavailable` and
     `quota-pressure` raise a full DegradedBanner on the desk, the open page and
     the editor — a title, the consequence, and a real button to the remedy —
     which is a louder and more useful surface than the badge ever was.
     `best-effort` ("Backup recommended") deliberately raises no banner, so it
     is now unstated in the chrome; `/app/storage` still reports it in full.

     `data-storage-mode` moves to the header itself so the shell keeps reporting
     which state it is in for tests and automation, without spending a control
     on it. -->
<!-- data-slot opts this header into the ACCENT PLANE token re-pointing in
     app.css, the same block the native, owner and review headers use. The desk,
     open and storage routes wore a paper header while the editor and review
     surfaces wore the plane, so crossing into a document flipped the top of the
     window — in Ink, a steel band appearing and vanishing dozens of times a
     session. One grammar, one plane (attn-08fa.2). -->
<header class="app-header" data-slot="app-shell-header" data-storage-mode={mode}>
  <a class="brand" href="/"><BrandMark class="mark" />attn</a>
  <div class="right">
    {@render actions?.()}
  </div>
</header>
