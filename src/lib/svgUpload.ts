import { supabase } from "./supabase";

const SVG_UPLOAD_BUCKET = "svg-uploads";

/**
 * Upload SVG content to Supabase public bucket "svg-uploads" and return the public URL.
 * Use this URL with the icon processor GET endpoint to avoid sending large POST bodies.
 */
export async function uploadSvgToSupabase(svgContent: string): Promise<string> {
    const path = `${Date.now()}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}.svg`;
    const blob = new Blob([svgContent], { type: "image/svg+xml" });

    const { data, error } = await supabase.storage
        .from(SVG_UPLOAD_BUCKET)
        .upload(path, blob, {
            contentType: "image/svg+xml",
            upsert: false,
        });

    if (error) {
        throw new Error(error.message || "Failed to upload SVG");
    }

    const uploadedPath = (data as { path?: string })?.path ?? path;
    const { data: urlData } = supabase.storage
        .from(SVG_UPLOAD_BUCKET)
        .getPublicUrl(uploadedPath);

    return urlData.publicUrl;
}
