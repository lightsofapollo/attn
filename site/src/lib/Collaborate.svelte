<script lang="ts">
	import { getTheme } from './theme.svelte';

	// Live collaboration — the headline capability added in the collab epic.
	// The hero shows a real capture of a live review session (comment cards +
	// cursors); this section breaks down what makes it work and shows the real
	// Share dialog. Copy is deliberately accurate: ALWAYS end-to-end encrypted
	// (the relay/R2 only ever hold ciphertext); peer-to-peer WHEN the network
	// allows, with the encrypted relay as the fallback.
	const points = [
		{
			title: 'Live co-typing',
			body: 'Everyone edits at once, with labeled cursors. Owner-authority OT keeps it conflict-free — no merge dialogs.'
		},
		{
			title: 'Inline comments & suggestions',
			body: 'Select text, comment, or propose an edit the author accepts with one keystroke — right where you read.'
		},
		{
			title: 'Always end-to-end encrypted',
			body: 'The room key lives in the invite link and never touches a server — so the relay, and anything it stores, only ever sees ciphertext. Never your words.'
		},
		{
			title: 'Peer-to-peer when it can',
			body: 'When both sides can reach each other, edits flow directly over WebRTC. When they can’t, the same encrypted bytes ride the relay — relayed, never readable.'
		}
	];
</script>

<section id="collaborate" class="py-28 px-6">
	<div class="max-w-4xl mx-auto">
		<div class="text-center max-w-2xl mx-auto mb-14">
			<p class="font-sans text-sm font-semibold uppercase tracking-widest text-primary mb-4">
				New
			</p>
			<h2 class="font-serif text-4xl md:text-5xl font-bold tracking-tight text-foreground">
				Review markdown together
			</h2>
			<p class="font-sans text-lg text-muted-foreground mt-5 leading-relaxed">
				Share a doc with a link. Co-type, comment, and suggest in real time —
				always end-to-end encrypted, peer-to-peer when the network allows. No
				accounts, and no server can read a word.
			</p>
		</div>

		<div class="grid sm:grid-cols-2 gap-x-12 gap-y-10">
			{#each points as point, i}
				<div class="flex gap-4">
					<span
						class="flex-shrink-0 font-mono text-sm w-9 h-9 rounded-full border border-border flex items-center justify-center text-muted-foreground"
					>
						{i + 1}
					</span>
					<div>
						<h3 class="font-serif text-xl font-semibold text-foreground">{point.title}</h3>
						<p class="font-sans text-muted-foreground mt-1.5 leading-relaxed">{point.body}</p>
					</div>
				</div>
			{/each}
		</div>

		<!-- Share in one click — the real Share dialog (npx command + direct link) -->
		<div class="mt-20 text-center max-w-2xl mx-auto">
			<h3 class="font-serif text-2xl md:text-3xl font-bold tracking-tight text-foreground">
				Share in one click
			</h3>
			<p class="font-sans text-muted-foreground mt-3 leading-relaxed">
				Hit Share and send a link — or an <code class="font-mono text-sm">npx</code> command that
				downloads attn on first run. No account, no signup, encrypted end to end.
			</p>
		</div>
		<div
			class="relative mt-8 rounded-xl shadow-2xl border border-border overflow-hidden bg-card max-w-3xl mx-auto"
		>
			<img
				src="/screenshots/share-light.png"
				alt="The attn Share-for-review dialog: an npx invite command and a direct attn:// link, end-to-end encrypted"
				class="w-full transition-opacity duration-500"
				class:opacity-0={getTheme() === 'dark'}
			/>
			<img
				src="/screenshots/share-dark.png"
				alt="The attn Share-for-review dialog in dark mode"
				class="absolute inset-0 w-full transition-opacity duration-500"
				class:opacity-0={getTheme() !== 'dark'}
			/>
		</div>
	</div>
</section>
