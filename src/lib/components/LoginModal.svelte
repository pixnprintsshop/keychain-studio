<script lang="ts">
	import { signIn, signInWithGoogle, signUp } from '$lib/auth';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import posthog from 'posthog-js';

	interface Props {
		isOpen?: boolean;
		onClose?: () => void;
		onSuccess?: () => void;
	}

	let { isOpen = $bindable(false), onClose, onSuccess }: Props = $props();

	let isSigningIn = $state(false);
	let isSigningUp = $state(false);
	let isSigningInWithGoogle = $state(false);
	let errorMessage = $state('');
	let email = $state('');
	let password = $state('');
	let confirmPassword = $state('');
	let isSignUpMode = $state(false);
	let signUpSuccessMessage = $state('');

	function resetForm() {
		email = '';
		password = '';
		confirmPassword = '';
		errorMessage = '';
		signUpSuccessMessage = '';
		isSigningIn = false;
		isSigningUp = false;
		isSigningInWithGoogle = false;
	}

	function dismissSignUpSuccess() {
		signUpSuccessMessage = '';
	}

	function toggleMode() {
		isSignUpMode = !isSignUpMode;
		resetForm();
	}

	async function handleSubmit() {
		errorMessage = '';

		// Validation
		if (!email.trim()) {
			errorMessage = 'Please enter your email';
			return;
		}

		if (!password) {
			errorMessage = 'Please enter your password';
			return;
		}

		if (isSignUpMode) {
			if (password.length < 6) {
				errorMessage = 'Password must be at least 6 characters';
				return;
			}

			if (password !== confirmPassword) {
				errorMessage = 'Passwords do not match';
				return;
			}

			isSigningUp = true;
			const { error } = await signUp(email.trim(), password);

			if (error) {
				errorMessage = error.message || 'Failed to create account';
				isSigningUp = false;
			} else {
				// Success - show in-app message and switch to sign in mode
				errorMessage = '';
				signUpSuccessMessage =
					'Account created! Please check your email to confirm your account before signing in.';
				posthog.capture('user_signed_up', { method: 'email' });
				isSignUpMode = false;
				password = '';
				confirmPassword = '';
				isSigningUp = false;
			}
		} else {
			isSigningIn = true;
			const { error } = await signIn(email.trim(), password);

			if (error) {
				errorMessage = error.message || 'Failed to sign in';
				isSigningIn = false;
			} else {
				// Success
				errorMessage = '';
				posthog.capture('user_signed_in', { method: 'email' });
				isOpen = false;
				onSuccess?.();
			}
		}
	}

	async function handleGoogleSignIn() {
		errorMessage = '';
		isSigningInWithGoogle = true;
		posthog.capture('user_signed_in_google', { method: 'google' });
		const { error } = await signInWithGoogle();
		if (error) {
			errorMessage = error.message || 'Failed to sign in with Google';
		}
		isSigningInWithGoogle = false;
	}

	function handleClose() {
		resetForm();
		isOpen = false;
		onClose?.();
	}

	function onOpenChange(open: boolean) {
		if (!open) {
			resetForm();
			onClose?.();
		}
	}

	// Reset form when modal opens/closes
	$effect(() => {
		if (!isOpen) {
			resetForm();
		}
	});
</script>

<Dialog.Root bind:open={isOpen} {onOpenChange}>
	<Dialog.Content
		showCloseButton={false}
		class="max-w-md rounded-2xl border-slate-200 p-0 shadow-xl"
	>
		<div class="p-6">
			<div class="mb-4 flex items-center justify-between">
				<Dialog.Title id="login-title" class="text-2xl font-bold text-slate-900">
					{isSignUpMode ? 'Create Account' : 'Sign In'}
				</Dialog.Title>
				<Dialog.Close
					class="rounded-lg p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
				>
					<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M6 18L18 6M6 6l12 12"
						/>
					</svg>
					<span class="sr-only">Close dialog</span>
				</Dialog.Close>
			</div>

			<div class="space-y-4">
				<p class="text-sm leading-relaxed text-slate-600">
					{isSignUpMode
						? 'Create an account to save your designs and export them any time.'
						: 'Sign in to your account to export designs and access all features.'}
				</p>

				<!-- Success Message (after sign up) -->
				{#if signUpSuccessMessage}
					<div
						class="flex items-start gap-3 rounded-lg border border-green-200 bg-green-50 p-4"
						role="status"
						aria-live="polite"
					>
						<div class="mt-0.5 shrink-0">
							<svg class="h-5 w-5 text-green-600" fill="currentColor" viewBox="0 0 20 20">
								<path
									fill-rule="evenodd"
									d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"
									clip-rule="evenodd"
								/>
							</svg>
						</div>
						<div class="min-w-0 flex-1">
							<p class="text-sm font-medium text-green-800">
								{signUpSuccessMessage}
							</p>
							<Button
								variant="link"
								class="mt-2 text-sm text-green-700 hover:text-green-800"
								onclick={dismissSignUpSuccess}
							>
								Dismiss
							</Button>
						</div>
						<Button
							variant="ghost"
							size="icon-sm"
							class="shrink-0 text-green-600 hover:bg-green-100"
							onclick={dismissSignUpSuccess}
							aria-label="Dismiss"
						>
							<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M6 18L18 6M6 6l12 12"
								/>
							</svg>
						</Button>
					</div>
				{/if}

				<!-- Error Message -->
				{#if errorMessage}
					<div class="rounded-lg border border-red-200 bg-red-50 p-3">
						<p class="text-sm text-red-800">{errorMessage}</p>
					</div>
				{/if}

				<!-- Sign in with Google -->
				<Button
					variant="outline"
					class="w-full"
					onclick={handleGoogleSignIn}
					disabled={isSigningIn || isSigningUp || isSigningInWithGoogle}
				>
					{#if isSigningInWithGoogle}
						<svg
							class="h-5 w-5 animate-spin text-slate-500"
							xmlns="http://www.w3.org/2000/svg"
							fill="none"
							viewBox="0 0 24 24"
						>
							<circle
								class="opacity-25"
								cx="12"
								cy="12"
								r="10"
								stroke="currentColor"
								stroke-width="4"
							></circle>
							<path
								class="opacity-75"
								fill="currentColor"
								d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
							></path>
						</svg>
						<span>Redirecting to Google…</span>
					{:else}
						<svg class="h-5 w-5" viewBox="0 0 24 24">
							<path
								fill="#4285F4"
								d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
							/>
							<path
								fill="#34A853"
								d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
							/>
							<path
								fill="#FBBC05"
								d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
							/>
							<path
								fill="#EA4335"
								d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
							/>
						</svg>
						Sign in with Google
					{/if}
				</Button>

				<div class="relative">
					<div class="absolute inset-0 flex items-center">
						<div class="w-full border-t border-slate-200"></div>
					</div>
					<div class="relative flex justify-center text-sm">
						<span class="bg-white px-2 text-slate-500">Or continue with email</span>
					</div>
				</div>

				<!-- Email Input -->
				<div>
					<label for="email" class="mb-1 block text-sm font-medium text-slate-700"> Email </label>
					<input
						id="email"
						type="email"
						class="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-900 transition-colors placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none"
						placeholder="you@example.com"
						bind:value={email}
						disabled={isSigningIn || isSigningUp}
						onkeydown={(e) => {
							if (e.key === 'Enter') {
								handleSubmit();
							}
						}}
					/>
				</div>

				<!-- Password Input -->
				<div>
					<label for="password" class="mb-1 block text-sm font-medium text-slate-700">
						Password
					</label>
					<input
						id="password"
						type="password"
						class="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-900 transition-colors placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none"
						placeholder={isSignUpMode ? 'At least 6 characters' : 'Enter your password'}
						bind:value={password}
						disabled={isSigningIn || isSigningUp}
						onkeydown={(e) => {
							if (e.key === 'Enter') {
								handleSubmit();
							}
						}}
					/>
				</div>

				<!-- Confirm Password (Sign Up Only) -->
				{#if isSignUpMode}
					<div>
						<label for="confirmPassword" class="mb-1 block text-sm font-medium text-slate-700">
							Confirm Password
						</label>
						<input
							id="confirmPassword"
							type="password"
							class="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-900 transition-colors placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none"
							placeholder="Confirm your password"
							bind:value={confirmPassword}
							disabled={isSigningIn || isSigningUp}
							onkeydown={(e) => {
								if (e.key === 'Enter') {
									handleSubmit();
								}
							}}
						/>
					</div>
				{/if}

				<!-- Submit Button -->
				<Button class="w-full" onclick={handleSubmit} disabled={isSigningIn || isSigningUp}>
					{#if isSigningIn || isSigningUp}
						<span class="flex items-center justify-center gap-2">
							<svg
								class="h-5 w-5 animate-spin"
								xmlns="http://www.w3.org/2000/svg"
								fill="none"
								viewBox="0 0 24 24"
							>
								<circle
									class="opacity-25"
									cx="12"
									cy="12"
									r="10"
									stroke="currentColor"
									stroke-width="4"
								></circle>
								<path
									class="opacity-75"
									fill="currentColor"
									d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
								></path>
							</svg>
							<span>
								{isSigningUp ? 'Creating Account...' : 'Signing In...'}
							</span>
						</span>
					{:else}
						{isSignUpMode ? 'Create Account' : 'Sign In'}
					{/if}
				</Button>

				<!-- Toggle Sign Up/Sign In -->
				<div class="text-center text-sm text-slate-600">
					{#if isSignUpMode}
						Already have an account?
						<Button variant="link" class="ml-1" onclick={toggleMode}>Sign In</Button>
					{:else}
						Don't have an account?
						<Button variant="link" class="ml-1" onclick={toggleMode}>Sign Up</Button>
					{/if}
				</div>

				<p class="text-center text-xs text-slate-500">
					By {isSignUpMode ? 'creating an account' : 'signing in'}, you agree to our terms of
					service and privacy policy.
				</p>
			</div>
		</div>
	</Dialog.Content>
</Dialog.Root>
