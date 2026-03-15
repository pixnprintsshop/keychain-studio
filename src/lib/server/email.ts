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
