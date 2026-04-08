<script lang="ts">
	import type { User } from '@supabase/supabase-js';
	import { Button } from '$lib/components/ui/button';
	import posthog from 'posthog-js';

	interface Props {
		user: User | null;
		onBack: () => void;
	}

	let { user, onBack }: Props = $props();

	let name = $state('');
	let email = $state('');
	let subject = $state('');
	let message = $state('');
	/** Honeypot — leave empty */
	let company = $state('');

	let submitting = $state(false);
	let submitError: string | null = $state(null);
	let submitSuccess = $state(false);

	const NAME_MAX = 200;
	const SUBJECT_MAX = 200;
	const MESSAGE_MAX = 5000;

	$effect(() => {
		const u = user;
		if (u?.email && email === '') {
			email = u.email;
		}
	});

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		if (company.trim() !== '') {
			submitSuccess = true;
			return;
		}
		submitting = true;
		submitError = null;
		submitSuccess = false;

		try {
			const res = await fetch('/api/contact', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: name.trim(),
					email: email.trim(),
					subject: subject.trim() || undefined,
					message: message.trim(),
					company
				})
			});

			const data = (await res.json()) as { ok?: boolean; error?: string };
			if (!res.ok) {
				submitError = data.error ?? 'Something went wrong. Please try again.';
				submitting = false;
				return;
			}

			posthog.capture('contact_submitted');
			submitSuccess = true;
			subject = '';
			message = '';
		} catch {
			submitError = 'Network error. Please try again.';
		} finally {
			submitting = false;
		}
	}
</script>

<main class="flex min-h-dvh w-dvw items-center justify-center bg-slate-50 p-4">
	<div
		class="w-full max-w-lg rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-sm sm:p-6 lg:p-8"
	>
		<header class="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
			<div class="flex items-center gap-3">
				<Button variant="outline" size="sm" class="rounded-full" onclick={onBack}>← Back</Button>
				<div>
					<h1 class="text-lg font-semibold tracking-tight text-slate-900">Contact us</h1>
					<p class="mt-1 text-xs text-slate-500">
						Questions, partnerships, or anything else — we’ll get back to you by email.
					</p>
				</div>
			</div>
		</header>

		<form class="grid gap-3 text-xs" onsubmit={handleSubmit}>
			<!-- Honeypot for bots -->
			<div class="absolute -left-[9999px] h-0 w-0 overflow-hidden" aria-hidden="true">
				<label for="contact-company">Company</label>
				<input id="contact-company" type="text" tabindex="-1" autocomplete="off" bind:value={company} />
			</div>

			<label class="grid gap-1.5">
				<span class="font-medium text-slate-700">Name</span>
				<input
					class="min-w-0 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-900 shadow-sm ring-indigo-500/25 outline-none focus:border-indigo-400 focus:ring-2"
					type="text"
					name="name"
					required
					maxlength={NAME_MAX}
					bind:value={name}
					autocomplete="name"
				/>
			</label>

			<label class="grid gap-1.5">
				<span class="font-medium text-slate-700">Email</span>
				<input
					class="min-w-0 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-900 shadow-sm ring-indigo-500/25 outline-none focus:border-indigo-400 focus:ring-2"
					type="email"
					name="email"
					required
					bind:value={email}
					autocomplete="email"
				/>
			</label>

			<label class="grid gap-1.5">
				<span class="font-medium text-slate-700">Subject (optional)</span>
				<input
					class="min-w-0 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-900 shadow-sm ring-indigo-500/25 outline-none focus:border-indigo-400 focus:ring-2"
					type="text"
					name="subject"
					maxlength={SUBJECT_MAX}
					bind:value={subject}
				/>
			</label>

			<label class="grid gap-1.5">
				<div class="flex items-center justify-between gap-2">
					<span class="font-medium text-slate-700">Message</span>
					<span class="text-[10px] text-slate-400">{message.length}/{MESSAGE_MAX}</span>
				</div>
				<textarea
					class="min-h-[120px] min-w-0 resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 shadow-sm ring-indigo-500/25 outline-none focus:border-indigo-400 focus:ring-2"
					name="message"
					required
					maxlength={MESSAGE_MAX}
					rows={5}
					bind:value={message}
					placeholder="How can we help?"
				></textarea>
			</label>

			{#if submitError}
				<p class="text-[11px] text-red-600">{submitError}</p>
			{/if}
			{#if submitSuccess}
				<p class="text-[11px] text-green-700">Thank you! Your message has been sent.</p>
			{/if}

			<div class="mt-2 flex justify-end">
				<Button type="submit" size="sm" disabled={submitting}>
					{#if submitting}
						Sending…
					{:else}
						Send message
					{/if}
				</Button>
			</div>
		</form>
	</div>
</main>
