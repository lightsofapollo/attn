<script lang="ts">
	import { Dialog as DialogPrimitive } from "bits-ui";
	import { cn } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: DialogPrimitive.OverlayProps = $props();
</script>

<!-- Fade-in via transition + @starting-style, matching dialog-content
	(see the rationale there — tw-animate keyframes glitch in WKWebView). -->
<DialogPrimitive.Overlay
	bind:ref
	data-slot="dialog-overlay"
	class={cn(
		"fixed inset-0 z-50 bg-black/50 transition-opacity duration-150 ease-out starting:opacity-0",
		className
	)}
	{...restProps}
/>
