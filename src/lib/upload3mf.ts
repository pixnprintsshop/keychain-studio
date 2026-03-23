import { supabase } from './supabase.ts';

const UPLOADS_BUCKET = 'uploads';

/**
 * Upload 3MF blob to Supabase "uploads" bucket and return the public URL.
 */
export async function upload3mfToSupabase(blob: Blob, modelPrefix?: string): Promise<string> {
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const base = (modelPrefix ?? 'model').replace(/\.3mf$/i, '');
	const safeBase = base.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-');
	const path = `${safeBase}-${timestamp}.3mf`;

	const { data, error } = await supabase.storage.from(UPLOADS_BUCKET).upload(path, blob, {
		contentType: 'model/3mf',
		upsert: false
	});

	if (error) {
		throw new Error(error.message || 'Failed to upload 3MF');
	}

	const uploadedPath = (data as { path?: string })?.path ?? path;
	const { data: urlData } = supabase.storage.from(UPLOADS_BUCKET).getPublicUrl(uploadedPath);

	return urlData.publicUrl;
}
