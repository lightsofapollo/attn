<script lang="ts">
	interface Shortcut {
		keys: string;
		description: string;
	}

	const shortcuts: Shortcut[] = [
		{ keys: '\u2318P', description: 'Fuzzy search' },
		{ keys: '\u2318E', description: 'Toggle editor' },
		{ keys: '\u2318F', description: 'Find & replace' },
		{ keys: '\u2318;', description: 'Switch project' },
		{ keys: '\u2318W', description: 'Close tab' },
		{ keys: '\u2318/', description: 'All shortcuts' },
		{ keys: '\u2318=', description: 'Zoom in' },
		{ keys: '\u2318-', description: 'Zoom out' },
		{ keys: '\u23180', description: 'Reset zoom' },
		{ keys: '\u2318Tab', description: 'Next tab' }
	];
</script>

<div class="grid md:grid-cols-2 gap-x-12">
	{#each shortcuts as shortcut}
		<div class="flex justify-between items-center py-3 border-b border-border">
			<span class="font-sans text-muted-foreground">{shortcut.description}</span>
			<kbd class="bg-card border border-border rounded px-2 py-1 font-mono text-sm text-foreground">
				{shortcut.keys}
			</kbd>
		</div>
	{/each}
</div>
