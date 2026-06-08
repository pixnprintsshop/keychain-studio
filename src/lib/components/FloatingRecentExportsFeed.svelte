<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import ExportFeedUserAvatar from '$lib/components/ExportFeedUserAvatar.svelte';
	import {
		formatExportFormatLabel,
		getDesignerDisplayName
	} from '$lib/designerDisplayNames';
	import {
		dismissRecentExportToast,
		formatRelativeExportTime,
		loadRecentExportFeed,
		recentExportFeed,
		setRecentExportFeedExpanded,
		subscribeRecentExportFeed,
		type RecentExportEvent
	} from '$lib/recentExportFeed.svelte';

	let now = $state(Date.now());
	let nowInterval: ReturnType<typeof setInterval> | null = null;

	onMount(() => {
		void loadRecentExportFeed();
		const unsubscribe = subscribeRecentExportFeed();
		nowInterval = setInterval(() => {
			now = Date.now();
		}, 15000);
		return () => {
			unsubscribe();
			if (nowInterval !== null) clearInterval(nowInterval);
		};
	});

	onDestroy(() => {
		if (nowInterval !== null) clearInterval(nowInterval);
	});

	const showWidget = $derived(
		recentExportFeed.widgetVisible &&
			recentExportFeed.loaded &&
			(recentExportFeed.hasEvents || recentExportFeed.toastEvent)
	);

	const displayEvents = $derived(
		recentExportFeed.events.map((event) => ({
			event,
			relative: formatRelativeExportTime(event.createdAt, now)
		}))
	);

	function eventLabel(event: RecentExportEvent): string {
		return `${getDesignerDisplayName(event.designerId)} · ${formatExportFormatLabel(event.format)}`;
	}

	function toggleExpanded() {
		setRecentExportFeedExpanded(!recentExportFeed.expanded);
	}

	function handleToastClick() {
		dismissRecentExportToast();
		setRecentExportFeedExpanded(true);
	}
</script>

{#if showWidget}
	<div
		class="pointer-events-none fixed right-4 bottom-4 z-40 flex max-w-[min(100vw-2rem,20rem)] flex-col items-end gap-2 sm:right-5 sm:bottom-5"
		aria-live="polite"
	>
		{#if recentExportFeed.toastEvent && !recentExportFeed.expanded}
			<button
				type="button"
				class="pointer-events-auto flex w-full items-start gap-2.5 rounded-xl border border-emerald-200/90 bg-emerald-50/95 px-3 py-2.5 text-left shadow-lg ring-1 ring-emerald-100 backdrop-blur-sm transition animate-in fade-in slide-in-from-bottom-2 duration-300"
				onclick={handleToastClick}
			>
				<ExportFeedUserAvatar
					emailObscured={recentExportFeed.toastEvent.emailObscured}
					avatarUrl={recentExportFeed.toastEvent.avatarUrl}
					size="md"
				/>
				<span class="min-w-0">
					<span class="block text-[11px] font-semibold tracking-wide text-emerald-800 uppercase"
						>Just exported</span
					>
					<span class="mt-0.5 block truncate text-sm font-medium text-emerald-950">
						{eventLabel(recentExportFeed.toastEvent)}
					</span>
					<span class="mt-0.5 block truncate text-[11px] text-emerald-800/75">
						{recentExportFeed.toastEvent.emailObscured}
					</span>
				</span>
			</button>
		{/if}

		<div class="pointer-events-auto w-full">
			<button
				type="button"
				class="flex w-full items-center gap-2.5 rounded-xl border border-slate-200/90 bg-white/92 px-3 py-2.5 shadow-sm backdrop-blur-sm transition hover:border-slate-300 hover:bg-white"
				aria-expanded={recentExportFeed.expanded}
				onclick={toggleExpanded}
			>
				<span
					class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600"
					aria-hidden="true"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						class="size-4"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
						stroke-width="2"
					>
						<path d="M12 8v4l3 3" />
						<circle cx="12" cy="12" r="9" />
					</svg>
				</span>
				<span class="min-w-0 flex-1 text-left leading-tight">
					<span class="block text-xs font-semibold text-slate-800">Recent exports</span>
					<span class="block truncate text-[11px] text-slate-500">
						{#if recentExportFeed.events[0]}
							{eventLabel(recentExportFeed.events[0])}
						{:else}
							Live activity
						{/if}
					</span>
				</span>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					class={[
						'size-4 shrink-0 text-slate-400 transition-transform',
						recentExportFeed.expanded ? 'rotate-180' : ''
					].join(' ')}
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
					stroke-width="2"
					aria-hidden="true"
				>
					<polyline points="6 9 12 15 18 9" />
				</svg>
			</button>

			{#if recentExportFeed.expanded}
				<div
					class="mt-2 max-h-64 overflow-y-auto rounded-xl border border-slate-200/90 bg-white/95 p-1.5 shadow-md backdrop-blur-sm"
				>
					<ul class="space-y-1">
						{#each displayEvents as { event, relative } (event.id)}
							<li
								class={[
									'flex items-center gap-2.5 rounded-lg px-2 py-2 text-xs',
									recentExportFeed.toastEvent?.id === event.id
										? 'bg-emerald-50 text-emerald-950'
										: 'text-slate-700'
								].join(' ')}
							>
								<ExportFeedUserAvatar
									emailObscured={event.emailObscured}
									avatarUrl={event.avatarUrl}
								/>
								<div class="min-w-0 flex-1">
									<p class="truncate font-medium">
										{getDesignerDisplayName(event.designerId)}
									</p>
									<p class="truncate text-[10px] text-slate-400">
										{event.emailObscured}
									</p>
								</div>
								<div class="shrink-0 text-right leading-tight">
									<p class="text-[11px] text-slate-500">
										{formatExportFormatLabel(event.format)}
									</p>
									<p class="text-[10px] text-slate-400 tabular-nums">
										{relative}
									</p>
								</div>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		</div>
	</div>
{/if}
