<script lang="ts">
	import Hero from '$lib/Hero.svelte';
	import FeatureSection from '$lib/FeatureSection.svelte';
	import FeatureCard from '$lib/FeatureCard.svelte';
	import CodeBlock from '$lib/CodeBlock.svelte';
	import KeyboardShortcuts from '$lib/KeyboardShortcuts.svelte';
	import Architecture from '$lib/Architecture.svelte';
</script>

<svelte:head>
	<title>attn — a markdown viewer for the terminal</title>
</svelte:head>

<Hero />

<!-- Pitch callout -->
<section class="py-24 px-6 text-center">
	<p class="font-serif text-3xl md:text-4xl leading-relaxed max-w-3xl mx-auto text-foreground">
		~8 MB. One binary.<br />
		No Electron. No browser.<br />
		Just your markdown, rendered beautifully.
	</p>
</section>

<!-- Feature zigzag sections -->
<div id="features" class="max-w-6xl mx-auto px-6">
	<FeatureSection
		title="Live reload"
		description="Save a file, see the change. No refresh button. attn watches your files and reloads instantly."
		lightSrc="/screenshots/hero-light.png"
		darkSrc="/screenshots/hero-dark.png"
		alt="attn sidebar with file tree and tabs"
	/>
	<FeatureSection
		title="Built-in editor"
		description="Hit ⌘E. Full ProseMirror editor with syntax highlighting, math, and mermaid."
		lightSrc="/screenshots/editor-light.png"
		darkSrc="/screenshots/editor-dark.png"
		alt="attn editor mode"
		reverse
	/>
	<FeatureSection
		title="Click a checkbox"
		description="Click a task in the UI. It writes back to the file. Your CLI tools see the change too."
		lightSrc="/screenshots/checkboxes-light.png"
		darkSrc="/screenshots/checkboxes-dark.png"
		alt="Interactive task list"
	/>
	<FeatureSection
		title="Find anything"
		description="⌘P to find any file. Lazy-loads folders so it's fast on huge repos."
		lightSrc="/screenshots/search-light.png"
		darkSrc="/screenshots/search-dark.png"
		alt="Command palette fuzzy search"
		reverse
	/>
</div>

<!-- Secondary features 2x2 grid -->
<section class="py-24 px-6 max-w-4xl mx-auto">
	<div class="grid md:grid-cols-2 gap-6">
		<FeatureCard title="Mermaid diagrams" description="Flowcharts, sequence diagrams rendered inline from fenced code blocks." />
		<FeatureCard title="Media playback" description="Images with zoom/pan, video and audio natively in the viewer." />
		<FeatureCard title="Tabs & projects" description="Open multiple files, switch projects with ⌘;. One daemon." />
		<FeatureCard title="Math rendering" description="KaTeX for inline and display math. Write $...$ and it renders." />
	</div>
</section>

<!-- Keyboard shortcuts -->
<section class="py-24 px-6 max-w-3xl mx-auto">
	<h2 class="font-serif text-3xl font-bold text-center mb-12">Keyboard shortcuts</h2>
	<KeyboardShortcuts />
</section>

<!-- Architecture -->
<section class="py-24 px-6 max-w-4xl mx-auto">
	<Architecture />
</section>

<!-- Install -->
<section id="install" class="py-24 px-6 max-w-2xl mx-auto">
	<h2 class="font-serif text-3xl font-bold text-center mb-12">Install</h2>
	<div class="space-y-4">
		<CodeBlock label="Rust (recommended)" code="cargo install attn" />
		<CodeBlock label="npm" code="npx attnmd" />
		<CodeBlock label="From source" code="git clone https://github.com/lightsofapollo/attn && cd attn && cargo install --path ." />
	</div>
</section>
