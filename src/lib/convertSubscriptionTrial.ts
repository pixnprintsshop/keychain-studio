export interface ConvertSubscriptionTrialResult {
	success: boolean;
	status?: string;
	requiresPortal?: boolean;
	url?: string;
	message?: string;
	error?: string;
}

/** End the Lemon Squeezy trial and charge immediately (unlimited exports). */
export async function convertSubscriptionTrial(
	accessToken: string,
	options?: { plan?: 'monthly' | 'yearly' }
): Promise<ConvertSubscriptionTrialResult> {
	try {
		const res = await fetch('/api/lemonsqueezy/convert-trial', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${accessToken}`
			},
			body: JSON.stringify(options?.plan ? { plan: options.plan } : {})
		});

		const data = (await res.json()) as ConvertSubscriptionTrialResult & { error?: string };

		if (data.requiresPortal && data.url) {
			return {
				success: false,
				requiresPortal: true,
				url: data.url,
				message: data.message
			};
		}

		if (!res.ok) {
			return { success: false, error: data.error ?? 'Failed to upgrade subscription' };
		}

		return {
			success: Boolean(data.success),
			status: data.status
		};
	} catch {
		return { success: false, error: 'Network error. Please try again.' };
	}
}
