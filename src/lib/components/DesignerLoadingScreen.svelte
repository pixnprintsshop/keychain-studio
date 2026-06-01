<script lang="ts">
	let { message = 'Loading designer…' }: { message?: string } = $props();
</script>

<main
	class="flex h-dvh w-dvw items-center justify-center bg-slate-50 p-4"
	aria-busy="true"
	aria-live="polite"
>
	<div class="flex flex-col items-center gap-4 text-center">
		<div
			class="h-10 w-10 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600"
			aria-hidden="true"
		></div>
		<p class="text-sm font-medium text-slate-600">{message}</p>
	</div>
</main>
