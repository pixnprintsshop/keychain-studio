<script lang="ts">
    export interface Props {
        open: boolean;
        title: string;
        description: string;
        /** Optional id for the title element (for aria-labelledby). */
        titleId?: string;
    }

    let {
        open = false,
        title,
        description,
        titleId = "loading-modal-title",
    }: Props = $props();
</script>

{#if open}
    <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy="true">
        <div
            class="relative w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
            <div class="flex flex-col items-center gap-4 text-center">
                <div
                    class="h-10 w-10 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600"
                    aria-hidden="true">
                </div>
                <div class="space-y-1">
                    <h2
                        id={titleId}
                        class="text-lg font-semibold text-slate-900">
                        {title}
                    </h2>
                    <p class="text-sm text-slate-600">
                        {description}
                    </p>
                </div>
            </div>
        </div>
    </div>
{/if}
