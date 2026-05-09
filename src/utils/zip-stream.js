import { ZipArchive } from 'archiver';
import { compressForDownload } from './thumbnail.js';

export async function streamZipDownload(res, imageRows, zipName, params = {}) {
  const fmt = params.format || 'jpeg';
  const fmtExt = fmt === 'webp' ? 'webp' : (fmt === 'png' ? 'png' : 'jpg');

  const safeName = zipName.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeName)}.zip"`);

  const archive = new ZipArchive({ zlib: { level: 5 } });
  archive.on('error', (err) => {
    console.error('zip stream error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: '打包失败' });
  });

  archive.pipe(res);

  const usedNames = new Map();
  for (const img of imageRows) {
    const buffer = await compressForDownload(img.filename, params);
    if (!buffer) continue;

    const origName = img.original_name || img.filename;
    const dotIdx = origName.lastIndexOf('.');
    const baseName = dotIdx > 0 ? origName.substring(0, dotIdx) : origName;

    let name = `${baseName}.${fmtExt}`;
    if (usedNames.has(name)) {
      const count = usedNames.get(name) + 1;
      usedNames.set(name, count);
      name = `${baseName}_${count}.${fmtExt}`;
    } else {
      usedNames.set(name, 1);
    }

    archive.append(buffer, { name });
  }

  archive.finalize();
}
