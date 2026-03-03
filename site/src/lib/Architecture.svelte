<script lang="ts">
	interface ArchStep {
		label: string;
		sublabel: string;
	}

	const steps: ArchStep[] = [
		{ label: 'Terminal', sublabel: 'attn' },
		{ label: 'Unix Socket', sublabel: '~/.attn/' },
		{ label: 'Daemon', sublabel: 'fork' },
		{ label: 'Native Window', sublabel: 'wry/WebKit' }
	];
</script>

<div>
	<h2 class="font-serif text-3xl font-bold text-foreground text-center">How it works</h2>
	<p class="font-sans text-lg text-muted-foreground mt-4 text-center max-w-2xl mx-auto leading-relaxed">
		Svelte 5 frontend compiled by Vite, embedded into a Rust binary.
		No bundled server. One self-contained executable.
	</p>

	<!-- Desktop flow (horizontal) -->
	<div class="hidden md:flex items-center justify-center gap-3 mt-12">
		{#each steps as step, i}
			<div class="bg-card border border-border rounded-lg px-5 py-4 text-center min-w-[140px]">
				<div class="font-sans font-semibold text-foreground">{step.label}</div>
				<div class="font-mono text-xs text-muted-foreground mt-1">{step.sublabel}</div>
			</div>
			{#if i < steps.length - 1}
				<span class="font-sans text-2xl text-muted-foreground select-none">&rarr;</span>
			{/if}
		{/each}
	</div>

	<!-- Mobile flow (vertical) -->
	<div class="flex md:hidden flex-col items-center gap-3 mt-12">
		{#each steps as step, i}
			<div class="bg-card border border-border rounded-lg px-5 py-4 text-center w-full max-w-[220px]">
				<div class="font-sans font-semibold text-foreground">{step.label}</div>
				<div class="font-mono text-xs text-muted-foreground mt-1">{step.sublabel}</div>
			</div>
			{#if i < steps.length - 1}
				<span class="font-sans text-2xl text-muted-foreground select-none">&darr;</span>
			{/if}
		{/each}
	</div>
</div>
