import { env } from '$env/dynamic/private';
import { FEEDBACK_NOTIFY_EMAIL, RESEND_API_KEY } from '$env/static/private';

if (!RESEND_API_KEY) {
	// eslint-disable-next-line no-console
	console.warn('RESEND_API_KEY is not set; feedback emails will not be sent.');
}

if (!FEEDBACK_NOTIFY_EMAIL) {
	// eslint-disable-next-line no-console
	console.warn('FEEDBACK_NOTIFY_EMAIL is not set; feedback emails will not be sent.');
}

interface FeedbackEmailPayload {
	userEmail: string;
	category: string;
	title?: string | null;
	message: string;
	createdAt: string;
}

export async function sendFeedbackEmail(payload: FeedbackEmailPayload) {
	if (!RESEND_API_KEY || !FEEDBACK_NOTIFY_EMAIL) return;

	const { userEmail, category, title, message, createdAt } = payload;

	const subject = `[Print Studio] New feedback (${category})`;
	const body = [
		`New feedback from: ${userEmail}`,
		'',
		`Category: ${category}`,
		title ? `Title: ${title}` : '',
		`Date: ${createdAt}`,
		'',
		'Message:',
		message
	]
		.filter(Boolean)
		.join('\n');

	const res = await fetch('https://api.resend.com/emails', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${RESEND_API_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			// Use Resend's default verified sender; configure a custom domain later
			from: 'Print Studio <info@pixnprints.shop>',
			to: [FEEDBACK_NOTIFY_EMAIL],
			subject,
			text: body
		})
	});

	if (!res.ok) {
		const text = await res.text();
		// eslint-disable-next-line no-console
		console.error('Resend API error:', res.status, text);
	}
}

export interface ContactEmailPayload {
	name: string;
	email: string;
	subject?: string | null;
	message: string;
}

/** Sends the public contact form to `CONTACT_NOTIFY_EMAIL`, or falls back to `FEEDBACK_NOTIFY_EMAIL`. */
export async function sendContactEmail(payload: ContactEmailPayload): Promise<boolean> {
	if (!RESEND_API_KEY) {
		// eslint-disable-next-line no-console
		console.warn('RESEND_API_KEY is not set; contact email will not be sent.');
		return false;
	}

	const to = env.CONTACT_NOTIFY_EMAIL || FEEDBACK_NOTIFY_EMAIL;
	if (!to) {
		// eslint-disable-next-line no-console
		console.warn('CONTACT_NOTIFY_EMAIL and FEEDBACK_NOTIFY_EMAIL not set; contact email skipped.');
		return false;
	}

	const { name, email, subject, message } = payload;
	const subjectLine = subject?.trim() ? subject.trim() : '(no subject)';
	const body = [
		'New contact form submission',
		'',
		`Name: ${name}`,
		`Reply-To: ${email}`,
		`Subject: ${subjectLine}`,
		'',
		'Message:',
		message
	].join('\n');

	const res = await fetch('https://api.resend.com/emails', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${RESEND_API_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			from: 'Print Studio <info@pixnprints.shop>',
			to: [to],
			reply_to: email,
			subject: `[Print Studio] Contact: ${subjectLine}`,
			text: body
		})
	});

	if (!res.ok) {
		const text = await res.text();
		// eslint-disable-next-line no-console
		console.error('Resend contact email error:', res.status, text);
		return false;
	}
	return true;
}
