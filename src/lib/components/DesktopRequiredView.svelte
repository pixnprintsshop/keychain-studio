<script lang="ts">
	import { Button } from '$lib/components/ui/button';

	interface Props {
		onBack: () => void;
	}

	let { onBack }: Props = $props();
</script>

<div
	class="flex min-h-dvh w-dvw flex-col items-center justify-center bg-slate-50 px-6 py-12 text-center"
	role="main"
>
	<div class="flex max-w-sm flex-col items-center gap-6">
		<div
			class="flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl bg-slate-200/80 text-slate-500"
			aria-hidden="true"
		>
			<svg
				xmlns="http://www.w3.org/2000/svg"
				class="size-10"
				fill="none"
				viewBox="0 0 24 24"
				stroke-width="1.5"
				stroke="currentColor"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				<path
					d="M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0V12a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 12V5.25"
				/>
			</svg>
		</div>
		<div class="space-y-2">
			<h1 class="text-xl font-semibold text-slate-900">Best on desktop</h1>
			<p class="text-sm leading-relaxed text-slate-600">
				The designer works best on a desktop or laptop. You’ll need a larger screen to preview and
				export your 3D models for slicing.
			</p>
		</div>
		<Button onclick={onBack} class="w-full sm:w-auto">
			Back to home
		</Button>
	</div>
</div>
