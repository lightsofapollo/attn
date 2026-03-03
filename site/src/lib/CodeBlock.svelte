<script lang="ts">
	interface Props {
		label: string;
		code: string;
	}

	let { label, code }: Props = $props();
	let copied = $state(false);

	function copyToClipboard(): void {
		navigator.clipboard.writeText(code).then(() => {
			copied = true;
			setTimeout(() => {
				copied = false;
			}, 2000);
		});
	}
</script>

<div class="bg-code-block border border-border rounded-lg p-4">
	<div class="text-xs font-sans text-muted-foreground mb-2">{label}</div>
	<div class="flex justify-between items-center gap-4">
		<code class="font-mono text-sm text-foreground break-all">{code}</code>
		<button
			onclick={copyToClipboard}
			class="shrink-0 font-sans text-xs text-muted-foreground hover:text-foreground border border-border rounded px-2.5 py-1.5 hover:bg-accent transition-colors"
		>
			{copied ? 'Copied!' : 'Copy'}
		</button>
	</div>
</div>
