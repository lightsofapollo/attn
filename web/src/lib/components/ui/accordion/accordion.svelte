<script lang="ts" module>
	import type { HTMLAttributes } from "svelte/elements";
	import type { AccordionType } from "./accordion-model";
	import type { WithElementRef } from "$lib/utils.js";

	export type AccordionProps = WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		/** `single` keeps at most one item open (default); `multiple` allows any set. */
		type?: AccordionType;
		/** Open item value(s). Bindable. */
		value?: string | string[];
		/** `single` only: may the open item be closed by its own trigger? */
		collapsible?: boolean;
		/** Wrap arrow-key focus at the ends of the set. */
		loop?: boolean;
	};
</script>

<script lang="ts">
	import { untrack } from "svelte";
	import { cn } from "$lib/utils.js";
	import { attachAccordion, type AccordionController } from "./accordion-core";
	import { normalizeValue } from "./accordion-model";
	import { accordionRootClass } from "./accordion-styles";
	import { AccordionRegistry, setAccordionRegistry } from "./context.svelte.js";

	let {
		ref = $bindable(null),
		value = $bindable(undefined),
		type = "single",
		collapsible = true,
		loop = true,
		class: className,
		children,
		...restProps
	}: AccordionProps = $props();

	const registry = new AccordionRegistry();
	setAccordionRegistry(registry);

	let controller = $state<AccordionController | null>(null);

	// Wire (and re-wire) the shared core whenever the item set changes. `value`
	// is read untracked here so a value change never tears down the controller —
	// that path goes through the sync effect below instead.
	$effect(() => {
		void registry.version;
		const root = ref;
		if (!root) return;

		const specs = registry.entries
			.filter((entry) => entry.trigger !== null && entry.content !== null)
			.map((entry) => ({
				value: entry.value,
				trigger: entry.trigger as HTMLElement,
				content: entry.content as HTMLElement,
				item: entry.item,
				disabled: entry.disabled,
			}));
		if (specs.length === 0) return;

		const attached = attachAccordion(root, specs, {
			type,
			collapsible,
			loop,
			value: untrack(() => value) ?? null,
			onValueChange: (next) => {
				value = type === "single" ? next[0] : next;
			},
		});
		controller = attached;

		return () => {
			attached.destroy();
			if (controller === attached) controller = null;
		};
	});

	// Push externally-driven `value` changes into the controller. No-ops when the
	// change originated from the controller itself, so there is no feedback loop.
	$effect(() => {
		const next = normalizeValue(value ?? null, untrack(() => type));
		const attached = controller;
		if (!attached) return;
		const current = attached.value;
		const same =
			next.length === current.length && next.every((v, i) => v === current[i]);
		if (!same) attached.setValue(next);
	});
</script>

<div
	bind:this={ref}
	data-slot="accordion"
	class={cn(accordionRootClass, className)}
	{...restProps}
>
	{@render children?.()}
</div>
