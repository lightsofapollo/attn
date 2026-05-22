<script lang="ts">
	import { getTheme } from './theme.svelte';

	const mediaVersion = '2026-05-22-collab-header';

	function media(path: string): string {
		return `${path}?v=${mediaVersion}`;
	}

	let isDark = $derived(getTheme() === 'dark');
	let collabPoster = $derived(media(isDark ? '/screenshots/collab-dark.png' : '/screenshots/collab-light.png'));
	let collabVideo = $derived(media(isDark ? '/screenshots/collab-hero-dark.mp4' : '/screenshots/collab-hero-light.mp4'));
	let collabFallback = $derived(media(isDark ? '/screenshots/collab-hero-dark.gif' : '/screenshots/collab-hero-light.gif'));
</script>

<section class="relative overflow-hidden px-4 pb-20 pt-16 sm:px-6 md:pt-20">
	<div class="mx-auto flex max-w-[96rem] flex-col items-center">
		<div class="text-center max-w-4xl mx-auto">
		<h1 class="font-serif text-6xl md:text-7xl tracking-tight font-bold text-foreground">
			attn
		</h1>

		<p class="font-sans text-xl text-muted-foreground mt-6 max-w-xl mx-auto leading-relaxed">
			Your markdown, rendered beautifully — and
			<a href="#collaborate" class="text-foreground underline decoration-primary/40 underline-offset-4 hover:decoration-primary">reviewed together</a>,
			end-to-end encrypted.
		</p>

		<div class="mt-8">
			<code class="inline-block bg-code-block border border-border rounded-lg px-5 py-3 font-mono text-base text-foreground">
				$ attn .
			</code>
		</div>

		<div class="mt-8 flex flex-col sm:flex-row items-center justify-center gap-4">
			<a
				href="#install"
				class="bg-primary text-primary-foreground px-6 py-3 rounded-lg font-sans font-semibold hover:opacity-90 transition-opacity"
			>
				brew install lightsofapollo/attn/attn
			</a>
			<a
				href="https://github.com/lightsofapollo/attn"
				target="_blank"
				rel="noopener noreferrer"
				class="border border-border bg-transparent hover:bg-accent px-6 py-3 rounded-lg font-sans font-semibold text-foreground transition-colors"
			>
				View on GitHub
			</a>
		</div>
		</div>

		<div class="relative mt-14 w-[min(90vw,84rem)] overflow-hidden rounded-xl border border-border bg-background aspect-[4/3]">
			{#key isDark}
				<video
					class="absolute inset-0 h-full w-full object-cover"
					poster={collabPoster}
					autoplay
					muted
					loop
					playsinline
					aria-label="Live attn collaboration: a reviewer comments, suggests an edit, and moves a labeled cursor in the owner window"
				>
					<source src={collabVideo} type="video/mp4" />
					<img
						src={collabFallback}
						alt="Live attn collaboration: a reviewer comments, suggests an edit, and moves a remote cursor in a shared markdown document"
						class="h-full w-full object-cover"
					/>
				</video>
			{/key}
		</div>
	</div>
</section>
