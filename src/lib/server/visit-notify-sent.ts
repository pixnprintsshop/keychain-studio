import { createClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/private';

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type VisitNotifyKey = { keyType: 'user' | 'guest'; keyValue: string };

function resolveVisitNotifyKey(options: {
	userId?: string | null;
	guestKey?: string | null;
}): VisitNotifyKey | { error: string } {
	const userId = options.userId?.trim();
	const guestKey = options.guestKey?.trim();

	if (userId) {
		if (!UUID_RE.test(userId)) return { error: 'invalid_user_id' };
		return { keyType: 'user', keyValue: userId };
	}
	if (guestKey && guestKey.length >= 32) {
		return { keyType: 'guest', keyValue: guestKey };
	}
	return { error: 'missing_identity' };
}

function getServiceClient() {
	const supabaseUrl = env.VITE_SUPABASE_URL;
	const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
	if (!supabaseUrl || !serviceKey) return null;
	return createClient(supabaseUrl, serviceKey);
}

/**
 * Returns true when this user/guest has not been notified before and the row was
 * inserted. Returns false when they are a repeat visitor (unique violation).
 */
export async function claimFirstVisitNotifySlot(options: {
	userId?: string | null;
	guestKey?: string | null;
}): Promise<{ claimed: boolean; reason?: string; key?: VisitNotifyKey }> {
	const resolved = resolveVisitNotifyKey(options);
	if ('error' in resolved) {
		return { claimed: false, reason: resolved.error };
	}

	const supabase = getServiceClient();
	if (!supabase) {
		console.warn('visit notify: Supabase service role not configured; allowing send');
		return { claimed: true, key: resolved };
	}

	const { error } = await supabase.from('visit_notify_sent').insert({
		key_type: resolved.keyType,
		key_value: resolved.keyValue
	});

	if (!error) return { claimed: true, key: resolved };

	if (error.code === '23505') {
		return { claimed: false, reason: 'repeat_visitor' };
	}

	console.error('visit notify: claim slot failed:', error.message);
	return { claimed: true, key: resolved };
}

export async function releaseVisitNotifySlot(key: VisitNotifyKey): Promise<void> {
	const supabase = getServiceClient();
	if (!supabase) return;

	const { error } = await supabase
		.from('visit_notify_sent')
		.delete()
		.eq('key_type', key.keyType)
		.eq('key_value', key.keyValue);

	if (error) {
		console.warn('visit notify: failed to release slot:', error.message);
	}
}
