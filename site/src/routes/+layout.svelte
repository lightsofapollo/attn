<script lang="ts">
	import '@fontsource-variable/source-serif-4';
	import '@fontsource-variable/source-sans-3';
	import '@fontsource-variable/source-code-pro';
	import '../app.css';
	import Nav from '$lib/Nav.svelte';
	import Footer from '$lib/Footer.svelte';
	import { initTheme } from '$lib/theme.svelte';
	import { onMount } from 'svelte';

	let { children } = $props();

	onMount(() => {
		initTheme();
	});
</script>

<Nav />
<main>
	{@render children()}
</main>
<Footer />
