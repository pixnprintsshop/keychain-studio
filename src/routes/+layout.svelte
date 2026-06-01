<script lang="ts">
	import { onMount } from 'svelte';
	import { inject } from '@vercel/analytics';
	import App from '$lib/App.svelte';
	import './layout.css';

	let { children } = $props();

	onMount(() => {
		inject();
	});
</script>

<App>{@render children()}</App>
