<script lang="ts">
	import { getTheme } from './theme.svelte';

	interface Props {
		title: string;
		description: string;
		lightSrc: string;
		darkSrc: string;
		alt: string;
		reverse?: boolean;
	}

	let { title, description, lightSrc, darkSrc, alt, reverse = false }: Props = $props();
</script>

<section class="grid lg:grid-cols-2 gap-12 items-center py-24">
	<div class={reverse ? 'lg:order-last' : ''}>
		<h3 class="font-serif text-3xl font-bold text-foreground">{title}</h3>
		<p class="font-sans text-lg text-muted-foreground mt-4 leading-relaxed">{description}</p>
	</div>

	<div class="relative rounded-xl shadow-lg border border-border overflow-hidden bg-card">
		<img
			src={lightSrc}
			{alt}
			class="w-full transition-opacity duration-500"
			class:opacity-0={getTheme() === 'dark'}
		/>
		<img
			src={darkSrc}
			{alt}
			class="absolute inset-0 w-full transition-opacity duration-500"
			class:opacity-0={getTheme() !== 'dark'}
		/>
	</div>
</section>
