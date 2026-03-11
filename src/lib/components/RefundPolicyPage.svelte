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
			<h1 class="text-2xl font-bold tracking-tight text-slate-900">Refund Policy</h1>
			<p class="mt-1 text-sm text-slate-500">
				Last updated: {new Date().toLocaleDateString('en-US', {
					year: 'numeric',
					month: 'long',
					day: 'numeric'
				})}
			</p>

			<div class="prose prose-slate mt-8 max-w-none text-sm text-slate-700">
				<h2 class="text-lg font-semibold text-slate-900">1. Eligibility for Refunds</h2>
				<p class="mt-2">
					PixnPrints may offer refunds for Keychain Studio license subscriptions in certain
					circumstances, including but not limited to: extended or repeated service maintenance that
					prevents use of the app, duplicate or erroneous charges, or other issues we determine
					warrant a refund.
				</p>

				<h2 class="mt-6 text-lg font-semibold text-slate-900">2. How to Request a Refund</h2>
				<p class="mt-2">
					To request a refund, contact us via
					<a
						href="https://m.me/pixnprints.shop"
						target="_blank"
						rel="noopener noreferrer"
						class="font-medium text-indigo-600 hover:underline"
					>
						Facebook Messenger
					</a>. Please include your account email or the method you used to pay (e.g. transaction
					reference) so we can process your request. We will respond as soon as possible.
				</p>

				<h2 class="mt-6 text-lg font-semibold text-slate-900">3. Processing and Timeline</h2>
				<p class="mt-2">
					Approved refunds will be processed through the same channel used for payment (e.g. bank
					transfer or platform refund). Processing time may vary depending on the payment method and
					your financial institution. We will notify you once the refund has been initiated.
				</p>

				<h2 class="mt-6 text-lg font-semibold text-slate-900">4. No Refund in Other Cases</h2>
				<p class="mt-2">
					We do not guarantee refunds for change of mind, partial use of a subscription period, or
					if you simply stop using the service. Refund decisions are at our discretion and subject
					to the specific facts of each case.
				</p>

				<h2 class="mt-6 text-lg font-semibold text-slate-900">5. Contact</h2>
				<p class="mt-2">
					For any questions about this Refund Policy, contact us via
					<a
						href="https://m.me/pixnprints.shop"
						target="_blank"
						rel="noopener noreferrer"
						class="font-medium text-indigo-600 hover:underline"
					>
						Facebook Messenger
					</a>.
				</p>
			</div>
		</div>
	</div>
</main>
