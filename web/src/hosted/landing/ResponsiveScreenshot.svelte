<script lang="ts">
  type Props = {
    fallback: string;
    avifSrcset: string;
    alt: string;
    sizes: string;
    loading?: 'eager' | 'lazy';
    fetchpriority?: 'high' | 'auto' | 'low';
  };

  let {
    fallback,
    avifSrcset,
    alt,
    sizes,
    loading = 'lazy',
    fetchpriority = 'auto',
  }: Props = $props();
</script>

<picture>
  <source type="image/avif" srcset={avifSrcset} {sizes} />
  <img
    src={fallback}
    {alt}
    width="1920"
    height="1440"
    {loading}
    {fetchpriority}
    decoding="async"
  />
</picture>
