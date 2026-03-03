<script lang="ts">
	interface Props {
		title: string;
		description: string;
	}

	let { title, description }: Props = $props();
</script>

<div class="bg-card border border-border rounded-xl p-6">
	<h4 class="font-sans font-semibold text-lg text-card-foreground">{title}</h4>
	<p class="font-sans text-muted-foreground mt-2">{description}</p>
</div>
