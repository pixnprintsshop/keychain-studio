import type { PaletteColor } from '$lib/colorPalette';
import type { SubscriptionStatus } from '$lib/subscription';
import type { Session, User } from '@supabase/supabase-js';
import { getContext, setContext } from 'svelte';

export const STUDIO_CONTEXT_KEY = Symbol('print-studio');

export type StudioContext = {
	readonly user: User | null;
	readonly session: Session | null;
	readonly subscriptionStatus: SubscriptionStatus | null;
	readonly palette: PaletteColor[];
	readonly isMobile: boolean;
	readonly subscriptionBootstrapComplete: boolean;
	readonly authBootstrapComplete: boolean;
	requestLogin: () => void;
	showPricing: () => void;
	showThankYou: () => void;
	goHome: () => void;
	savePalette: (colors: PaletteColor[]) => Promise<{ success: boolean; error?: string }>;
};

export function setStudioContext(ctx: StudioContext) {
	setContext(STUDIO_CONTEXT_KEY, ctx);
}

export function getStudioContext(): StudioContext {
	return getContext<StudioContext>(STUDIO_CONTEXT_KEY);
}
