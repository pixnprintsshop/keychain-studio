import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { FEEDBACK_NOTIFY_EMAIL, RESEND_API_KEY } from '$env/static/private';
import { sendContactEmail } from '$lib/server/email';

const TELEGRAM_API = 'https://api.telegram.org';
const MESSAGE_MAX = 5000;
const NAME_MAX = 200;
const SUBJECT_MAX = 200;
const TELEGRAM_BODY_MAX = 3500;

function looksLikeEmail(s: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	let data: unknown;
	try {
		data = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const body = (data ?? {}) as {
		name?: string;
		email?: string;
		subject?: string;
		message?: string;
		/** Honeypot — must be empty */
		company?: string;
	};

	if (body.company != null && String(body.company).trim() !== '') {
		return json({ ok: true });
	}

	const name = String(body.name ?? '').trim();
	const email = String(body.email ?? '').trim();
	const subject = body.subject != null ? String(body.subject).trim() : '';
	const message = String(body.message ?? '').trim();

	if (!name || name.length > NAME_MAX) {
		return json({ error: 'Invalid name' }, { status: 400 });
	}
	if (!email || !looksLikeEmail(email)) {
		return json({ error: 'Invalid email' }, { status: 400 });
	}
	if (subject.length > SUBJECT_MAX) {
		return json({ error: 'Subject too long' }, { status: 400 });
	}
	if (!message || message.length > MESSAGE_MAX) {
		return json({ error: 'Invalid message' }, { status: 400 });
	}

	const token = env.TELEGRAM_BOT_TOKEN;
	const chatId = env.TELEGRAM_CHAT_ID;
	const canTelegram = !!(token && chatId);
	const canEmail = !!(RESEND_API_KEY && (env.CONTACT_NOTIFY_EMAIL || FEEDBACK_NOTIFY_EMAIL));

	if (!canTelegram && !canEmail) {
		return json({ error: 'Contact form is not configured' }, { status: 503 });
	}

	let tgLine = message;
	if (tgLine.length > TELEGRAM_BODY_MAX) {
		tgLine = `${tgLine.slice(0, TELEGRAM_BODY_MAX)}…`;
	}

	const ip = getClientAddress();
	const lines = [
		'📬 Contact form',
		'',
		`👤 Name: ${name}`,
		`📧 Email: ${email}`,
		`📝 Subject: ${subject || '—'}`,
		`🌐 IP: ${ip}`,
		'',
		'💬 Message:',
		tgLine
	];
	const text = lines.join('\n');

	let telegramOk = false;
	if (canTelegram) {
		try {
			const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ chat_id: chatId, text })
			});
			telegramOk = res.ok;
			if (!res.ok) {
				const errBody = await res.text();
				console.error('Telegram contact error:', res.status, errBody);
			}
		} catch (err) {
			console.error('Telegram contact error:', err);
		}
	}

	let emailOk = false;
	if (canEmail) {
		try {
			emailOk = await sendContactEmail({ name, email, subject: subject || null, message });
		} catch (err) {
			console.error('Contact email error:', err);
		}
	}

	const delivered = (canTelegram && telegramOk) || (canEmail && emailOk);
	if (!delivered) {
		return json({ error: 'Failed to send message' }, { status: 502 });
	}

	return json({ ok: true });
};
