import { supabase } from "./supabase";
import type { User, Session } from "@supabase/supabase-js";

export interface AuthState {
    user: User | null;
    session: Session | null;
    loading: boolean;
}

/**
 * Sign up with email and password
 */
export async function signUp(
    email: string,
    password: string,
): Promise<{ error: Error | null }> {
    try {
        const { error } = await supabase.auth.signUp({
            email,
            password,
        });

        return { error };
    } catch (error) {
        return { error: error as Error };
    }
}

/**
 * Sign in with email and password
 */
export async function signIn(
    email: string,
    password: string,
): Promise<{ error: Error | null }> {
    try {
        const { error } = await supabase.auth.signInWithPassword({
            email,
            password,
        });

        return { error };
    } catch (error) {
        return { error: error as Error };
    }
}

/**
 * Sign in with Google (OAuth redirect)
 */
export async function signInWithGoogle(): Promise<{ error: Error | null }> {
    try {
        const { data, error } = await supabase.auth.signInWithOAuth({
            provider: "google",
            options: {
                redirectTo: typeof window !== "undefined" ? window.location.origin : undefined,
            },
        });
        if (error) return { error };
        if (data?.url) {
            window.location.href = data.url;
        }
        return { error: null };
    } catch (error) {
        return { error: error as Error };
    }
}

/**
 * Sign out
 */
export async function signOut(): Promise<{ error: Error | null }> {
    try {
        const { error } = await supabase.auth.signOut();
        return { error };
    } catch (error) {
        return { error: error as Error };
    }
}

/**
 * Get current session
 */
export async function getSession(): Promise<Session | null> {
    const {
        data: { session },
    } = await supabase.auth.getSession();
    return session;
}

/**
 * Get current user
 */
export async function getUser(): Promise<User | null> {
    const {
        data: { user },
    } = await supabase.auth.getUser();
    return user;
}

/**
 * Listen to auth state changes
 */
export function onAuthStateChange(
    callback: (event: string, session: Session | null) => void,
) {
    return supabase.auth.onAuthStateChange((event, session) => {
        callback(event, session);
    });
}
