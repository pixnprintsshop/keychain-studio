<script lang="ts">
    interface Props {
        isOpen?: boolean;
        onClose?: () => void;
    }

    let { isOpen = $bindable(false), onClose }: Props = $props();

    function handleClose() {
        isOpen = false;
        onClose?.();
    }

    function handleKeydown(e: KeyboardEvent) {
        if (e.key === "Escape") {
            handleClose();
        }
    }

    // Social media links - update these with actual URLs
    const socialLinks = {
        facebook: "https://www.facebook.com/pixnprints.shop",
        tiktok: "https://www.tiktok.com/@pixnprints.shop_",
        shopee: "https://shopee.ph/pixnprints",
        lazada: "https://www.lazada.com.ph/shop/pixnprints",
    };
</script>

{#if isOpen}
    <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
        onclick={handleClose}
        onkeydown={handleKeydown}
        role="dialog"
        aria-modal="true"
        aria-labelledby="thank-you-title"
        tabindex="-1"
    >
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
            class="relative w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-xl"
            onclick={(e) => e.stopPropagation()}
        >
            <div class="p-6">
                <div class="mb-4 flex items-center justify-between">
                    <h2
                        id="thank-you-title"
                        class="text-2xl font-bold text-slate-900"
                    >
                        Thank You!
                    </h2>
                    <button
                        type="button"
                        class="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
                        onclick={handleClose}
                        aria-label="Close dialog"
                    >
                        <svg
                            class="h-5 w-5"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                        >
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M6 18L18 6M6 6l12 12"
                            />
                        </svg>
                    </button>
                </div>

                <div class="space-y-4">
                    <p class="text-sm leading-relaxed text-slate-600">
                        Thank you for using Keychain Studio! We hope you're
                        enjoying creating your custom designs.
                    </p>

                    <div
                        class="rounded-lg border border-slate-200 bg-slate-50 p-4"
                    >
                        <p class="mb-3 text-sm font-medium text-slate-900">
                            Follow us for updates and more designs:
                        </p>

                        <div class="grid grid-cols-2 gap-3">
                            <!-- Facebook -->
                            <a
                                href={socialLinks.facebook}
                                target="_blank"
                                rel="noopener noreferrer"
                                class="flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-3 transition-colors hover:bg-blue-50 hover:border-blue-300"
                            >
                                <svg
                                    class="h-5 w-5 text-blue-600"
                                    fill="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"
                                    />
                                </svg>
                                <span class="text-sm font-medium text-slate-700"
                                    >Facebook</span
                                >
                            </a>

                            <!-- TikTok -->
                            <a
                                href={socialLinks.tiktok}
                                target="_blank"
                                rel="noopener noreferrer"
                                class="flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-3 transition-colors hover:bg-black/5 hover:border-slate-300"
                            >
                                <svg
                                    class="h-5 w-5"
                                    fill="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1-.1z"
                                    />
                                </svg>
                                <span class="text-sm font-medium text-slate-700"
                                    >TikTok</span
                                >
                            </a>

                            <!-- Shopee -->
                            <a
                                href={socialLinks.shopee}
                                target="_blank"
                                rel="noopener noreferrer"
                                class="flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-3 transition-colors hover:bg-orange-50 hover:border-orange-300"
                            >
                                <img
                                    src="/shopee.png"
                                    alt="Shopee"
                                    class="h-5 w-5"
                                />
                                <span class="text-sm font-medium text-slate-700"
                                    >Shopee</span
                                >
                            </a>

                            <!-- Lazada -->
                            <a
                                href={socialLinks.lazada}
                                target="_blank"
                                rel="noopener noreferrer"
                                class="flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-3 transition-colors hover:bg-blue-50 hover:border-blue-300"
                            >
                                <img
                                    src="/lazada.png"
                                    alt="Lazada"
                                    class="h-5 w-5"
                                />
                                <span class="text-sm font-medium text-slate-700"
                                    >Lazada</span
                                >
                            </a>
                        </div>
                    </div>
                </div>

                <div class="mt-6 flex justify-end">
                    <button
                        type="button"
                        class="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
                        onclick={handleClose}
                    >
                        Continue
                    </button>
                </div>
            </div>
        </div>
    </div>
{/if}
