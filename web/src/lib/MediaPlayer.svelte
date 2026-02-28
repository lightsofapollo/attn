<script lang="ts">
  import type { FileType } from './types';

  interface Props {
    src: string;
    fileType: FileType;
  }

  let { src, fileType }: Props = $props();
</script>

<div class="flex h-full items-center justify-center p-8">
  {#if fileType === 'video'}
    <video controls preload="metadata" src={src} class="max-h-full max-w-full rounded-lg">
      <track kind="captions" />
    </video>
  {:else}
    <audio controls preload="metadata" src={src} class="w-full max-w-[500px]"></audio>
  {/if}
</div>
