// TEST-ONLY minimal DOM. Not imported by any application code and not
// re-exported from index.ts, so it never reaches a bundle.
//
// `web/` has no jsdom and no vitest — every unit test runs as a standalone
// Node+tsx process (see scripts/run-tests.mjs) — but the accordion core and
// the ProseMirror NodeViews built on it are DOM code. Rather than reduce those
// tests to asserting exported names, this stub implements exactly the handful
// of DOM methods that code touches, so the production functions themselves run
// under test.
//
// Deliberately NOT a DOM emulator. There is no selector engine, no layout, no
// event bubbling (the accordion core binds listeners directly to the elements
// it is given, so bubbling is never exercised). If a consumer starts needing
// `querySelector` or capture-phase dispatch, that is the signal to reach for a
// real DOM rather than to grow this file.

/** Names passed to `focus()`, in order. Reset it between cases. */
export const focusLog: string[] = [];

export function clearFocusLog(): void {
  focusLog.length = 0;
}

export class FakeElement {
  readonly tagName: string;
  className = '';
  textContent = '';
  innerHTML = '';
  contentEditable = '';
  readonly children: FakeElement[] = [];
  readonly attrs = new Map<string, string>();
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  /** Just enough of `classList` for `add()`; membership is derived from
   *  `className` so the two never disagree. */
  readonly classList = {
    add: (...names: string[]): void => {
      const present = new Set(this.className.split(/\s+/).filter(Boolean));
      for (const name of names) present.add(name);
      this.className = [...present].join(' ');
    },
    contains: (name: string): boolean =>
      this.className.split(/\s+/).includes(name),
  };

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? (this.attrs.get(name) as string) : null;
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) this.children.push(node);
  }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }

  removeEventListener(type: string, fn: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  focus(): void {
    focusLog.push(this.getAttribute('id') ?? this.className);
  }

  /** Fire an event at this element. No bubbling — see the header note. */
  fire(type: string, init: Record<string, unknown> = {}): { defaultPrevented: boolean } {
    let defaultPrevented = false;
    const event = {
      type,
      ...init,
      preventDefault: () => {
        defaultPrevented = true;
      },
    };
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
    return { defaultPrevented };
  }

  /** Total live listeners in this subtree — the leak assertion. */
  listenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    for (const child of this.children) total += child.listenerCount();
    return total;
  }

  /** Depth-first search by tag name, self included. */
  findAll(tagName: string): FakeElement[] {
    const found: FakeElement[] = [];
    if (this.tagName === tagName) found.push(this);
    for (const child of this.children) found.push(...child.findAll(tagName));
    return found;
  }

  /** Depth-first search by class name, self included. */
  findByClass(name: string): FakeElement[] {
    const found: FakeElement[] = [];
    if (this.classList.contains(name)) found.push(this);
    for (const child of this.children) found.push(...child.findByClass(name));
    return found;
  }

  /** Concatenated text of this subtree, in document order. */
  allText(): string {
    return this.textContent + this.children.map((c) => c.allText()).join('');
  }
}

export function createFakeElement(tag: string): FakeElement {
  return new FakeElement(tag);
}

export const fakeDocument = {
  createElement: (tag: string) => new FakeElement(tag),
} as unknown as Document;

/**
 * Install `fakeDocument` as the global `document` for the duration of `fn`,
 * then restore. Needed for code that reaches for the global rather than
 * accepting an injected document — every ProseMirror NodeView in this repo
 * does exactly that.
 */
export function withFakeDocument<T>(fn: () => T): T {
  const globals = globalThis as { document?: Document };
  const previous = globals.document;
  globals.document = fakeDocument;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete globals.document;
    else globals.document = previous;
  }
}
