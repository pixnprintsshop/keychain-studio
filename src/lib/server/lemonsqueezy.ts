import { env } from '$env/dynamic/private';

export const LEMONSQUEEZY_API = 'https://api.lemonsqueezy.com/v1';

export interface LemonSqueezyEnv {
	storeId: string;
	apiKey: string;
	variantMonthlyId: string;
	variantYearlyId: string;
}

export function getLemonSqueezyEnv(): LemonSqueezyEnv | null {
	const storeId = env.LEMONSQUEEZY_STORE_ID;
	const apiKey = env.LEMONSQUEEZY_API_KEY;
	const variantMonthlyId = env.LEMONSQUEEZY_VARIANT_MONTHLY_ID;
	const variantYearlyId = env.LEMONSQUEEZY_VARIANT_YEARLY_ID;
	if (!storeId || !apiKey || !variantMonthlyId || !variantYearlyId) return null;
	return { storeId, apiKey, variantMonthlyId, variantYearlyId };
}

export function variantIdForPlan(
	ls: LemonSqueezyEnv,
	plan: 'monthly' | 'yearly'
): string {
	return plan === 'monthly' ? ls.variantMonthlyId : ls.variantYearlyId;
}

export async function lemonSqueezyFetch(
	apiKey: string,
	path: string,
	init?: RequestInit
): Promise<Response> {
	return fetch(`${LEMONSQUEEZY_API}${path}`, {
		...init,
		headers: {
			Accept: 'application/vnd.api+json',
			'Content-Type': 'application/vnd.api+json',
			Authorization: `Bearer ${apiKey}`,
			...init?.headers
		}
	});
}

interface SubscriptionAttributes {
	status?: string;
	urls?: {
		customer_portal?: string;
		customer_portal_update_subscription?: string;
	};
}

interface SubscriptionResponse {
	data?: {
		id?: string;
		attributes?: SubscriptionAttributes;
	};
}

export function portalUrlFromSubscription(data: SubscriptionResponse): string | null {
	const urls = data?.data?.attributes?.urls;
	return urls?.customer_portal_update_subscription ?? urls?.customer_portal ?? null;
}
