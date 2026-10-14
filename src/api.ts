import { t } from './i18n';

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

export async function api(method: string, path: string, body?: any): Promise<any> {
  const token = localStorage.getItem('token');
  const headers: Record<string, string> = {};
  if (token) headers.authorization = 'Bearer ' + token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('Could not reach the server');
  }
  const data: any = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && token && !path.startsWith('/api/auth/')) onUnauthorized();
    // Some errors carry numbers for their placeholders (e.g. slowmode's wait time).
    const err: any = new Error(data?.wait ? t(data.error, { n: data.wait }) : data?.error || 'Something went wrong');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/** Uploads a file with progress reporting (fetch cannot report upload progress). */
export function upload(file: Blob, name: string, opts: { w?: number; h?: number; onProgress?: (f: number) => void } = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const q = new URLSearchParams({ name });
    if (opts.w && opts.h) {
      q.set('w', String(opts.w));
      q.set('h', String(opts.h));
    }
    xhr.open('POST', '/api/files?' + q);
    xhr.setRequestHeader('authorization', 'Bearer ' + localStorage.getItem('token'));
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && opts.onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data: any = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data?.error || 'Upload failed'));
    };
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.send(file);
  });
}

/** Crops an image to a centred square and scales it down, for avatars and server icons. */
export async function uploadSquareImage(file: File, size = 256): Promise<string> {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = Math.min(size, side);
  canvas
    .getContext('2d')!
    .drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
  const blob: Blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Invalid image'))), 'image/webp', 0.9));
  return (await upload(blob, 'image.webp')).url;
}
