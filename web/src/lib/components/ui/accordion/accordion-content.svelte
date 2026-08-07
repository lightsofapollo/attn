<script lang="ts" module>
	import type { HTMLAttributes } from "svelte/elements";
	import type { WithElementRef } from "$lib/utils.js";

	export type AccordionContentProps = WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		/** Classes for the inner body. Pass "" for a full-bleed panel. */
		bodyClass?: string;
	};
</script>

<script lang="ts">
	import { cn } from "$lib/utils.js";
	import {
		accordionContentBodyClass,
		accordionContentClass,
		accordionContentInnerClass,
	} from "./accordion-styles";
	import { getAccordionItem, getAccordionRegistry } from "./context.svelte.js";

	let {
		ref = $bindable(null),
		bodyClass = accordionContentBodyClass,
		class: className,
		children,
		...restProps
	}: AccordionContentProps = $props();

	const registry = getAccordionRegistry();
	const entry = getAccordionItem();

	$effect(() => {
		entry.content = ref;
		registry.invalidate();
	});
</script>

<!-- Three elements, not one: the outer grid animates 0fr -> 1fr, the middle
     clips, the inner holds the body at its natural height. The core adds
     `role="region"`, `aria-labelledby`, `data-state` and — while closed —
     `inert`, so collapsed content is out of the tab order and the
     accessibility tree without `hidden` killing the reveal. -->
<div
	bind:this={ref}
	data-slot="accordion-content"
	data-state="closed"
	class={cn(accordionContentClass, className)}
	{...restProps}
>
	<div class={accordionContentInnerClass}>
		<div class={bodyClass}>
			{@render children?.()}
		</div>
	</div>
</div>
