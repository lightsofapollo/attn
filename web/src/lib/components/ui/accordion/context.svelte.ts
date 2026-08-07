// Registry that lets Accordion.Item / .Trigger / .Content hand their elements
// to the same `attachAccordion` core the ProseMirror NodeView uses. The Svelte
// layer contributes markup and reactivity; it contributes NO behaviour of its
// own, which is the whole point of the split (see accordion-core.ts).

import { getContext, setContext } from 'svelte';
import type { AccordionType } from './accordion-model';

const ACCORDION_KEY = Symbol('accordion');
const ACCORDION_ITEM_KEY = Symbol('accordion-item');

export interface AccordionItemRegistration {
  value: string;
  disabled: boolean;
  item: HTMLElement | null;
  trigger: HTMLElement | null;
  content: HTMLElement | null;
}

export class AccordionRegistry {
  /** Bumped whenever the item set changes, so the Root effect re-wires. Plain
   *  `$state` rather than a reactive array: the entries themselves are mutated
   *  by `bind:this` during render, and we only need to know THAT the shape
   *  changed, not to track each field. */
  #version = $state(0);
  readonly entries: AccordionItemRegistration[] = [];

  get version(): number {
    return this.#version;
  }

  register(entry: AccordionItemRegistration): () => void {
    this.entries.push(entry);
    this.#version += 1;
    return () => {
      const index = this.entries.indexOf(entry);
      if (index !== -1) this.entries.splice(index, 1);
      this.#version += 1;
    };
  }

  /** Force a re-wire when an item's identity or disabled flag changes. */
  invalidate(): void {
    this.#version += 1;
  }
}

export function setAccordionRegistry(registry: AccordionRegistry): AccordionRegistry {
  return setContext(ACCORDION_KEY, registry);
}

export function getAccordionRegistry(): AccordionRegistry {
  const registry = getContext<AccordionRegistry | undefined>(ACCORDION_KEY);
  if (!registry) {
    throw new Error('Accordion.Item must be used inside <Accordion.Root>');
  }
  return registry;
}

export function setAccordionItem(
  entry: AccordionItemRegistration,
): AccordionItemRegistration {
  return setContext(ACCORDION_ITEM_KEY, entry);
}

export function getAccordionItem(): AccordionItemRegistration {
  const entry = getContext<AccordionItemRegistration | undefined>(ACCORDION_ITEM_KEY);
  if (!entry) {
    throw new Error(
      'Accordion.Trigger and Accordion.Content must be used inside <Accordion.Item>',
    );
  }
  return entry;
}

export type { AccordionType };
