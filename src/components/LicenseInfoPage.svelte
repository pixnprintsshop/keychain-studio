<script lang="ts">
    interface Props {
        onBack: () => void;
    }
    let { onBack }: Props = $props();
</script>

<main class="min-h-dvh w-dvw bg-slate-50">
    <div class="mx-auto max-w-3xl px-4 py-8">
        <div class="mb-6 flex items-center justify-between">
            <button
                type="button"
                class="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
                onclick={onBack}
            >
                Back
            </button>
        </div>
        <div class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <h1 class="text-2xl font-bold tracking-tight text-slate-900">
                How to obtain or buy a license
            </h1>
            <p class="mt-1 text-sm text-slate-500">
                Keychain Studio by PixnPrints
            </p>

            <div class="mt-8 space-y-4 text-sm text-slate-700">
                <p>
                    For now, license purchase is manual while we work on an integrated payment option.
                </p>
                <ol class="list-decimal list-inside space-y-2">
                    <li>
                        Contact us via
                        <a
                            href="http://m.me/arabis.aldrin"
                            target="_blank"
                            rel="noopener noreferrer"
                            class="font-medium text-indigo-600 hover:underline"
                        >
                            Facebook Messenger
                        </a>.
                    </li>
                    <li>We’ll send you a payment QR code.</li>
                    <li>After payment, we’ll send you your license code.</li>
                    <li>
                        Sign in to the app, open <strong>License</strong>, enter the code, and click
                        <strong> Activate License</strong>.
                    </li>
                </ol>
            </div>
        </div>
    </div>
</main>
