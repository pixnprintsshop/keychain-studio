import { supabase } from '$lib/supabase';

export type RecentExportEvent = {
	id: string;
	designerId: string | null;
	format: 'stl' | '3mf' | 'bambu_studio';
	createdAt: string;
	emailObscured: string;
	avatarUrl: string | null;
};

const MAX_EVENTS = 12;
const TOAST_MS = 4200;
/** Hide the home feed widget after this idle period (resets on new live export). */
const WIDGET_HIDE_MS = 3 * 60 * 1000;

let events = $state<RecentExportEvent[]>([]);
let loaded = $state(false);
let toastEvent = $state<RecentExportEvent | null>(null);
let expanded = $state(false);
let widgetVisible = $state(false);

let toastTimeout: ReturnType<typeof setTimeout> | null = null;
let widgetHideTimeout: ReturnType<typeof setTimeout> | null = null;
let realtimeChannel: ReturnType<typeof supabase.channel> | null = null;

export const recentExportFeed = {
	get events(): RecentExportEvent[] {
		return events;
	},
	get loaded(): boolean {
		return loaded;
	},
	get toastEvent(): RecentExportEvent | null {
		return toastEvent;
	},
	get expanded(): boolean {
		return expanded;
	},
	get widgetVisible(): boolean {
		return widgetVisible;
	},
	get hasEvents(): boolean {
		return events.length > 0;
	}
};

function clearWidgetHideTimeout() {
	if (widgetHideTimeout !== null) {
		clearTimeout(widgetHideTimeout);
		widgetHideTimeout = null;
	}
}

function scheduleWidgetHide() {
	if (expanded) return;
	clearWidgetHideTimeout();
	widgetHideTimeout = setTimeout(() => {
		widgetHideTimeout = null;
		widgetVisible = false;
		dismissRecentExportToast();
		setRecentExportFeedExpanded(false);
	}, WIDGET_HIDE_MS);
}

function revealWidget() {
	widgetVisible = true;
	scheduleWidgetHide();
}

function normalizeFormat(value: unknown): RecentExportEvent['format'] {
	if (value === '3mf' || value === 'bambu_studio') return value;
	return 'stl';
}

function parseRow(row: unknown): RecentExportEvent | null {
	if (!row || typeof row !== 'object') return null;
	const r = row as {
		id?: string;
		designer_id?: string | null;
		export_format?: string;
		created_at?: string;
		user_email_obscured?: string | null;
		user_avatar_url?: string | null;
	};
	if (!r.id || !r.created_at) return null;
	const emailObscured =
		typeof r.user_email_obscured === 'string' && r.user_email_obscured.trim()
			? r.user_email_obscured.trim()
			: 'Maker';
	const avatarUrl =
		typeof r.user_avatar_url === 'string' && r.user_avatar_url.trim()
			? r.user_avatar_url.trim()
			: null;
	return {
		id: r.id,
		designerId: r.designer_id ?? null,
		format: normalizeFormat(r.export_format),
		createdAt: r.created_at,
		emailObscured,
		avatarUrl
	};
}

function prependEvent(event: RecentExportEvent, showToast: boolean) {
	if (events.some((entry) => entry.id === event.id)) return;
	events = [event, ...events.filter((entry) => entry.id !== event.id)].slice(0, MAX_EVENTS);
	if (!showToast) return;
	revealWidget();
	toastEvent = event;
	if (toastTimeout !== null) clearTimeout(toastTimeout);
	toastTimeout = setTimeout(() => {
		toastTimeout = null;
		toastEvent = null;
	}, TOAST_MS);
}

export function setRecentExportFeedExpanded(value: boolean) {
	expanded = value;
	if (value) {
		clearWidgetHideTimeout();
		if (toastTimeout !== null) {
			clearTimeout(toastTimeout);
			toastTimeout = null;
			toastEvent = null;
		}
		return;
	}
	if (widgetVisible) scheduleWidgetHide();
}

export function dismissRecentExportToast() {
	if (toastTimeout !== null) {
		clearTimeout(toastTimeout);
		toastTimeout = null;
	}
	toastEvent = null;
}

export async function loadRecentExportFeed(): Promise<void> {
	loaded = false;
	try {
		const { data, error } = await supabase.rpc('get_recent_platform_exports', {
			p_limit: MAX_EVENTS
		});
		if (error) {
			console.warn('[recentExportFeed] load failed:', error.message);
			events = [];
			return;
		}
		events = (Array.isArray(data) ? data : [])
			.map(parseRow)
			.filter((entry): entry is RecentExportEvent => entry !== null);
		if (events.length > 0) revealWidget();
	} catch (e) {
		console.warn('[recentExportFeed] load failed:', e);
		events = [];
	} finally {
		loaded = true;
	}
}

export function subscribeRecentExportFeed(): () => void {
	unsubscribeRecentExportFeed();
	realtimeChannel = supabase
		.channel('platform-export-events')
		.on(
			'postgres_changes',
			{ event: 'INSERT', schema: 'public', table: 'platform_export_events' },
			(payload) => {
				const event = parseRow(payload.new);
				if (event) prependEvent(event, true);
			}
		)
		.subscribe();
	return unsubscribeRecentExportFeed;
}

export function unsubscribeRecentExportFeed() {
	if (realtimeChannel) {
		void supabase.removeChannel(realtimeChannel);
		realtimeChannel = null;
	}
	if (toastTimeout !== null) {
		clearTimeout(toastTimeout);
		toastTimeout = null;
	}
	clearWidgetHideTimeout();
	widgetVisible = false;
}

export function formatRelativeExportTime(iso: string, nowMs = Date.now()): string {
	const then = new Date(iso).getTime();
	if (!Number.isFinite(then)) return 'just now';
	const seconds = Math.max(0, Math.floor((nowMs - then) / 1000));
	if (seconds < 10) return 'just now';
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}
