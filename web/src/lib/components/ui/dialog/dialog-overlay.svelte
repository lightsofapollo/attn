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
		// 70%, not 50%: at half opacity the scrim barely separated a dialog from
		// the INK theme, where the app surface is already near-black — the modal
		// read as one more panel rather than the only thing to attend to. Still
		// short of the shadcn default (80%), which crushes the paper theme.
		"fixed inset-0 z-50 bg-black/70 transition-opacity duration-150 ease-out starting:opacity-0",
		className
	)}
	{...restProps}
/>
