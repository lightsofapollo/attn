type ThemeName = 'light' | 'dark';

let theme = $state<ThemeName>('light');

export function getTheme(): ThemeName {
	return theme;
}

export function toggleTheme(): void {
	const next: ThemeName = theme === 'light' ? 'dark' : 'light';
	theme = next;
	document.documentElement.classList.toggle('dark', next === 'dark');
	document.documentElement.setAttribute('data-theme', next);
	localStorage.setItem('attn-theme', next);
}

export function initTheme(): void {
	const stored = document.documentElement.dataset.theme;
	if (stored === 'dark') {
		theme = 'dark';
	} else {
		theme = 'light';
	}
}
