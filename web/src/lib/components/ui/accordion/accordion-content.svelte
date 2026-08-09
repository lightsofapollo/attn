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

<!-- Three elements, not one: the outer is displayed or not, straight off
     `data-state`, and masks; the middle carries the entry motion, which is
     enhancement only; the inner holds the body. The core adds `role="region"`,
     `aria-labelledby`, `data-state` and — while closed — `inert`. The panel's
     resting size is state alone: no transition sits between the two. See the
     note atop accordion-styles.ts. -->
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
