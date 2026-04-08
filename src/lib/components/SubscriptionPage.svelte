<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { getSession } from '$lib/auth';
	import { getSubscriptionStatus } from '$lib/subscription';
	import { supabase } from '$lib/supabase';
	import type { SubscriptionStatus } from '$lib/subscription';

	interface Props {
		onBack: () => void;
	}

	let { onBack }: Props = $props();

	let loading = $state(true);
	let subscriptionStatus = $state<SubscriptionStatus | null>(null);
	let subscriptionDetails = $state<{
		status: string;
		plan: string;
		ends_at: string | null;
		renews_at: string | null;
		created_at: string;
	} | null>(null);
	let licenseDetails = $state<{
		activated_at: string;
		expires_at: string | null;
	} | null>(null);

	function formatDate(iso: string | null | undefined): string {
		if (!iso) return '—';
		try {
			return new Date(iso).toLocaleDateString(undefined, {
				year: 'numeric',
				month: 'long',
				day: 'numeric'
			});
		} catch {
			return iso;
		}
	}

	onMount(async () => {
		const session = await getSession();
		if (!session?.user?.id) {
			loading = false;
			return;
		}
		subscriptionStatus = await getSubscriptionStatus(session.user.id);
		if (subscriptionStatus?.source === 'subscription') {
			const { data } = await supabase
				.from('subscriptions')
				.select('status, plan, ends_at, renews_at, created_at')
				.eq('user_id', session.user.id)
				.maybeSingle();
			if (data) {
				subscriptionDetails = {
					status: data.status as string,
					plan: data.plan as string,
					ends_at: data.ends_at as string | null,
					renews_at: data.renews_at as string | null,
					created_at: data.created_at as string
				};
			}
		} else if (subscriptionStatus?.source === 'license') {
			const res = await fetch('/api/license/status', {
				headers: { Authorization: `Bearer ${session.access_token}` }
			});
			if (res.ok) {
				const data = (await res.json()) as { activated?: boolean; activated_at?: string; expires_at?: string | null };
				if (data.activated && data.activated_at) {
					licenseDetails = {
						activated_at: data.activated_at,
						expires_at: data.expires_at ?? null
					};
				}
			}
		}
		loading = false;
	});
</script>

<main class="min-h-dvh w-dvw bg-slate-50">
	<div class="mx-auto max-w-2xl px-4 py-8">
		<div class="mb-6 flex items-center justify-between">
			<Button variant="outline" size="sm" onclick={onBack}>
				Back
			</Button>
		</div>
		<div class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
			<h1 class="text-2xl font-bold tracking-tight text-slate-900">
				Subscription
			</h1>
			<p class="mt-1 text-sm text-slate-500">
				Your Print Studio access status
			</p>

			{#if loading}
				<div class="mt-8 flex items-center justify-center py-12">
					<div class="h-8 w-8 animate-spin rounded-full border-2 border-indigo-600 border-t-transparent"></div>
				</div>
			{:else if subscriptionStatus?.licenseExpired}
				<div class="mt-8 rounded-xl border border-amber-200 bg-amber-50/80 p-6">
					<p class="text-sm font-medium text-amber-900">License expired</p>
					<p class="mt-2 text-sm text-amber-800">
						Your license has expired. Subscribe or activate a new license to restore full export access.
					</p>
					<div class="mt-4 flex gap-3">
						<Button href="/pricing">View pricing</Button>
						<Button variant="outline" href="/pricing#home">Back to app</Button>
					</div>
				</div>
			{:else if !subscriptionStatus?.isActive}
				<div class="mt-8 rounded-xl border border-slate-200 bg-slate-50/80 p-6">
					<p class="text-sm font-medium text-slate-900">No active subscription</p>
					<p class="mt-2 text-sm text-slate-600">
						Subscribe to unlock full export and all designers. You can also activate a license code if you
						purchased one directly.
					</p>
					<div class="mt-4 flex gap-3">
						<Button href="/pricing">View pricing</Button>
						<Button variant="outline" href="/pricing#home">Back to app</Button>
					</div>
				</div>
			{:else if subscriptionStatus?.source === 'license'}
				<div class="mt-8 rounded-xl border border-emerald-200 bg-emerald-50/80 p-6">
					<div class="flex items-center gap-2">
						<span
							class="rounded-full border border-emerald-200 bg-emerald-100 px-3 py-1 text-sm font-medium text-emerald-800"
						>
							Licensed
						</span>
					</div>
					<p class="mt-4 text-sm font-medium text-emerald-900">License active</p>
					<p class="mt-1 text-sm text-emerald-700">
						You have full export access via your license code.
					</p>
					{#if licenseDetails}
						<dl class="mt-6 grid gap-4 sm:grid-cols-2">
							<div>
								<dt class="text-xs font-medium uppercase tracking-wider text-slate-500">Activated</dt>
								<dd class="mt-1 text-sm text-slate-700">
									{formatDate(licenseDetails.activated_at)}
								</dd>
							</div>
							<div>
								<dt class="text-xs font-medium uppercase tracking-wider text-slate-500">Expires</dt>
								<dd class="mt-1 text-sm text-slate-700">
									{licenseDetails.expires_at ? formatDate(licenseDetails.expires_at) : 'Never'}
								</dd>
							</div>
						</dl>
					{/if}
					<Button variant="outline" size="sm" class="mt-6" onclick={onBack}>
						Back to app
					</Button>
				</div>
			{:else if subscriptionStatus?.source === 'subscription' && subscriptionDetails}
				<div class="mt-8 space-y-6">
					<div class="flex items-center gap-2">
						<span
							class="rounded-full border border-emerald-200 bg-emerald-100 px-3 py-1 text-sm font-medium text-emerald-800"
						>
							Subscribed
						</span>
						<span class="text-sm capitalize text-slate-600">
							{subscriptionDetails.plan} plan
						</span>
					</div>

					{#if subscriptionStatus?.cancelledPendingEnd && subscriptionDetails.ends_at}
						<p class="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
							You cancelled your subscription. Full access continues until
							{formatDate(subscriptionDetails.ends_at)}.
						</p>
					{/if}

					<dl class="grid gap-4 sm:grid-cols-2">
						<div>
							<dt class="text-xs font-medium uppercase tracking-wider text-slate-500">Status</dt>
							<dd class="mt-1 text-sm font-medium capitalize text-slate-900">
								{subscriptionDetails.status.replace('_', ' ')}
							</dd>
						</div>
						<div>
							<dt class="text-xs font-medium uppercase tracking-wider text-slate-500">Plan</dt>
							<dd class="mt-1 text-sm font-medium text-slate-900">
								{subscriptionDetails.plan === 'yearly' ? 'Yearly' : 'Monthly'}
							</dd>
						</div>
						{#if subscriptionDetails.renews_at}
							<div>
								<dt class="text-xs font-medium uppercase tracking-wider text-slate-500">Renews</dt>
								<dd class="mt-1 text-sm text-slate-700">
									{formatDate(subscriptionDetails.renews_at)}
								</dd>
							</div>
						{/if}
						{#if subscriptionDetails.ends_at}
							<div>
								<dt class="text-xs font-medium uppercase tracking-wider text-slate-500">Ends</dt>
								<dd class="mt-1 text-sm text-slate-700">
									{formatDate(subscriptionDetails.ends_at)}
								</dd>
							</div>
						{/if}
						<div>
							<dt class="text-xs font-medium uppercase tracking-wider text-slate-500">Started</dt>
							<dd class="mt-1 text-sm text-slate-700">
								{formatDate(subscriptionDetails.created_at)}
							</dd>
						</div>
					</dl>

					<p class="text-sm text-slate-600">
						To update payment method, cancel, or manage your subscription, visit your
						<a
							href="https://app.lemonsqueezy.com/my-orders"
							target="_blank"
							rel="noopener noreferrer"
							class="font-medium text-indigo-600 underline hover:no-underline"
						>
							Lemon Squeezy account
						</a>.
					</p>

					<Button variant="outline" size="sm" onclick={onBack}>
						Back to app
					</Button>
				</div>
			{:else}
				<div class="mt-8 rounded-xl border border-emerald-200 bg-emerald-50/80 p-6">
					<span
						class="inline-block rounded-full border border-emerald-200 bg-emerald-100 px-3 py-1 text-sm font-medium text-emerald-800"
					>
						Subscribed
					</span>
					<p class="mt-4 text-sm text-emerald-800">
						You have full export access.
					</p>
					<Button variant="outline" size="sm" class="mt-4" onclick={onBack}>
						Back to app
					</Button>
				</div>
			{/if}
		</div>
	</div>
</main>
