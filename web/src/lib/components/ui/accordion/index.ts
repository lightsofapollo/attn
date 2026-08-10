import Root from "./accordion.svelte";
import Item from "./accordion-item.svelte";
import Trigger from "./accordion-trigger.svelte";
import Content from "./accordion-content.svelte";

export {
	Root,
	Item,
	Trigger,
	Content,
	//
	Root as Accordion,
	Item as AccordionItem,
	Trigger as AccordionTrigger,
	Content as AccordionContent,
};

export type { AccordionProps } from "./accordion.svelte";
export type { AccordionItemProps } from "./accordion-item.svelte";
export type { AccordionTriggerProps } from "./accordion-trigger.svelte";
export type { AccordionContentProps } from "./accordion-content.svelte";

// Framework-free surface — this is what a ProseMirror NodeView imports. See
// the decision record and worked example at the top of `accordion-core.ts`.
export {
	attachAccordion,
	createAccordionDom,
	type AccordionController,
	type AccordionDom,
	type AccordionDomItem,
	type AccordionDomOptions,
	type AccordionItemSpec,
	type AccordionOptions,
} from "./accordion-core";
export type { AccordionType } from "./accordion-model";
export * from "./accordion-styles";
