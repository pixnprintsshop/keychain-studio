import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';

const LEMONSQUEEZY_API = 'https://api.lemonsqueezy.com/v1';

interface VariantAttrs {
	name?: string;
	price?: number;
	interval?: string | null;
	interval_count?: number | null;
	is_subscription?: boolean;
	has_free_trial?: boolean;
	trial_interval?: string | null;
	trial_interval_count?: number | null;
}

interface StoreAttrs {
	currency?: string;
}

function formatPrice(cents: number, currency: string): string {
	try {
		return new Intl.NumberFormat(undefined, {
			style: 'currency',
			currency,
			minimumFractionDigits: 0,
			maximumFractionDigits: 0
		}).format(cents / 100);
	} catch {
		return `${currency} ${(cents / 100).toFixed(0)}`;
	}
}

interface PriceAttrs {
	trial_interval_unit?: string | null;
	trial_interval_quantity?: number | null;
}

function formatTrialLabelFromVariant(attrs: VariantAttrs | undefined): string | null {
	if (!attrs?.has_free_trial || !attrs.trial_interval_count || !attrs.trial_interval) return null;
	return `${attrs.trial_interval_count}-${attrs.trial_interval} free trial`;
}

function formatTrialLabelFromPrice(attrs: PriceAttrs | undefined): string | null {
	if (!attrs?.trial_interval_quantity || !attrs?.trial_interval_unit) return null;
	return `${attrs.trial_interval_quantity}-${attrs.trial_interval_unit} free trial`;
}

export const GET: RequestHandler = async () => {
	const storeId = env.LEMONSQUEEZY_STORE_ID;
	const apiKey = env.LEMONSQUEEZY_API_KEY;
	const variantMonthlyId = env.LEMONSQUEEZY_VARIANT_MONTHLY_ID;
	const variantYearlyId = env.LEMONSQUEEZY_VARIANT_YEARLY_ID;

	if (!storeId || !apiKey || !variantMonthlyId || !variantYearlyId) {
		return json({ error: 'Pricing not configured' }, { status: 500 });
	}

	const headers = {
		Accept: 'application/vnd.api+json',
		'Content-Type': 'application/vnd.api+json',
		Authorization: `Bearer ${apiKey}`
	};

	try {
		// Fetch store for currency
		const storeRes = await fetch(`${LEMONSQUEEZY_API}/stores/${storeId}`, { headers });
		if (!storeRes.ok) {
			console.error('Lemon Squeezy store fetch error:', storeRes.status);
			return json({ error: 'Failed to load pricing' }, { status: 502 });
		}
		const storeData = (await storeRes.json()) as { data?: { attributes?: StoreAttrs } };
		const currency = storeData?.data?.attributes?.currency ?? 'USD';

		// Fetch variants and prices in parallel
		const [monthlyVariantRes, yearlyVariantRes, monthlyPricesRes, yearlyPricesRes] = await Promise.all([
			fetch(`${LEMONSQUEEZY_API}/variants/${variantMonthlyId}`, { headers }),
			fetch(`${LEMONSQUEEZY_API}/variants/${variantYearlyId}`, { headers }),
			fetch(`${LEMONSQUEEZY_API}/prices?filter[variant_id]=${variantMonthlyId}`, { headers }),
			fetch(`${LEMONSQUEEZY_API}/prices?filter[variant_id]=${variantYearlyId}`, { headers })
		]);

		if (!monthlyVariantRes.ok || !yearlyVariantRes.ok) {
			console.error('Lemon Squeezy variant fetch error');
			return json({ error: 'Failed to load pricing' }, { status: 502 });
		}

		const monthlyJson = (await monthlyVariantRes.json()) as { data?: { attributes?: VariantAttrs } };
		const yearlyJson = (await yearlyVariantRes.json()) as { data?: { attributes?: VariantAttrs } };

		const monthlyAttrs = monthlyJson?.data?.attributes;
		const yearlyAttrs = yearlyJson?.data?.attributes;

		// Get trial from Price object (trial moved from Variant to Price in newer API)
		const monthlyPriceAttrs = (await monthlyPricesRes.json()) as {
			data?: Array<{ attributes?: PriceAttrs }>;
		};
		const yearlyPriceAttrs = (await yearlyPricesRes.json()) as {
			data?: Array<{ attributes?: PriceAttrs }>;
		};
		const monthlyPriceObj = monthlyPriceAttrs?.data?.[0]?.attributes;
		const yearlyPriceObj = yearlyPriceAttrs?.data?.[0]?.attributes;

		const monthlyPrice = monthlyAttrs?.price ?? 0;
		const yearlyPrice = yearlyAttrs?.price ?? 0;

		const monthlyPerMonthCents = yearlyPrice > 0 ? Math.round(yearlyPrice / 12) : 0;
		const monthlyFullPriceDollars = monthlyPrice > 0 ? (monthlyPrice / 100) * 12 : 0;
		const yearlyPriceDollars = yearlyPrice / 100;
		const yearlySavingsDollars = monthlyFullPriceDollars - yearlyPriceDollars;
		const yearlySavingsCents = Math.round(yearlySavingsDollars * 100);

		const monthlyTrial =
			formatTrialLabelFromVariant(monthlyAttrs) ?? formatTrialLabelFromPrice(monthlyPriceObj);
		const yearlyTrial =
			formatTrialLabelFromVariant(yearlyAttrs) ?? formatTrialLabelFromPrice(yearlyPriceObj);

		return json({
			currency,
			monthly: {
				name: monthlyAttrs?.name ?? 'Monthly',
				price: monthlyPrice,
				priceFormatted: formatPrice(monthlyPrice, currency),
				interval: monthlyAttrs?.interval ?? 'month',
				intervalCount: monthlyAttrs?.interval_count ?? 1,
				trialLabel: monthlyTrial,
				description: 'Billed every month. Cancel anytime.'
			},
			yearly: {
				name: yearlyAttrs?.name ?? 'Yearly',
				price: yearlyPrice,
				priceFormatted: formatPrice(yearlyPrice, currency),
				interval: yearlyAttrs?.interval ?? 'year',
				intervalCount: yearlyAttrs?.interval_count ?? 1,
				trialLabel: yearlyTrial,
				monthlyEquivalentCents: monthlyPerMonthCents,
				monthlyEquivalentFormatted: formatPrice(monthlyPerMonthCents, currency),
				savings: yearlySavingsDollars,
				savingsFormatted: formatPrice(yearlySavingsCents, currency)
			}
		});
	} catch (err) {
		console.error('Pricing fetch error:', err);
		return json({ error: 'Failed to load pricing' }, { status: 500 });
	}
};
