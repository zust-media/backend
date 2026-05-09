import { readFileSync } from 'fs';
import { load } from 'js-yaml';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let yamlConfig;
try {
  const yamlPath = join(__dirname, '..', '..', 'config.yaml');
  yamlConfig = load(readFileSync(yamlPath, 'utf8'));
} catch {
  console.warn('config.yaml 未找到或解析失败，使用默认配置');
  yamlConfig = {};
}

const jwt = yamlConfig.jwt || {};
const security = yamlConfig.security || {};
const upload = yamlConfig.upload || {};
const image = yamlConfig.image || {};
const thumbnail = yamlConfig.thumbnail || {};
const watermark = yamlConfig.watermark || {};
const db = yamlConfig.database || {};
const logging = yamlConfig.logging || {};

const config = {
  maxFileSizeMB: upload.max_file_size_mb ?? 50,
  maxBatchCount: upload.max_batch_count ?? 20,
  allowedTypes: upload.allowed_types ?? ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'],

  image: {
    defaultQuality: image.default_quality ?? 85,
    maxPreviewWidth: image.max_preview_width ?? 2560,
    forceWatermark: image.force_watermark ?? false,
    defaultWatermark: image.default_watermark ?? 'mark.png',
  },

  thumbnail: {
    defaultWidth: thumbnail.default_width ?? 480,
    defaultQuality: thumbnail.default_quality ?? 75,
  },

  watermark: {
    marginX: watermark.margin_x ?? 0.03,
    marginY: watermark.margin_y ?? 0.03,
    opacity: watermark.opacity ?? 0.3,
    sizeRatio: watermark.size_ratio ?? 0.15,
    position: watermark.position ?? 'bottom-right',
  },

  security: {
    signingKey: security.signing_key ?? 'zustmedia_signing_key_change_me',
    jwtSecret: jwt.secret ?? 'zustmedia_jwt_secret_key_2024_change_in_production',
    captchaJwtSecret: jwt.captcha_secret ?? 'zustmedia_captcha_jwt_secret_2024',
  },

  server: yamlConfig.server || {},
  database: { filename: db.filename ?? 'data/zustmedia.db' },
  logging: { dir: logging.dir ?? 'logs', level: logging.level ?? 'info' },
};

export default config;
