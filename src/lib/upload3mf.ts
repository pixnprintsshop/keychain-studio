import { supabase } from './supabase';

const UPLOADS_BUCKET = 'uploads';

/**
 * Upload 3MF blob to Supabase "uploads" bucket and return the public URL.
 */
export async function upload3mfToSupabase(blob: Blob, filename?: string): Promise<string> {
	const ext = filename?.endsWith('.3mf') ? '' : '.3mf';
	const path = `${Date.now()}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}${ext}`;

	const { data, error } = await supabase.storage
		.from(UPLOADS_BUCKET)
		.upload(path, blob, {
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
