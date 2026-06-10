<script lang="ts">
	import { Dialog as DialogPrimitive } from "bits-ui";
	import DialogPortal from "./dialog-portal.svelte";
	import XIcon from "@lucide/svelte/icons/x";
	import type { Snippet } from "svelte";
	import * as Dialog from "./index.js";
	import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";
	import type { ComponentProps } from "svelte";

	let {
		ref = $bindable(null),
		class: className,
		portalProps,
		children,
		showCloseButton = true,
		...restProps
	}: WithoutChildrenOrChild<DialogPrimitive.ContentProps> & {
		portalProps?: WithoutChildrenOrChild<ComponentProps<typeof DialogPortal>>;
		children: Snippet;
		showCloseButton?: boolean;
	} = $props();
</script>

<!--
	Entry is a pure opacity fade via a CSS transition + @starting-style
	(`starting:opacity-0`) instead of tw-animate-css keyframes: the
	animate-in/zoom keyframes both LOOKED glitchy (the dialog scaled and
	shifted while opening) and have two documented WKWebView failure modes
	in this app (entry stuck at opacity 0; exit never firing animationend —
	see the dialog notes in app.css). A transition's end state is the
	specified value, so it cannot strand the dialog invisible, and bits-ui
	does not gate unmount on transitions, so close stays instant.

	The content is anchored at a FIXED top (not 50%/translate -50%
	centering) so async content arriving after open (e.g. ShareDialog's
	minting → ready swap) grows the dialog downward instead of re-centering
	it — the header must never jump.
-->
<DialogPortal {...portalProps}>
	<Dialog.Overlay />
	<DialogPrimitive.Content
		bind:ref
		data-slot="dialog-content"
		class={cn(
			"bg-background fixed top-[14vh] left-[50%] z-50 grid max-h-[80vh] w-full max-w-[calc(100%-2rem)] translate-x-[-50%] gap-4 overflow-y-auto rounded-lg border p-6 shadow-lg transition-opacity duration-150 ease-out starting:opacity-0 sm:max-w-lg",
			className
		)}
		{...restProps}
	>
		{@render children?.()}
		{#if showCloseButton}
			<DialogPrimitive.Close
				class="ring-offset-background focus:ring-ring absolute end-4 top-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
			>
				<XIcon />
				<span class="sr-only">Close</span>
			</DialogPrimitive.Close>
		{/if}
	</DialogPrimitive.Content>
</DialogPortal>
