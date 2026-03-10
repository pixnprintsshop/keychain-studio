<script lang="ts">
    interface Props {
        onBack: () => void;
    }
    let { onBack }: Props = $props();

    const MONTHLY_PESOS = 300;
    const YEARLY_PESOS = 3000;
    const MONTHLY_PER_MONTH = YEARLY_PESOS / 12;
</script>

<main class="min-h-dvh w-dvw bg-slate-50">
    <div class="mx-auto max-w-3xl px-4 py-8">
        <div class="mb-6 flex items-center justify-between">
            <button
                type="button"
                class="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
                onclick={onBack}>
                Back
            </button>
        </div>
        <div
            class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <h1 class="text-2xl font-bold tracking-tight text-slate-900">
                Pricing
            </h1>
            <p class="mt-1 text-sm text-slate-500">
                Keychain Studio by PixnPrints
            </p>

            <div class="mt-8 grid gap-4 sm:grid-cols-2">
                <div
                    class="rounded-xl border border-slate-200 bg-slate-50/50 p-6">
                    <h2 class="text-lg font-semibold text-slate-900">
                        Monthly
                    </h2>
                    <p class="mt-2 text-2xl font-bold text-slate-900">
                        ₱{MONTHLY_PESOS}
                        <span class="text-sm font-normal text-slate-500"
                            >/month</span
                        >
                    </p>
                    <p class="mt-2 text-sm text-slate-600">
                        Billed every month. Cancel anytime.
                    </p>
                </div>
                <div
                    class="rounded-xl border-2 border-indigo-200 bg-indigo-50/30 p-6">
                    <span
                        class="inline-block rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-800">
                        Best value
                    </span>
                    <h2 class="mt-2 text-lg font-semibold text-slate-900">
                        Yearly
                    </h2>
                    <p class="mt-2 text-2xl font-bold text-slate-900">
                        ₱{YEARLY_PESOS}
                        <span class="text-sm font-normal text-slate-500"
                            >/year</span
                        >
                    </p>
                    <p class="mt-1 text-sm text-slate-600">
                        ₱{MONTHLY_PER_MONTH.toFixed(0)}/month — save ₱{(MONTHLY_PESOS * 12 - YEARLY_PESOS)} per year
                    </p>
                </div>
            </div>

            <p class="mt-6 text-sm text-slate-600">
                To get a license, go to
                <strong>License</strong> in the app or see
                <strong>How to obtain or buy a license</strong> for payment
                options.
            </p>
        </div>
    </div>
</main>
