<script lang="ts">
	// Static landing page for app homepage (Google OAuth / app verification requirements).
	// Visible without login. Accurately represents the app and explains data usage.
</script>

<svelte:head>
	<title>Print Studio — 3D Customizer for Makers | PixnPrints</title>
	<meta name="description" content="Print Studio is a browser-based 3D customizer. Personalize keychains, name tags, pencil toppers, and more. Export STL/3MF for 3D printing." />
</svelte:head>

<main class="min-h-dvh overflow-hidden">
	<!-- Hero -->
	<div class="relative bg-linear-to-br from-[#4A90E2] to-[#2A65B9] px-4 pt-16 pb-24 sm:pt-24 sm:pb-32">
		<div class="relative mx-auto max-w-3xl text-center">
			<img
				src="/app-logo-full-white.png"
				alt="Print Studio by PixnPrints"
				class="mx-auto h-14 w-auto sm:h-20 md:h-24"
			/>
			<p class="mt-6 text-lg text-white/95 sm:text-xl">
				Browser-based 3D customizer for makers. Personalize templates, export STL/3MF—no CAD required.
			</p>
			<a
				href="/"
				class="mt-8 inline-flex items-center gap-2 rounded-xl bg-[#E53935] px-6 py-3.5 text-base font-semibold text-white shadow-lg transition hover:bg-[#c62828]"
			>
				Open Print Studio
				<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7l5 5m0 0l-5 5m5-5H6" />
				</svg>
			</a>
		</div>
	</div>

	<!-- Content -->
	<div class="relative -mt-12 px-4 pb-16 sm:px-6">
		<div class="mx-auto max-w-4xl space-y-8">
			<!-- How it works -->
			<section class="rounded-2xl border border-slate-200/80 bg-white p-6 shadow-xl shadow-slate-200/50 sm:p-10">
				<h2 class="text-xl font-semibold text-slate-900 sm:text-2xl">How it works</h2>
				<p class="mt-2 text-slate-600">
					Print Studio is a 3D customizer for makers. Choose from templates—keychains, name tags, pencil toppers, dog tags, charms, and more. Personalize text, colors, and sizes, then export STL or 3MF for your 3D printer.
				</p>
				<div class="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
					<div class="flex gap-4">
						<div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-red-100 text-[#E53935]">
							<span class="text-sm font-bold">1</span>
						</div>
						<div>
							<p class="font-medium text-slate-900">Pick a template</p>
							<p class="mt-0.5 text-sm text-slate-600">Keychain, name tag, topper, charm, and more</p>
						</div>
					</div>
					<div class="flex gap-4">
						<div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-red-100 text-[#E53935]">
							<span class="text-sm font-bold">2</span>
						</div>
						<div>
							<p class="font-medium text-slate-900">Customize</p>
							<p class="mt-0.5 text-sm text-slate-600">Text, colors, dimensions in the browser</p>
						</div>
					</div>
					<div class="flex gap-4">
						<div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-red-100 text-[#E53935]">
							<span class="text-sm font-bold">3</span>
						</div>
						<div>
							<p class="font-medium text-slate-900">Preview</p>
							<p class="mt-0.5 text-sm text-slate-600">Real-time 3D preview in your browser</p>
						</div>
					</div>
					<div class="flex gap-4">
						<div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-red-100 text-[#E53935]">
							<span class="text-sm font-bold">4</span>
						</div>
						<div>
							<p class="font-medium text-slate-900">Export</p>
							<p class="mt-0.5 text-sm text-slate-600">Download STL or 3MF for your printer</p>
						</div>
					</div>
				</div>
			</section>

			<!-- Data & privacy -->
			<section class="rounded-2xl border border-slate-200/80 bg-slate-50/80 p-6 sm:p-10">
				<h2 class="text-xl font-semibold text-slate-900 sm:text-2xl">Why we request your data</h2>
				<p class="mt-2 text-slate-600">
					To provide subscription access, save your preferences, and manage your account, we may collect:
				</p>
				<ul class="mt-4 space-y-3 sm:space-y-2">
					<li class="flex gap-3 text-slate-700">
						<svg class="mt-0.5 h-5 w-5 shrink-0 text-[#E53935]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
						</svg>
						<span><strong>Account information</strong> (email, name) when you sign in with Google or email—used to identify you and provide subscription/license features</span>
					</li>
					<li class="flex gap-3 text-slate-700">
						<svg class="mt-0.5 h-5 w-5 shrink-0 text-[#E53935]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
						</svg>
						<span><strong>Usage data</strong> (e.g., which designers you use) to operate and improve the service</span>
					</li>
					<li class="flex gap-3 text-slate-700">
						<svg class="mt-0.5 h-5 w-5 shrink-0 text-[#E53935]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
						</svg>
						<span><strong>Design files</strong> you upload (e.g., SVG) only as needed to process and display your designs</span>
					</li>
				</ul>
				<p class="mt-4 text-slate-600">
					We do not sell your personal information.
				</p>
				<div class="mt-6 flex flex-wrap items-center gap-4">
					<a
						href="/"
						class="inline-flex items-center gap-2 rounded-lg bg-[#E53935] px-4 py-2.5 text-sm font-medium text-white transition hover:bg-[#c62828]"
					>
						Open Print Studio
						<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7l5 5m0 0l-5 5m5-5H6" />
						</svg>
					</a>
					<a
						href="/privacy"
						class="text-sm font-medium text-[#E53935] hover:text-[#c62828] hover:underline"
					>
						Privacy Policy →
					</a>
				</div>
			</section>
		</div>
	</div>

	<!-- Footer -->
	<footer class="border-t border-slate-200 bg-white px-4 py-6">
		<div class="mx-auto max-w-4xl text-center text-sm text-[#424242]">
			<p>Print Studio is provided by <span class="font-medium text-[#E53935]">PixnPrints</span>.</p>
		</div>
	</footer>
</main>
