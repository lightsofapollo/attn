<script lang="ts">
	import { Toaster as Sonner, type ToasterProps as SonnerProps } from "svelte-sonner";
	import { getEffectiveTheme } from "$lib/theme.js";

	let { ...restProps }: SonnerProps = $props();
	let theme = $derived(getEffectiveTheme());
</script>

<Sonner
	{theme}
	class="toaster group"
	style="--normal-bg: var(--popover); --normal-text: var(--popover-foreground); --normal-border: var(--border);"
	{...restProps}
/>
