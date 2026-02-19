<script lang="ts">
    interface Props {
        onSelect: (
            style: "textOutline" | "initial" | "flower" | "bone" | "basicName",
        ) => void;
    }

    let { onSelect }: Props = $props();
</script>

<div class="flex min-h-dvh w-dvw items-center justify-center bg-slate-50 p-6">
    <div class="w-full max-w-4xl">
        <div class="mb-10 text-center">
            <div class="mb-4 flex justify-center">
                <img
                    src="/app-logo.png"
                    alt="PixnPrints Logo"
                    class="h-16 w-auto object-contain"
                />
            </div>
            <h1 class="text-3xl font-bold tracking-tight text-slate-900">
                Keychain Studio
            </h1>
            <p class="mt-2 text-sm text-slate-500">
                Choose a style to start designing your 3D keychain
            </p>
        </div>

        <div class="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <!-- Text Outline card -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
                class="group cursor-pointer overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition hover:-translate-y-1 hover:shadow-lg hover:border-indigo-300"
                onclick={() => onSelect("textOutline")}
            >
                <div class="aspect-4/3 w-full overflow-hidden bg-slate-100">
                    <img
                        src="/images/text-only.png"
                        alt="Text Only preview"
                        class="h-full w-full object-cover transition group-hover:scale-105"
                    />
                </div>
                <div class="p-5">
                    <h2 class="text-lg font-semibold text-slate-900">
                        Text Only
                    </h2>
                    <p class="mt-1 text-sm leading-relaxed text-slate-500">
                        3D text with customizable outline. Keyring attaches to
                        the text outline.
                    </p>
                </div>
            </div>

            <!-- Initial + Text card -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
                class="group cursor-pointer overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition hover:-translate-y-1 hover:shadow-lg hover:border-indigo-300"
                onclick={() => onSelect("initial")}
            >
                <div class="aspect-4/3 w-full overflow-hidden bg-slate-100">
                    <img
                        src="/images/text+initial.png"
                        alt="Initial + Text preview"
                        class="h-full w-full object-cover transition group-hover:scale-105"
                    />
                </div>
                <div class="p-5">
                    <h2 class="text-lg font-semibold text-slate-900">
                        Initial + Text
                    </h2>
                    <p class="mt-1 text-sm leading-relaxed text-slate-500">
                        Big initial letter with text overlay. Keyring attaches
                        to the large initial.
                    </p>
                </div>
            </div>

            <!-- Flower card -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
                class="group cursor-pointer overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition hover:-translate-y-1 hover:shadow-lg hover:border-indigo-300"
                onclick={() => onSelect("flower")}
            >
                <div class="aspect-4/3 w-full overflow-hidden bg-slate-100">
                    <img
                        src="/images/flower+initial.png"
                        alt="Flower preview"
                        class="h-full w-full object-cover transition group-hover:scale-105"
                    />
                </div>
                <div class="p-5">
                    <h2 class="text-lg font-semibold text-slate-900">
                        Flower + Initial
                    </h2>
                    <p class="mt-1 text-sm leading-relaxed text-slate-500">
                        Flower keychain with customizable base and top layers.
                    </p>
                </div>
            </div>

            <!-- Basic Name Keychain card -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
                class="group cursor-pointer overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition hover:-translate-y-1 hover:shadow-lg hover:border-indigo-300"
                onclick={() => onSelect("basicName")}
            >
                <div class="aspect-4/3 w-full overflow-hidden bg-slate-100">
                    <img
                        src="/images/nametag.png"
                        alt="Basic Name Keychain preview"
                        class="h-full w-full object-cover transition group-hover:scale-105"
                    />
                </div>
                <div class="p-5">
                    <h2 class="text-lg font-semibold text-slate-900">
                        Basic Name Tag
                    </h2>
                    <p class="mt-1 text-sm leading-relaxed text-slate-500">
                        Rectangular keychain with rounded corners and name text.
                        Keyring at top.
                    </p>
                </div>
            </div>
        </div>

        <div
            class="mt-8 flex items-center justify-center gap-2 text-xs text-slate-400"
        >
            <span>By</span>
            <img
                src="/pixnprints-logo.png"
                alt="PixnPrints"
                class="h-10 w-auto object-contain"
            />
        </div>
    </div>
</div>
