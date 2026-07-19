<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';

  interface Props {
    enabled?: boolean;
    replyText: string;
    onstart?: () => void;
    oncomplete?: () => void;
    oncancel?: () => void;
  }

  let {
    enabled = true,
    replyText,
    onstart = () => undefined,
    oncomplete = () => undefined,
    oncancel = () => undefined,
  }: Props = $props();

  type Phase = 'idle' | 'reply' | 'typing' | 'send' | 'complete' | 'cancelled';

  const CODEX_CARD = '[data-thread-id="landing-demo-codex-thread"]';
  const REPLY_BUTTON = `${CODEX_CARD} [data-action="reply"]`;
  const REPLY_COMPOSER = `${CODEX_CARD} [data-slot="review-reply-composer"]`;

  let phase = $state<Phase>('idle');
  let x = $state(24);
  let y = $state(24);
  let cursorVisible = $state(false);
  let compactPointer = $state(false);
  let reducedMotion = false;
  let outerVisible = false;
  let autoplayStarted = false;
  let userTookOver = false;
  let scriptOwnsInput = false;
  let runToken = 0;
  let autoTimer: ReturnType<typeof setTimeout> | undefined;
  let mediaQuery: MediaQueryList | undefined;

  function current(token: number): boolean {
    return token === runToken && phase !== 'cancelled';
  }

  async function pause(milliseconds: number, token: number): Promise<boolean> {
    let remaining = milliseconds;
    while (remaining > 0) {
      if (!current(token)) return false;
      if (!outerVisible || document.hidden) {
        await new Promise<void>((resolve) => setTimeout(resolve, 60));
        continue;
      }
      const slice = Math.min(remaining, 45);
      await new Promise<void>((resolve) => setTimeout(resolve, slice));
      remaining -= slice;
    }
    return current(token);
  }

  async function findElement<T extends Element>(selector: string, token: number): Promise<T | null> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && current(token)) {
      const element = document.querySelector<T>(selector);
      if (element) return element;
      if (!(await pause(50, token))) return null;
    }
    return null;
  }

  function targetPoint(element: Element): { x: number; y: number } {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.min(window.innerWidth - 26, Math.max(16, rect.left + Math.min(rect.width * 0.66, rect.width - 12))),
      y: Math.min(window.innerHeight - 26, Math.max(16, rect.top + Math.min(rect.height * 0.62, rect.height - 10))),
    };
  }

  async function pointAt(element: Element, nextPhase: Phase, token: number): Promise<boolean> {
    const rect = element.getBoundingClientRect();
    const outside = rect.top < 74 || rect.bottom > window.innerHeight - 38;
    if (outside) {
      element.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
      if (!(await pause(reducedMotion ? 0 : 420, token))) return false;
    }
    const point = targetPoint(element);
    phase = nextPhase;
    x = point.x;
    y = point.y;
    cursorVisible = !reducedMotion;
    return pause(reducedMotion ? 0 : 720, token);
  }

  function inputValue(textarea: HTMLTextAreaElement, value: string, data: string | null): void {
    textarea.value = value;
    textarea.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      data,
      inputType: data === null ? 'deleteContentBackward' : 'insertText',
    }));
  }

  function clearScriptedDraft(): void {
    if (!scriptOwnsInput) return;
    const textarea = document.querySelector<HTMLTextAreaElement>(`${REPLY_COMPOSER} textarea`);
    if (textarea) inputValue(textarea, '', null);
    scriptOwnsInput = false;
  }

  function cancelForVisitor(event?: Event): void {
    if (event && !event.isTrusted) return;
    userTookOver = true;
    runToken += 1;
    phase = 'cancelled';
    cursorVisible = false;
    clearScriptedDraft();
    oncancel();
  }

  async function runGuidedReply(manual: boolean): Promise<void> {
    if (!enabled || (!manual && (autoplayStarted || userTookOver))) return;
    autoplayStarted = true;
    userTookOver = false;
    runToken += 1;
    const token = runToken;
    phase = 'idle';
    cursorVisible = false;
    clearScriptedDraft();
    onstart();
    await tick();

    const replyButton = await findElement<HTMLButtonElement>(REPLY_BUTTON, token);
    if (!replyButton || !(await pointAt(replyButton, 'reply', token))) return;
    replyButton.click();

    const textarea = await findElement<HTMLTextAreaElement>(`${REPLY_COMPOSER} textarea`, token);
    if (!textarea || !(await pointAt(textarea, 'typing', token))) return;
    scriptOwnsInput = true;

    if (reducedMotion) {
      inputValue(textarea, replyText, replyText);
    } else {
      let draft = '';
      for (const character of replyText) {
        if (!current(token)) return;
        draft += character;
        inputValue(textarea, draft, character);
        if (!(await pause(character === ' ' ? 28 : 43, token))) return;
      }
      if (!(await pause(260, token))) return;
    }

    const sendButton = await findElement<HTMLButtonElement>(`${REPLY_COMPOSER} .rmc-btn-primary`, token);
    if (!sendButton || !(await pointAt(sendButton, 'send', token))) return;
    sendButton.click();
    scriptOwnsInput = false;
    if (!(await pause(reducedMotion ? 0 : 580, token))) return;

    phase = 'complete';
    cursorVisible = false;
    oncomplete();
  }

  function scheduleAutoplay(): void {
    if (!enabled || autoplayStarted || userTookOver || !outerVisible) return;
    if (autoTimer) return;
    autoTimer = setTimeout(() => void runGuidedReply(false), reducedMotion ? 80 : 520);
  }

  function handleVisibilityMessage(event: MessageEvent): void {
    if (event.origin !== window.location.origin) return;
    if (event.data?.type !== 'attn-landing-demo-visibility') return;
    outerVisible = event.data.visible === true;
    if (outerVisible) scheduleAutoplay();
  }

  function updatePointerMode(): void {
    compactPointer = mediaQuery?.matches ?? false;
  }

  export function replay(): void {
    outerVisible = true;
    void runGuidedReply(true);
  }

  onMount(() => {
    reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    mediaQuery = window.matchMedia('(max-width: 680px)');
    updatePointerMode();
    mediaQuery.addEventListener('change', updatePointerMode);
    window.addEventListener('message', handleVisibilityMessage);
    window.addEventListener('pointerdown', cancelForVisitor, true);
    window.addEventListener('keydown', cancelForVisitor, true);
    window.addEventListener('wheel', cancelForVisitor, { capture: true, passive: true });

    if (window.parent === window) {
      outerVisible = true;
      scheduleAutoplay();
    } else {
      window.parent.postMessage({ type: 'attn-landing-demo-ready' }, window.location.origin);
    }
  });

  onDestroy(() => {
    if (autoTimer) clearTimeout(autoTimer);
    runToken += 1;
    mediaQuery?.removeEventListener('change', updatePointerMode);
    window.removeEventListener('message', handleVisibilityMessage);
    window.removeEventListener('pointerdown', cancelForVisitor, true);
    window.removeEventListener('keydown', cancelForVisitor, true);
    window.removeEventListener('wheel', cancelForVisitor, true);
  });
</script>

<div
  class="guided-demo-cursor"
  class:is-visible={cursorVisible}
  data-slot="guided-demo-cursor"
  data-phase={phase}
  data-pointer={compactPointer ? 'tap' : 'cursor'}
  style={`--guided-x: ${x}px; --guided-y: ${y}px`}
  aria-hidden="true"
>
  {#if compactPointer}
    <span class="tap-point"></span>
  {:else}
    <span class="cursor-point"></span>
  {/if}
  <span class="cursor-label">Demo</span>
</div>

<style>
  .guided-demo-cursor {
    position: fixed;
    z-index: 80;
    top: 0;
    left: 0;
    display: flex;
    align-items: center;
    gap: 0.32rem;
    opacity: 0;
    pointer-events: none;
    transform: translate3d(var(--guided-x), var(--guided-y), 0);
    transition:
      transform 680ms cubic-bezier(0.16, 1, 0.3, 1),
      opacity 160ms ease;
    will-change: transform, opacity;
  }

  .guided-demo-cursor.is-visible { opacity: 1; }

  .cursor-point {
    width: 17px;
    height: 22px;
    flex: none;
    background: var(--foreground);
    clip-path: polygon(0 0, 0 100%, 5px 15px, 10px 22px, 13px 20px, 8px 13px, 17px 13px);
    filter: drop-shadow(0 1px 0 var(--background));
    transform: translate(-2px, -2px);
  }

  .tap-point {
    width: 24px;
    height: 24px;
    flex: none;
    border: 2px solid var(--foreground);
    border-radius: 50%;
    background: color-mix(in oklch, var(--background) 68%, transparent);
  }

  .guided-demo-cursor[data-phase='reply'] .cursor-point,
  .guided-demo-cursor[data-phase='send'] .cursor-point,
  .guided-demo-cursor[data-phase='reply'] .tap-point,
  .guided-demo-cursor[data-phase='send'] .tap-point {
    animation: guided-click 520ms ease-out 520ms both;
  }

  .cursor-label {
    padding: 0.22rem 0.38rem;
    border-radius: 2px;
    background: var(--foreground);
    color: var(--background);
    font: 750 0.65rem/1 var(--font-sans, sans-serif);
    letter-spacing: 0.025em;
  }

  @keyframes guided-click {
    0%, 100% { transform: scale(1); }
    42% { transform: scale(0.78); }
  }

  @media (prefers-reduced-motion: reduce) {
    .guided-demo-cursor { display: none; }
  }
</style>
