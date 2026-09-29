import { getClient } from './client.js';

// The file store's bytes (plan 2026-09-28-step-2d-files): the private Storage
// bucket `files`, reached only with the service-role client, so only the spine
// ever touches it. Paths are <tenant_id>/<file_id>; the original name lives on
// the `files` row. Kept inside src/db (an import leaf) rather than a storage
// module of its own, because files.ts is its only caller.

export const FILES_BUCKET = process.env.FILES_BUCKET ?? 'files';

export async function putObject(path: string, bytes: Buffer, mimeType: string): Promise<void> {
  const { error } = await getClient()
    .storage.from(FILES_BUCKET)
    .upload(path, bytes, { contentType: mimeType, upsert: false });
  if (error) throw new Error(`storing the file failed: ${error.message}`, { cause: error });
}

export async function getObject(path: string): Promise<Buffer> {
  const { data, error } = await getClient().storage.from(FILES_BUCKET).download(path);
  if (error || !data) throw new Error(`reading the file failed: ${error?.message ?? 'no data'}`, { cause: error });
  return Buffer.from(await data.arrayBuffer());
}

export async function removeObject(path: string): Promise<void> {
  const { error } = await getClient().storage.from(FILES_BUCKET).remove([path]);
  if (error) throw new Error(`removing the file failed: ${error.message}`, { cause: error });
}
