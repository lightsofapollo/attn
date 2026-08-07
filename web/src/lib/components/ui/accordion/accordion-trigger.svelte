<script lang="ts" module>
	import type { HTMLButtonAttributes } from "svelte/elements";
	import type { WithElementRef } from "$lib/utils.js";

	export type AccordionTriggerProps = WithElementRef<HTMLButtonAttributes> & {
		/** Set false to supply your own leading affordance. */
		chevron?: boolean;
	};
</script>

<script lang="ts">
	import ChevronRight from "@lucide/svelte/icons/chevron-right";
	import { cn } from "$lib/utils.js";
	import { accordionChevronClass, accordionTriggerClass } from "./accordion-styles";
	import { getAccordionItem, getAccordionRegistry } from "./context.svelte.js";

	let {
		ref = $bindable(null),
		chevron = true,
		class: className,
		children,
		...restProps
	}: AccordionTriggerProps = $props();

	const registry = getAccordionRegistry();
	const entry = getAccordionItem();

	$effect(() => {
		entry.trigger = ref;
		registry.invalidate();
	});
</script>

<!-- A real <button>: Enter/Space activation is native and deliberately not
     re-implemented. `aria-expanded`, `aria-controls`, ids and `data-state` are
     applied by the shared core once the Root wires this element. -->
<button
	bind:this={ref}
	type="button"
	data-slot="accordion-trigger"
	class={cn(accordionTriggerClass, className)}
	{...restProps}
>
	{#if chevron}
		<ChevronRight class={accordionChevronClass} aria-hidden="true" />
	{/if}
	{@render children?.()}
</button>
