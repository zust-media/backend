// changelog-generator.js
const { execSync } = require('child_process');
const fs = require('fs');

const typeMap = {
  feat: '✨ 新功能',
  fix: '🐞 修复问题',
  refactor: '♻️ 重构优化',
  docs: '📚 文档变更',
  chore: '🔧 其他修改',
};

function getCommits() {
  return execSync('git log --pretty=format:"%s"').toString().split('\n');
}

function classify(commits) {
  const result = {};
  for (let line of commits) {
    const match = line.match(/^(\w+):\s*(.+)/);
    if (!match) continue;
    const [, type, msg] = match;
    const title = typeMap[type] || '📦 其他';
    if (!result[title]) result[title] = [];
    result[title].push(`- ${msg}`);
  }
  return result;
}

function generateMd(data) {
  const now = new Date().toLocaleDateString();
  const lines = [`## 📝 更新日志 (${now})\n`];
  for (const [title, items] of Object.entries(data)) {
    lines.push(`### ${title}`);
    lines.push(...items, '');
  }
  return lines.join('\n');
}

function writeToFile(content) {
  fs.appendFileSync('CHANGELOG.md', '\n' + content);
}

const commits = getCommits();
const grouped = classify(commits);
const markdown = generateMd(grouped);
writeToFile(markdown);
console.log('✅ Changelog updated.');