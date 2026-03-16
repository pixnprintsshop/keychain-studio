<script lang="ts">
    import type { Snippet } from "svelte";
    import { Button } from '$lib/components/ui/button';

    export interface Props {
        open: boolean;
        title?: string;
        subtitle?: string;
        onClose: () => void;
        children?: Snippet;
    }

    let {
        open = false,
        title = "Before you start",
        subtitle = "For the best results with custom SVGs, please keep these in mind:",
        onClose,
        children,
    }: Props = $props();

    function handleKeydown(e: KeyboardEvent) {
        if (e.key === "Escape") onClose();
    }
</script>

{#if open}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="svg-info-modal-title"
        onclick={onClose}
        onkeydown={handleKeydown}
        tabindex="-1">
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
            class="relative w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-xl"
            onclick={(e) => e.stopPropagation()}>
            <h2
                id="svg-info-modal-title"
                class="text-lg font-semibold text-slate-900">
                {title}
            </h2>
            {#if subtitle}
                <p class="mt-1 text-sm text-slate-600">
                    {subtitle}
                </p>
            {/if}
            {#if children}
                <div class="mt-3 text-sm text-slate-600">
                    {@render children?.()}
                </div>
            {:else}
                <ul
                    class="mt-3 list-inside list-disc space-y-2 text-sm text-slate-600">
                    <li>
                        <strong>Compatibility:</strong> Not every SVG will work—complex
                        paths, filters, or unsupported features may cause issues.
                    </li>
                    <li>
                        <strong>Format:</strong> Use black-and-white artwork only,
                        and keep file size under 1 MB.
                    </li>
                    <li>
                        <strong>Extrusion:</strong> We extrude a single flat layer
                        from your paths; grays, gradients, and shading are ignored—only
                        the outline shape is used.
                    </li>
                </ul>
            {/if}
            <div class="mt-5 flex justify-end">
                <Button onclick={onClose}>
                    Got it
                </Button>
            </div>
        </div>
    </div>
{/if}
