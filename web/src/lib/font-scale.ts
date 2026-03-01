const STORAGE_KEY = 'attn.fontScale';
const CSS_SCALE_VAR = '--attn-font-scale';
const DEFAULT_SCALE = 1;
const MIN_SCALE = 0.7;
const MAX_SCALE = 2;
const STEP = 0.1;

let initialized = false;
let currentScale = DEFAULT_SCALE;

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

function normalizeScale(scale: number): number {
  return Math.round(scale * 100) / 100;
}

function loadScaleFromStorage(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SCALE;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return DEFAULT_SCALE;
    return clampScale(parsed);
  } catch {
    return DEFAULT_SCALE;
  }
}

function saveScale(scale: number): void {
  try {
    if (scale === DEFAULT_SCALE) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, String(scale));
  } catch {
    // Ignore storage errors (private mode, disabled storage, etc.)
  }
}

function applyScale(scale: number): void {
  document.documentElement.style.setProperty(CSS_SCALE_VAR, String(scale));
}

function ensureInitialized(): void {
  if (initialized) return;
  currentScale = loadScaleFromStorage();
  applyScale(currentScale);
  initialized = true;
}

function setScale(scale: number): void {
  ensureInitialized();
  const normalized = normalizeScale(clampScale(scale));
  if (normalized === currentScale) return;
  currentScale = normalized;
  applyScale(currentScale);
  saveScale(currentScale);
}

export function initFontScale(): void {
  ensureInitialized();
}

export function increaseFontScale(): void {
  ensureInitialized();
  setScale(currentScale + STEP);
}

export function decreaseFontScale(): void {
  ensureInitialized();
  setScale(currentScale - STEP);
}

export function resetFontScale(): void {
  setScale(DEFAULT_SCALE);
}
