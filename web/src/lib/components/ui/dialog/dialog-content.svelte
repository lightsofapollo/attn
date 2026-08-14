<script lang="ts">
	import { Dialog as DialogPrimitive } from "bits-ui";
	import DialogPortal from "./dialog-portal.svelte";
	import { ScrollArea } from "$lib/components/ui/scroll-area/index.js";
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

	The content is viewport-centered (user feedback: top-anchoring read as
	"not centered"). Centering is safe against open-time jumps because the
	dialogs render their final structure from open (ShareDialog's minting →
	ready swap is height-stable); only user-initiated growth (e.g. the
	Advanced disclosure) re-centers, which is conventional.
-->
<DialogPortal {...portalProps}>
	<Dialog.Overlay />
	<DialogPrimitive.Content
		bind:ref
		data-slot="dialog-content"
		class={cn(
			"bg-background fixed top-[50%] left-[50%] z-50 flex max-h-[85vh] w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] flex-col overflow-hidden rounded-lg border shadow-lg transition-opacity duration-150 ease-out starting:opacity-0 sm:max-w-lg",
			className
		)}
		{...restProps}
	>
		<!-- Overflow scrolls through the shared ScrollArea (thin themed thumb),
		     never a native gutter; the close affordance stays pinned to the
		     dialog frame, outside the scrolling body.

		     `min-h-0 flex-1` hands this dialog's `max-h-[85vh]` ceiling to the
		     scroll area as its height. That only works because the ScrollArea
		     sizes its viewport by flex — a percentage height cannot resolve
		     against a max-height-bounded ancestor, which is what left this
		     modal clipped and unscrollable (attn-11g4.1.1). See the sizing note
		     in `components/ui/scroll-area/scroll-area.svelte`. -->
		<!-- `grid-cols-[minmax(0,1fr)]` is load-bearing, not decoration. A bare
		     `grid` has ONE implicit column sized `auto`, i.e. `minmax(auto,
		     max-content)`, and inside a scroll container that resolves to the
		     widest child's max-content width rather than the dialog's. One
		     unbreakable string — a `font-mono` filesystem path, a long invite
		     URL — then widened the whole column past the dialog (measured: a
		     542px column in a 446px content box, every row 70px past the right
		     edge) where the frame's `overflow-hidden` silently CLIPPED it:
		     buttons and labels were cut in half rather than wrapping or
		     truncating. `minmax(0,1fr)` resolves against the dialog's own width
		     and lets children shrink below min-content, so `truncate`/`min-w-0`
		     inside them finally have a definite width to work against. -->
		<ScrollArea class="min-h-0 flex-1">
			<div data-slot="dialog-content-body" class="grid grid-cols-[minmax(0,1fr)] gap-4 p-6">
				{@render children?.()}
			</div>
		</ScrollArea>
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
