<script lang="ts">
    import type { LicenseStatus } from "$lib/licensing";
    import type { User } from "@supabase/supabase-js";
    import {
        type FeedbackCategory,
        type UserFeedbackRow,
        createFeedback,
        listFeedbackForUser,
    } from "$lib/feedback";

    interface Props {
        user: User | null;
        licenseStatus: LicenseStatus | null;
        onRequestLogin: () => void;
        onOpenLicenseInfo: () => void;
        onBack: () => void;
    }

    let {
        user,
        licenseStatus,
        onRequestLogin,
        onOpenLicenseInfo,
        onBack,
    }: Props = $props();

    const canSubmitFeedback = $derived(
        !!user && !!licenseStatus && licenseStatus.isPaid,
    );

    let category: FeedbackCategory = $state("general");
    let title = $state("");
    let message = $state("");
    let includeContext = $state(true);

    let submitting = $state(false);
    let submitError: string | null = $state(null);
    let submitSuccess = $state(false);

    let loadingList = $state(false);
    let listError: string | null = $state(null);
    let items: UserFeedbackRow[] = $state([]);

    async function loadFeedback() {
        if (!user) {
            items = [];
            return;
        }
        loadingList = true;
        listError = null;
        const { rows, error } = await listFeedbackForUser(user);
        if (error) listError = error;
        items = rows;
        loadingList = false;
    }

    $effect(() => {
        void user;
        loadFeedback();
    });

    async function handleSubmit(e: SubmitEvent) {
        e.preventDefault();
        if (!user) {
            onRequestLogin();
            return;
        }
        if (!canSubmitFeedback) {
            onOpenLicenseInfo();
            return;
        }
        submitting = true;
        submitError = null;
        submitSuccess = false;

        const context = includeContext
            ? {
                  view: "feedback",
                  timestamp: new Date().toISOString(),
              }
            : undefined;

        const result = await createFeedback({
            user,
            category,
            title,
            message,
            licenseStatus,
            context,
        });

        if (!result.success) {
            submitError = result.error;
            submitting = false;
            return;
        }

        // Best-effort email notification (Resend via backend route)
        try {
            if (user.email) {
                await fetch("/api/feedback-notify", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        userEmail: user.email,
                        category,
                        title,
                        message,
                        createdAt: result.row.created_at,
                    }),
                });
            }
        } catch {
            // Non-fatal: ignore notification failures
        }

        // Optimistically prepend new entry
        items = [result.row, ...items];

        // Reset form to defaults after successful submit
        category = "general";
        title = "";
        message = "";
        includeContext = true;

        submitSuccess = true;
        submitting = false;
    }
</script>

<main class="flex min-h-dvh w-dvw items-center justify-center bg-slate-50 p-4">
    <div
        class="w-full max-w-3xl rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-sm sm:p-6 lg:p-8">
        <header class="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div class="flex items-center gap-3">
                <button
                    type="button"
                    class="inline-flex items-center justify-center rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 shadow-sm hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60"
                    onclick={onBack}>
                    ← Back
                </button>
                <div>
                    <h1 class="text-lg font-semibold tracking-tight text-slate-900">
                        Feedback
                    </h1>
                    <p class="mt-1 text-xs text-slate-500">
                        Share questions, requests, or issues so we can improve Print Studio.
                    </p>
                </div>
            </div>
        </header>

        {#if !user}
            <div class="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-700 mb-6">
                <p class="mb-2">
                    Please sign in with your PixnPrints account to send feedback and see your previous messages.
                </p>
                <button
                    type="button"
                    class="inline-flex items-center rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60"
                    onclick={onRequestLogin}>
                    Sign in
                </button>
            </div>
        {:else if !licenseStatus || !licenseStatus.isPaid}
            <div class="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900 mb-6">
                <p class="mb-2">
                    Feedback is available for customers with a paid Print Studio license so we
                    can prioritize product support and feature requests.
                </p>
                <button
                    type="button"
                    class="inline-flex items-center rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-amber-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/60"
                    onclick={onOpenLicenseInfo}>
                    View licenses
                </button>
            </div>
        {/if}

        {#if canSubmitFeedback}
            <section class="mb-8 rounded-xl border border-slate-200 bg-slate-50/80 p-4">
                <h2 class="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Submit feedback
                </h2>
                <form class="grid gap-3 text-xs" onsubmit={handleSubmit}>
                    <div class="grid gap-1.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:items-center">
                        <label class="text-slate-700 font-medium" for="feedback-category">Category</label>
                        <select
                            id="feedback-category"
                            class="min-w-0 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
                            bind:value={category}>
                            <option value="general">General</option>
                            <option value="questions">Questions</option>
                            <option value="request">Request</option>
                            <option value="bug_report">Bug report</option>
                            <option value="feature_request">Feature request</option>
                        </select>
                    </div>

                    <label class="grid gap-1.5">
                        <span class="text-slate-700 font-medium">Title (optional)</span>
                        <input
                            class="min-w-0 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
                            type="text"
                            maxlength="150"
                            bind:value={title}
                            placeholder="Short summary" />
                    </label>

                    <label class="grid gap-1.5">
                        <div class="flex items-center justify-between gap-2">
                            <span class="text-slate-700 font-medium">Message</span>
                            <span class="text-[10px] text-slate-400">
                                {message.length}/2000
                            </span>
                        </div>
                        <textarea
                            class="min-w-0 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 shadow-sm outline-none ring-indigo-500/25 focus:border-indigo-400 focus:ring-2"
                            rows="4"
                            maxlength="2000"
                            bind:value={message}
                            placeholder="Describe your question, request, or issue in detail"></textarea>
                    </label>

                    <label class="flex items-center gap-2 text-[11px] text-slate-600">
                        <input
                            type="checkbox"
                            class="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                            bind:checked={includeContext} />
                        <span>Include basic app context (view and timestamp) with this feedback.</span>
                    </label>

                    {#if submitError}
                        <p class="text-[11px] text-red-600">{submitError}</p>
                    {/if}
                    {#if submitSuccess}
                        <p class="text-[11px] text-green-700">
                            Thank you! Your feedback has been sent.
                        </p>
                    {/if}

                    <div class="mt-2 flex justify-end">
                        <button
                            type="submit"
                            class="inline-flex items-center rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60 disabled:opacity-60"
                            disabled={submitting || !message.trim()}>
                            {#if submitting}
                                Sending…
                            {:else}
                                Send feedback
                            {/if}
                        </button>
                    </div>
                </form>
            </section>
        {/if}

        <section>
            <div class="mb-3 flex items-center justify-between gap-2">
                <h2 class="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Your feedback
                </h2>
                {#if loadingList}
                    <span class="text-[11px] text-slate-400">Loading…</span>
                {:else}
                    <button
                        type="button"
                        class="text-[11px] font-medium text-indigo-600 hover:text-indigo-700"
                        onclick={loadFeedback}>
                        Refresh
                    </button>
                {/if}
            </div>

            {#if !user}
                <p class="text-[11px] text-slate-500">
                    Sign in to see feedback you’ve sent.
                </p>
            {:else if listError}
                <p class="text-[11px] text-red-600">{listError}</p>
            {:else if !items.length}
                <p class="text-[11px] text-slate-500">
                    You haven’t sent any feedback yet.
                </p>
            {:else}
                <ul class="space-y-3 text-xs">
                    {#each items as item (item.id)}
                        <li class="rounded-lg border border-slate-200 bg-slate-50/80 px-3 py-2">
                            <div class="mb-1 flex items-center justify-between gap-2">
                                <span
                                    class="inline-flex items-center rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-700">
                                    {item.category.replace("_", " ")}
                                </span>
                                <span class="text-[10px] text-slate-400">
                                    {new Date(item.created_at).toLocaleString()}
                                </span>
                            </div>
                            {#if item.title}
                                <p class="mb-1 text-[11px] font-semibold text-slate-900">
                                    {item.title}
                                </p>
                            {/if}
                            <p class="text-[11px] leading-snug text-slate-700 whitespace-pre-wrap">
                                {item.message}
                            </p>
                        </li>
                    {/each}
                </ul>
            {/if}
        </section>
    </div>
</main>

