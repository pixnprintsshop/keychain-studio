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
			<h1 class="text-2xl font-bold tracking-tight text-slate-900">Privacy Policy</h1>
			<p class="mt-1 text-sm text-slate-500">
				Last updated: {new Date().toLocaleDateString('en-US', {
					year: 'numeric',
					month: 'long',
					day: 'numeric'
				})}
			</p>

			<div class="prose prose-slate mt-8 max-w-none text-sm text-slate-700">
				<h2 class="text-lg font-semibold text-slate-900">1. Who We Are</h2>
				<p class="mt-2">
					Keychain Studio ("the Service") is provided by PixnPrints. This Privacy Policy explains
					how we collect, use, and protect your information when you use our app and services.
				</p>

				<h2 class="mt-6 text-lg font-semibold text-slate-900">2. Information We Collect</h2>
				<p class="mt-2">
					We may collect: (a) account information (email, name, password) when you sign up; (b)
					usage data (e.g., which designers you use, license status) to operate and improve the
					Service; (c) license and device-activation data (e.g. to enforce device limits per your
					license); (d) design files or content you upload (e.g., SVG, STL) only as necessary to
					process and display your designs. We do not sell your personal information.
				</p>

				<h2 class="mt-6 text-lg font-semibold text-slate-900">3. How We Use Your Information</h2>
				<p class="mt-2">
					We use your information to provide, secure, and improve the Service; to communicate with
					you about your account or license; and to comply with legal obligations. Processing of
					uploads (e.g., SVG processing) may involve temporary storage or transmission to our
					services; we do not use your designs for marketing or unrelated purposes.
				</p>

				<h2 class="mt-6 text-lg font-semibold text-slate-900">4. Data Storage and Security</h2>
				<p class="mt-2">
					We use industry-standard measures to protect your data. Account and usage data may be
					stored with trusted providers (e.g., Supabase). You are responsible for keeping your login
					credentials secure.
				</p>

				<h2 class="mt-6 text-lg font-semibold text-slate-900">5. Cookies and Local Storage</h2>
				<p class="mt-2">
					The app may use local storage (e.g., saved view, cached designs) to improve your
					experience. We may use cookies or similar technologies for authentication and analytics
					where applicable.
				</p>

				<h2 class="mt-6 text-lg font-semibold text-slate-900">6. Third-Party Services</h2>
				<p class="mt-2">
					We use third-party services for authentication, hosting, and analytics. Their use of your
					data is governed by their respective privacy policies. We only share data as needed to
					operate the Service. Payment is currently arranged outside the app (e.g. via contact and
					QR code); we do not process or store your payment card details in the Service.
				</p>

				<h2 class="mt-6 text-lg font-semibold text-slate-900">7. Your Rights</h2>
				<p class="mt-2">
					Depending on your location, you may have the right to access, correct, or delete your
					personal data, or to object to or restrict certain processing. Contact us to exercise
					these rights. You may also disable account features or delete your account where the
					Service allows.
				</p>

				<h2 class="mt-6 text-lg font-semibold text-slate-900">8. Children</h2>
				<p class="mt-2">
					The Service is not directed at children under 13. We do not knowingly collect personal
					information from children under 13. If you believe we have collected such information,
					please contact us.
				</p>

				<h2 class="mt-6 text-lg font-semibold text-slate-900">9. Changes to This Policy</h2>
				<p class="mt-2">
					We may update this Privacy Policy from time to time. We will post the updated policy and
					revise the "Last updated" date. Continued use of the Service after changes constitutes
					acceptance.
				</p>

				<h2 class="mt-6 text-lg font-semibold text-slate-900">10. Contact</h2>
				<p class="mt-2">
					For privacy-related questions or requests, contact us via
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
