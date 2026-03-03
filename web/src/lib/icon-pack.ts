import { DEFAULT_ICON_PACK, ICON_PACKS, type IconPack } from './vscode-icon-map.generated';

const STORAGE_KEY = 'attn.icon-pack';
const ICON_PACK_IDS = Object.keys(ICON_PACKS) as IconPack[];

let initialized = false;
let currentPack: IconPack = DEFAULT_ICON_PACK;
const listeners = new Set<(pack: IconPack) => void>();

function isPack(value: string | null): value is IconPack {
  return value !== null && ICON_PACK_IDS.includes(value as IconPack);
}

function applyPackToDom(pack: IconPack): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.iconPack = pack;
}

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  if (typeof window !== 'undefined') {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isPack(stored)) {
      currentPack = stored;
    }
  }
  applyPackToDom(currentPack);
}

function emit(): void {
  for (const listener of listeners) {
    listener(currentPack);
  }
}

export function getIconPack(): IconPack {
  ensureInitialized();
  return currentPack;
}

export function setIconPack(pack: IconPack): void {
  ensureInitialized();
  if (currentPack === pack) return;
  currentPack = pack;
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, pack);
  }
  applyPackToDom(pack);
  emit();
}

export function cycleIconPack(): IconPack {
  const current = getIconPack();
  const currentIndex = ICON_PACK_IDS.indexOf(current);
  const next = ICON_PACK_IDS[(currentIndex + 1) % ICON_PACK_IDS.length] ?? DEFAULT_ICON_PACK;
  setIconPack(next);
  return next;
}

export function subscribeIconPack(listener: (pack: IconPack) => void): () => void {
  ensureInitialized();
  listeners.add(listener);
  listener(currentPack);
  return () => {
    listeners.delete(listener);
  };
}

export function availableIconPacks(): IconPack[] {
  return [...ICON_PACK_IDS];
}
