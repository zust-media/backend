const BLOCKED_KEYWORDS = [
  // 系统路径 / 路由
  'admin', 'administrator', 'root', 'superuser',
  'api', 'graphql', 'rest',
  'login', 'logout', 'register', 'signup', 'signin', 'signout',
  'settings', 'profile', 'account',
  'upload', 'uploads', 'uploaded',
  'dashboard', 'panel', 'manage', 'management',
  'config', 'configuration', 'setup', 'install',
  'assets', 'static', 'public', 'private', 'files',
  'images', 'image', 'img', 'photos', 'photo',
  'tags', 'tag', 'categories', 'category',
  'users', 'user', 'search', 'explore', 'browse',
  'index', 'home', 'main', 'default',
  'new', 'edit', 'delete', 'create', 'update', 'list',
  'batch', 'batches', 'duplicates', 'duplicate',

  // 常见系统名
  'system', 'sys', 'server', 'service', 'services',
  'dev', 'development', 'test', 'testing', 'staging',
  'local', 'localhost', 'production', 'prod',

  // 常见函数/保留字
  'null', 'undefined', 'nan', 'true', 'false',
  'function', 'class', 'object', 'array', 'string', 'number', 'boolean',
  'this', 'self', 'global', 'window', 'document',
  'constructor', 'prototype', 'instanceof', 'typeof',
  'return', 'break', 'continue', 'switch', 'case', 'default',

  // 协议/技术名
  'http', 'https', 'ftp', 'ssh', 'smtp', 'dns',
  'www', 'mail', 'email', 'web', 'webmaster', 'hostmaster', 'postmaster',
  'app', 'apps', 'application',
  'node', 'npm', 'javascript', 'python', 'java', 'ruby',
  'linux', 'windows', 'macos', 'android', 'ios',
  'css', 'html', 'js', 'json', 'xml', 'yaml', 'csv',
  'sql', 'mysql', 'sqlite', 'postgresql', 'mongo', 'redis',

  // 敏感/安全相关
  'password', 'passwd', 'secret', 'token', 'jwt',
  'auth', 'authenticate', 'authorization', 'authentication',
  'access', 'denied', 'forbidden', 'error',

  // 常用昵称混淆
  'about', 'contact', 'help', 'support', 'faq', 'terms', 'privacy',
  'blog', 'news', 'status', 'stats', 'robots',
  'sitemap', 'feed', 'rss', 'atom',
  'favicon', 'manifest', 'sw',
  '_next', '__next',

  // ZustMedia 特定
  'zustmedia', 'zust', 'media',

  // 空/空白字符变体
  'anonymous', 'unknown', 'nobody',
  'guest', 'visitor',
  'bot', 'spider', 'crawler',
];

const BLOCKED_SET = new Set(BLOCKED_KEYWORDS.map((k) => k.toLowerCase()));

export function isBlocked(word) {
  if (!word) return false;
  return BLOCKED_SET.has(word.trim().toLowerCase());
}

export function validateNotBlocked(value, label = '值') {
  const word = (value || '').trim();
  if (!word) return null;
  if (isBlocked(word)) {
    return `"${word}" 是保留关键字，不能作为${label}使用`;
  }
  return null;
}

export default BLOCKED_KEYWORDS;
