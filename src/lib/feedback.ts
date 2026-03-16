import { supabase } from "./supabase";
import type { User } from "@supabase/supabase-js";

export type FeedbackCategory =
    | "general"
    | "questions"
    | "request"
    | "bug_report"
    | "feature_request";

export interface UserFeedbackRow {
    id: string;
    user_id: string;
    category: FeedbackCategory;
    title: string | null;
    message: string;
    created_at: string;
    updated_at: string | null;
    app_version: string | null;
    context: unknown | null;
}

export interface CreateFeedbackInput {
	user: User;
	category: FeedbackCategory;
	title?: string;
	message: string;
	context?: Record<string, unknown>;
}

export async function createFeedback(
	input: CreateFeedbackInput
): Promise<{ success: true; row: UserFeedbackRow } | { success: false; error: string }> {
	const { user, category, title, message, context } = input;

	if (!user) {
		return { success: false, error: 'You must be signed in to send feedback.' };
	}

	const trimmedMessage = message.trim();
	if (!trimmedMessage) {
		return { success: false, error: 'Feedback message cannot be empty.' };
	}

	const safeCategory: FeedbackCategory = category;

	const payload: Partial<UserFeedbackRow> & {
		user_id: string;
		category: FeedbackCategory;
		message: string;
	} = {
		user_id: user.id,
		category: safeCategory,
		title: title?.trim() || null,
		message: trimmedMessage
	};

	const meta: Record<string, unknown> = {
		...context
	};
	if (Object.keys(meta).length > 0) {
		(payload as any).context = meta;
	}

	const { data, error } = await supabase
		.from('user_feedback')
		.insert(payload)
		.select('*')
		.single<UserFeedbackRow>();

	if (error || !data) {
		return {
			success: false,
			error: error?.message || 'Failed to submit feedback.'
		};
	}

	return { success: true, row: data };
}

export async function listFeedbackForUser(
    user: User | null,
): Promise<{ rows: UserFeedbackRow[]; error?: string }> {
    if (!user) return { rows: [], error: "Not signed in." };

    const { data, error } = await supabase
        .from("user_feedback")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });

    if (error || !data) {
        return {
            rows: [],
            error: error?.message || "Failed to load feedback.",
        };
    }

    return { rows: data as UserFeedbackRow[] };
}

