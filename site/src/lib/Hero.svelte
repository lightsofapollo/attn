<script lang="ts">
	import { getTheme } from './theme.svelte';
</script>

<section class="min-h-[85vh] flex items-center justify-center px-6">
	<div class="text-center max-w-4xl mx-auto">
		<h1 class="font-serif text-6xl md:text-7xl tracking-tight font-bold text-foreground">
			attn
		</h1>

		<p class="font-sans text-xl text-muted-foreground mt-6 max-w-xl mx-auto leading-relaxed">
			Your markdown, rendered beautifully.
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

		<div class="relative mt-16 max-w-4xl mx-auto rounded-xl shadow-2xl border border-border overflow-hidden bg-card">
			<img
				src="/screenshots/hero-light.png"
				alt="attn in light mode"
				class="w-full transition-opacity duration-500"
				class:opacity-0={getTheme() === 'dark'}
			/>
			<img
				src="/screenshots/hero-dark.png"
				alt="attn in dark mode"
				class="absolute inset-0 w-full transition-opacity duration-500"
				class:opacity-0={getTheme() !== 'dark'}
			/>
		</div>
	</div>
</section>
