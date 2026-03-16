<script lang="ts">
	import { Button } from '$lib/components/ui/button';

	interface Props {
		onBack: () => void;
	}
	let { onBack }: Props = $props();
</script>

<main class="min-h-dvh w-dvw bg-slate-50">
	<div class="mx-auto max-w-3xl px-4 py-8">
		<div class="mb-6 flex items-center justify-between">
			<Button variant="outline" size="sm" onclick={onBack}>
				Back
			</Button>
		</div>
		<div class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
			<h1 class="text-2xl font-bold tracking-tight text-slate-900">About Print Studio</h1>
			<p class="mt-1 text-sm text-slate-500">By PixnPrints</p>

			<div class="prose prose-slate mt-8 max-w-none text-sm text-slate-700">
				<h2 class="text-lg font-semibold text-slate-900">What is Print Studio?</h2>
				<p class="mt-2">
					Print Studio is a browser-based app that lets you design personalized 3D keychains (and
					more) without any 3D or CAD experience. Pick a style, add your text or upload your design,
					preview it in 3D, and export a file ready for 3D printing or a printing service.
				</p>

				<h2 class="mt-6 text-lg font-semibold text-slate-900">How it works</h2>
				<p class="mt-2">
					Choose from styles like text-only, flower + initial, custom SVG, keycap maker, whistle,
					dog tag, and others. Customize with your name, message, or artwork. The app runs in your
					browser and shows a 3D preview. When you’re happy, export an STL (or other format) to
					print yourself or send to a maker or print shop.
				</p>

				<h2 class="mt-6 text-lg font-semibold text-slate-900">Who it’s for</h2>
				<p class="mt-2">
					Print Studio is for anyone who wants unique keychains, gifts, or small personalized
					items: individuals, makers, small businesses, and event organizers.
				</p>

				<h2 class="mt-6 text-lg font-semibold text-slate-900">Contact</h2>
				<p class="mt-2">
					Questions or feedback? Reach out via
					<a
						href="https://m.me/pixnprints.shop"
						target="_blank"
						rel="noopener noreferrer"
						class="font-medium text-indigo-600 hover:underline"
					>
						Facebook Messenger
					</a>.
				</p>
			</div>
		</div>
	</div>
</main>
