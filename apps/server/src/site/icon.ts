import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { SiteIconSettings } from '@mlclaw/shared';
import { formatSystemTime } from '../time.js';

/** 上传原图上限；解码另设像素上限。 */
export const iconUploadLimit = 2 * 1024 * 1024;

/** 读取当前用户的网站图标设置。 */
export const getSiteIconSettings = (db: DatabaseSync, userId: string): SiteIconSettings => {
  const row = db.prepare('SELECT version FROM site_icons WHERE user_id=?').get(userId);
  return {
    custom: !!row,
    url: row ? `/api/site-icon?v=${String(row.version)}` : '/api/site-icon',
  };
};

/** 解码允许的位图并重新编码，丢弃原文件元数据和附加内容。 */
export const normalizeSiteIcon = async (encoded: string): Promise<Buffer> => {
  if (
    !encoded ||
    encoded.length > Math.ceil(iconUploadLimit / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
  )
    throw new Error('请选择不超过 2 MB 的 PNG、JPEG 或 WebP 图片');
  const input = Buffer.from(encoded, 'base64');
  if (input.toString('base64') !== encoded) throw new Error('图片编码无效');
  if (input.length > iconUploadLimit) throw new Error('图片不能超过 2 MB');
  const options = { limitInputPixels: 4096 * 4096, failOn: 'warning' as const };
  const metadata = await sharp(input, options).metadata();
  if (!metadata.width || !metadata.height || metadata.width > 4096 || metadata.height > 4096)
    throw new Error('图片尺寸不能超过 4096×4096');
  if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1)
    throw new Error('仅支持静态 PNG、JPEG 或 WebP 图片');
  return sharp(input, options)
    .rotate()
    .resize(256, 256, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
};

/** 原子替换用户图标及缓存版本。 */
export const saveSiteIcon = (db: DatabaseSync, userId: string, image: Buffer) => {
  db.prepare(
    `INSERT INTO site_icons(user_id,image,version,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET image=excluded.image,version=excluded.version,updated_at=excluded.updated_at`,
  ).run(userId, image, randomUUID(), formatSystemTime());
  return getSiteIconSettings(db, userId);
};
