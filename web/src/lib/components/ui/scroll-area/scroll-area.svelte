<script lang="ts">
	import { ScrollArea as ScrollAreaPrimitive } from "bits-ui";
	import { Scrollbar } from "./index.js";
	import { cn, type WithoutChild } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		viewportRef = $bindable(null),
		class: className,
		orientation = "vertical",
		scrollbarXClasses = "",
		scrollbarYClasses = "",
		viewportClasses = "",
		children,
		...restProps
	}: WithoutChild<ScrollAreaPrimitive.RootProps> & {
		orientation?: "vertical" | "horizontal" | "both" | undefined;
		scrollbarXClasses?: string | undefined;
		scrollbarYClasses?: string | undefined;
		/* Height caps (e.g. max-h-72) belong on the viewport — the element
		   that actually scrolls — not the root, whose height just wraps it.
		   A cap imposed from OUTSIDE (a flex/grid parent bounding the root)
		   works too; see the root/viewport sizing note below. */
		viewportClasses?: string | undefined;
		viewportRef?: HTMLElement | null;
	} = $props();
</script>

<!--
	Root/viewport sizing: the root is a flex COLUMN and the viewport is a
	shrinkable flex item, NOT `size-full`.

	The upstream shadcn recipe sizes the viewport with `height: 100%`, which
	only resolves when the root's own height is definite. When a caller bounds
	the root from outside instead — `<ScrollArea class="min-h-0 flex-1">` inside
	a flex column — the root's used height comes out of flex layout, and if that
	ancestor is itself bounded only by `max-height` (DialogContent's
	`max-h-[85vh]`, height auto) the resolved height is NOT definite for
	percentage resolution. `height: 100%` then falls back to `auto`, the
	viewport grows to its full content height, scrollHeight === clientHeight,
	and nothing scrolls — the overflow is simply clipped by the ancestor's
	`overflow-hidden`. That was the unscrollable share modal (attn-11g4.1.1).

	Sizing the viewport by flex instead makes it track the root's used height
	in every case, definite or not. `flex-auto` (basis `auto`) rather than
	`flex-1` (basis `0%`) deliberately: with a content-sized root — the
	`viewportClasses="max-h-24"` pattern — a zero basis leaves the root's height
	to intrinsic flex sizing, which WebKit has historically collapsed. An auto
	basis starts from the content height and only shrinks when something above
	actually bounds it, so both patterns hold.
-->
<ScrollAreaPrimitive.Root
	bind:ref
	data-slot="scroll-area"
	class={cn("relative flex flex-col", className)}
	{...restProps}
>
	<ScrollAreaPrimitive.Viewport
		bind:ref={viewportRef}
		tabindex={0}
		data-slot="scroll-area-viewport"
		class={cn(
			"ring-ring/10 dark:ring-ring/20 dark:outline-ring/40 outline-ring/50 w-full min-h-0 flex-auto rounded-[inherit] transition-[color,box-shadow] focus-visible:ring-4 focus-visible:outline-1",
			viewportClasses
		)}
	>
		{@render children?.()}
	</ScrollAreaPrimitive.Viewport>
	{#if orientation === "vertical" || orientation === "both"}
		<Scrollbar orientation="vertical" class={scrollbarYClasses} />
	{/if}
	{#if orientation === "horizontal" || orientation === "both"}
		<Scrollbar orientation="horizontal" class={scrollbarXClasses} />
	{/if}
	<ScrollAreaPrimitive.Corner />
</ScrollAreaPrimitive.Root>
