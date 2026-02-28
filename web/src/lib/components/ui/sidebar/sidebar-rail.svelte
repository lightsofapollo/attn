<script lang="ts">
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLAttributes } from "svelte/elements";
	import { useSidebar } from "./context.svelte.js";

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>, HTMLDivElement> = $props();

	const sidebar = useSidebar();
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	bind:this={ref}
	data-sidebar="rail"
	data-slot="sidebar-rail"
	onpointerdown={sidebar.startResize}
	ondblclick={sidebar.toggle}
	class={cn(
		"absolute inset-y-0 z-20 hidden w-4 -translate-x-1/2 cursor-col-resize select-none transition-colors ease-linear group-data-[side=left]:-end-4 group-data-[side=right]:start-0 after:absolute after:inset-y-0 after:start-[calc(1/2*100%-1px)] after:w-[2px] sm:flex",
		"hover:after:bg-sidebar-border",
		"group-data-[collapsible=offcanvas]:translate-x-0 group-data-[collapsible=offcanvas]:after:start-full",
		"[[data-side=left][data-collapsible=offcanvas]_&]:-end-2",
		"[[data-side=right][data-collapsible=offcanvas]_&]:-start-2",
		className
	)}
	{...restProps}
>
	{@render children?.()}
</div>
