import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import config from './app.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dbPath = join(__dirname, '..', '..', config.database?.filename || 'data/zustmedia.sqlite');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'super_admin', 'user')),
    uuid TEXT,
    slug TEXT,
    bio TEXT DEFAULT '',
    nickname TEXT DEFAULT '',
    default_gallery_uuid TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    description TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// 确保默认分类存在（上传图片时 category_id 默认回退到 id=1）
{
  const hasDefaultCat = db.prepare('SELECT id FROM categories WHERE slug = ?').get('uncategorized');
  if (!hasDefaultCat) {
    try { db.prepare('INSERT INTO categories (name, slug, description) VALUES (?, ?, ?)').run('无分类', 'uncategorized', '默认分类'); } catch { /* may already exist */ }
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    title TEXT DEFAULT '',
    description TEXT DEFAULT '',
    exif TEXT DEFAULT '{}',
    uuid TEXT,
    category_id INTEGER DEFAULT NULL REFERENCES categories(id) ON DELETE SET NULL,
    file_hash TEXT DEFAULT '',
    is_duplicate INTEGER DEFAULT 0,
    duplicate_of INTEGER DEFAULT NULL,
    is_public INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    slug TEXT UNIQUE
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS image_tags (
    image_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    PRIMARY KEY (image_id, tag_id),
    FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS activity_log (
    uuid TEXT PRIMARY KEY,
    operator TEXT NOT NULL,
    action TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS galleries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    creator_uuid TEXT NOT NULL,
    is_public INTEGER DEFAULT 1,
    is_archived INTEGER DEFAULT 0,
    is_public_editable INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (creator_uuid) REFERENCES users(uuid) ON DELETE CASCADE
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS gallery_images (
    gallery_id INTEGER NOT NULL,
    image_id INTEGER NOT NULL,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (gallery_id, image_id),
    FOREIGN KEY (gallery_id) REFERENCES galleries(id) ON DELETE CASCADE,
    FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS gallery_collaborators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gallery_id INTEGER NOT NULL,
    user_uuid TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('owner','admin','user')),
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(gallery_id, user_uuid),
    FOREIGN KEY (gallery_id) REFERENCES galleries(id) ON DELETE CASCADE,
    FOREIGN KEY (user_uuid) REFERENCES users(uuid) ON DELETE CASCADE
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS temp_auth_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    created_by TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    max_uses INTEGER DEFAULT NULL,
    use_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(uuid) ON DELETE CASCADE
  )
`);

export default db;
