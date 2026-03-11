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
			<h1 class="text-2xl font-bold tracking-tight text-slate-900">Terms and Conditions</h1>
			<p class="mt-1 text-sm text-slate-500">
				Last updated: {new Date().toLocaleDateString('en-US', {
					year: 'numeric',
					month: 'long',
					day: 'numeric'
				})}
			</p>

			<div class="prose prose-slate mt-8 max-w-none text-sm text-slate-700">
				<h2 class="text-lg font-semibold text-slate-900">1. Acceptance of Terms</h2>
				<p class="mt-2">
					By accessing or using Keychain Studio ("the Service") by PixnPrints, you agree to be bound
					by these Terms and Conditions. If you do not agree, please do not use the Service.
				</p>

				<h2 class="mt-6 text-lg font-semibold text-slate-900">2. Description of Service</h2>
				<p class="mt-2">
					Keychain Studio allows you to create and customize 3D keychain designs. You may export
					designs for personal or commercial use subject to your license and these terms.
				</p>

				<h2 class="mt-6 text-lg font-semibold text-slate-900">3. User Accounts and License</h2>
				<p class="mt-2">
					Some features require an account and a valid license (free trial or paid). You are
					responsible for keeping your account credentials secure and for all activity under your
					account. License terms may limit export rights or number of devices; you must comply with
					the license you have selected.
				</p>

				<h2 class="mt-6 text-lg font-semibold text-slate-900">4. Pricing and Payment</h2>
				<p class="mt-2">
					Subscription plans (e.g. monthly and yearly) and current pricing are shown in the app
					under <strong>Pricing</strong>. Payment is arranged through the channels described in
					<strong>How to obtain or buy a license</strong> (e.g. contact via Messenger, payment via QR
					code, then license code delivery). Refunds may be available in certain circumstances (e.g. extended
					maintenance); contact us to request a refund. We do not store your payment card details in the
					app; any payment is handled outside the Service.
				</p>

				<h2 class="mt-6 text-lg font-semibold text-slate-900">5. Acceptable Use</h2>
				<p class="mt-2">
					You may not use the Service to create or distribute content that is illegal, infringing,
					defamatory, or otherwise harmful. You may not reverse-engineer, scrape, or overload the
					Service. We may suspend or terminate access for violation of these terms.
				</p>

				<h2 class="mt-6 text-lg font-semibold text-slate-900">6. Intellectual Property</h2>
				<p class="mt-2">
					The Service and its design, features, and branding are owned by PixnPrints. Designs you
					create using the Service are yours; you grant us a limited license to process and store
					your content as needed to provide the Service.
				</p>

				<h2 class="mt-6 text-lg font-semibold text-slate-900">7. Disclaimers</h2>
				<p class="mt-2">
					The Service is provided "as is." We do not guarantee uninterrupted or error-free
					operation. Export files are for your use; you are responsible for the suitability of
					designs for manufacturing or resale.
				</p>

				<h2 class="mt-6 text-lg font-semibold text-slate-900">8. Limitation of Liability</h2>
				<p class="mt-2">
					To the fullest extent permitted by law, PixnPrints shall not be liable for any indirect,
					incidental, special, or consequential damages arising from your use of the Service.
				</p>

				<h2 class="mt-6 text-lg font-semibold text-slate-900">9. Changes</h2>
				<p class="mt-2">
					We may update these Terms from time to time. Continued use of the Service after changes
					constitutes acceptance. We will indicate the last updated date at the top of this page.
				</p>

				<h2 class="mt-6 text-lg font-semibold text-slate-900">10. Contact</h2>
				<p class="mt-2">
					For questions about these Terms, contact us via
					<a
						href="https://m.me/pixnprints.shop"
						target="_blank"
						rel="noopener noreferrer"
						class="font-medium text-indigo-600 hover:underline"
					>
						Facebook Messenger
					</a>
					or through the link under <strong>How to obtain or buy a license</strong> in the app.
				</p>
			</div>
		</div>
	</div>
</main>
