<script lang="ts">
	import { getTheme } from './theme.svelte';

	// Live collaboration — the headline capability added in the collab epic
	// (live co-typing, inline review, end-to-end encryption, peer-to-peer).
	// The screenshot is a REAL capture of a reviewer's window during a live
	// session: the owner's shared doc with two labeled remote carets (amber
	// owner, blue reviewer), the "Shared document · end-to-end encrypted"
	// banner, presence chips, and the Live connection badge. Regenerate with
	// scripts/capture-collab-screenshots.sh.
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
			title: 'End-to-end encrypted',
			body: 'The room key lives in the invite link and never touches a server. The relay only ever sees ciphertext.'
		},
		{
			title: 'Peer-to-peer',
			body: 'Once connected, edits flow directly between people over WebRTC. The relay is just the handshake + fallback.'
		}
	];
</script>

<section id="collaborate" class="py-28 px-6">
	<div class="max-w-5xl mx-auto">
		<div class="text-center max-w-2xl mx-auto mb-12">
			<p class="font-sans text-sm font-semibold uppercase tracking-widest text-primary mb-4">
				New
			</p>
			<h2 class="font-serif text-4xl md:text-5xl font-bold tracking-tight text-foreground">
				Review markdown together
			</h2>
			<p class="font-sans text-lg text-muted-foreground mt-5 leading-relaxed">
				Share a doc with a link. Co-type, comment, and suggest in real time —
				end-to-end encrypted, peer-to-peer. No accounts, no cloud copy of your words.
			</p>
		</div>

		<!-- Real screenshot of a live session (theme-aware) -->
		<div
			class="relative rounded-xl shadow-2xl border border-border overflow-hidden bg-card max-w-4xl mx-auto"
		>
			<img
				src="/screenshots/collab-light.png"
				alt="A live attn session: shared doc with the owner's amber caret and a reviewer's blue caret, end-to-end encrypted"
				class="w-full transition-opacity duration-500"
				class:opacity-0={getTheme() === 'dark'}
			/>
			<img
				src="/screenshots/collab-dark.png"
				alt="A live attn session in dark mode with two collaborators' cursors"
				class="absolute inset-0 w-full transition-opacity duration-500"
				class:opacity-0={getTheme() !== 'dark'}
			/>
		</div>

		<!-- Feature points -->
		<div class="grid sm:grid-cols-2 gap-x-10 gap-y-8 mt-16 max-w-3xl mx-auto">
			{#each points as point, i}
				<div class="flex gap-4">
					<span
						class="flex-shrink-0 font-mono text-sm w-8 h-8 rounded-full border border-border flex items-center justify-center text-muted-foreground"
					>
						{i + 1}
					</span>
					<div>
						<h3 class="font-serif text-xl font-semibold text-foreground">{point.title}</h3>
						<p class="font-sans text-muted-foreground mt-1 leading-relaxed">{point.body}</p>
					</div>
				</div>
			{/each}
		</div>
	</div>
</section>
