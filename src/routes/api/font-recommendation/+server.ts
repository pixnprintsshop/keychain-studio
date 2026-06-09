import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/private';
import { isTelegramNotifyEnabled } from '$lib/server/opsInDev';
import { getFlag, resolveIpAndCountry, summarizeUserAgent } from '$lib/server/visit-info';

const TELEGRAM_API = 'https://api.telegram.org';
const TELEGRAM_BODY_MAX = 3500;
const RECOMMENDATION_MAX = 500;

async function sendTelegramNotification(params: {
	recommendation: string;
	email: string | null;
	userId: string | null;
	subscriptionStatus: string | null;
	country: string | null;
	ip: string | null;
	device: string;
}): Promise<boolean> {
	if (!isTelegramNotifyEnabled()) return true;

	const token = env.TELEGRAM_BOT_TOKEN;
	const chatId = env.TELEGRAM_CHAT_ID;
	if (!token || !chatId) {
		console.warn(
			'Telegram font recommendation: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not configured'
		);
		return false;
	}

	const flag = getFlag(params.country ?? undefined);
	const lines: string[] = [
		'🔤 Font recommendation',
		`📝 ${params.recommendation}`,
		`${flag} Country: ${params.country ?? '—'}`,
		`🌐 IP: ${params.ip ?? '—'}`,
		''
	];

	if (params.email || params.userId) {
		if (params.email) lines.push(`📧 Email: ${params.email}`);
		if (params.userId) lines.push(`🆔 User: ${params.userId}`);
		if (params.subscriptionStatus) lines.push(`📋 Status: ${params.subscriptionStatus}`);
	} else {
		lines.push('👤 Guest');
	}

	lines.push('', `📱 Device: ${params.device}`, `🕐 Time: ${new Date().toISOString()}`);

	let message = lines.join('\n');
	if (message.length > TELEGRAM_BODY_MAX) message = `${message.slice(0, TELEGRAM_BODY_MAX)}…`;

	try {
		const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				chat_id: chatId,
				text: message,
				disable_web_page_preview: true
			})
		});
		if (!res.ok) {
			const errBody = await res.text();
			console.error('Telegram font recommendation error:', res.status, errBody);
			return false;
		}
		return true;
	} catch (err) {
		console.error('Telegram font recommendation error:', err);
		return false;
	}
}

export const POST: RequestHandler = async ({ request }) => {
	let data: unknown;
	try {
		data = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const { recommendation, subscriptionStatus } = (data ?? {}) as {
		recommendation?: string;
		subscriptionStatus?: string;
	};

	if (!recommendation || typeof recommendation !== 'string') {
		return json({ error: 'Recommendation required' }, { status: 400 });
	}

	const text = recommendation.trim();
	if (text.length < 2) {
		return json({ error: 'Recommendation too short' }, { status: 400 });
	}
	if (text.length > RECOMMENDATION_MAX) {
		return json({ error: 'Recommendation too long' }, { status: 400 });
	}

	const supabaseUrl = env.VITE_SUPABASE_URL;
	const supabaseAnonKey = env.VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY;
	const supabaseServiceKey = env.SUPABASE_SERVICE_ROLE_KEY;

	if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceKey) {
		console.error('Font recommendation: Supabase is not configured');
		return json({ error: 'Font recommendations are not configured' }, { status: 503 });
	}

	let userId: string | null = null;
	let email: string | null = null;

	const authHeader = request.headers.get('Authorization');
	const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
	if (token) {
		const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey);
		const {
			data: { user },
			error
		} = await supabaseAuth.auth.getUser(token);
		if (!error && user) {
			userId = user.id;
			email = user.email ?? null;
		}
	}

	const { ip, country } = await resolveIpAndCountry(request);
	const device = summarizeUserAgent(request.headers.get('user-agent'));
	const statusText =
		typeof subscriptionStatus === 'string' && subscriptionStatus.trim()
			? subscriptionStatus.trim().slice(0, 120)
			: null;

	const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
	const { error: insertError } = await supabaseAdmin.from('font_recommendations').insert({
		user_id: userId,
		email,
		recommendation: text,
		subscription_status: statusText,
		country: country ?? null,
		user_agent: device
	});

	if (insertError) {
		console.error('Font recommendation insert error:', insertError.message);
	}

	const telegramOk = await sendTelegramNotification({
		recommendation: text,
		email,
		userId,
		subscriptionStatus: statusText,
		country: country ?? null,
		ip: ip ?? null,
		device
	});

	if (insertError && !telegramOk) {
		return json({ error: 'Failed to save recommendation' }, { status: 500 });
	}

	return json({ ok: true, saved: !insertError, telegram: telegramOk });
};
