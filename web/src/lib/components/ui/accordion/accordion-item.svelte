<script lang="ts" module>
	import type { HTMLAttributes } from "svelte/elements";
	import type { WithElementRef } from "$lib/utils.js";

	export type AccordionItemProps = WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		/** Identity within the set. Also seeds the trigger/panel element ids. */
		value: string;
		disabled?: boolean;
	};
</script>

<script lang="ts">
	import { untrack } from "svelte";
	import { cn } from "$lib/utils.js";
	import { accordionItemClass } from "./accordion-styles";
	import {
		getAccordionRegistry,
		setAccordionItem,
		type AccordionItemRegistration,
	} from "./context.svelte.js";

	let {
		ref = $bindable(null),
		value,
		disabled = false,
		class: className,
		children,
		...restProps
	}: AccordionItemProps = $props();

	const registry = getAccordionRegistry();
	// Seeded untracked on purpose: the registration is a plain mutable record
	// handed to the core, and the effect below is what keeps it in step with
	// the props.
	const entry: AccordionItemRegistration = setAccordionItem({
		value: untrack(() => value),
		disabled: untrack(() => disabled),
		item: null,
		trigger: null,
		content: null,
	});

	// Registration order is DOM order (Svelte mounts children in order), which
	// is what arrow-key navigation walks. Register once, with no reactive reads,
	// so a prop change never reorders the set.
	$effect(() => registry.register(entry));

	// Prop / element changes re-wire in place, keeping position. Trigger and
	// Content invalidate too: effect order between a parent and its children is
	// not something to bet on, so every contributor bumps the version and the
	// Root's wiring effect converges on the last one. A few extra attach/detach
	// cycles during mount are free — `destroy()` removes exactly what it added.
	$effect(() => {
		entry.value = value;
		entry.disabled = disabled;
		entry.item = ref;
		registry.invalidate();
	});
</script>

<div bind:this={ref} data-slot="accordion-item" class={cn(accordionItemClass, className)} {...restProps}>
	{@render children?.()}
</div>
