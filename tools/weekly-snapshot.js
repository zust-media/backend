#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * 执行命令并返回结果，静默处理错误
 */
function callCommand(command) {
  try {
    return execSync(command, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

/**
 * 获取当前年份的后两位
 */
function getYearSuffix() {
  return new Date().getFullYear().toString().slice(-2);
}

/**
 * 获取当前是一年中的第几周
 * ISO 周数：周一为一周的开始，第一周包含该年的第一个周四
 */
function getWeekNumber() {
  const date = new Date();
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

/**
 * 获取所有现有的周快照标签
 */
function getWeeklySnapshotTags() {
  const tags = callCommand('git tag -l').split('\n').filter(Boolean);
  const weeklyPattern = /^\d{2}w\d{1,2}[a-z]$/;
  return tags.filter(tag => weeklyPattern.test(tag)).sort();
}

/**
 * 获取指定周的所有快照标签
 */
function getSnapshotsForWeek(yearSuffix, weekNum) {
  const tags = getWeeklySnapshotTags();
  const weekPrefix = `${yearSuffix}w${weekNum}`;
  return tags.filter(tag => tag.startsWith(weekPrefix));
}

/**
 * 获取下一个版本字母
 */
function getNextLetter(existingTags, weekPrefix) {
  if (existingTags.length === 0) {
    return 'a';
  }

  const letters = existingTags.map(tag => {
    const match = tag.match(/^\d{2}w\d{1,2}([a-z])$/);
    return match ? match[1] : '';
  }).filter(Boolean).sort();

  const lastLetter = letters[letters.length - 1];
  if (!lastLetter) return 'a';

  const charCode = lastLetter.charCodeAt(0);
  if (charCode >= 122) { // 'z'
    throw new Error('已达到本周最大快照数量 (z)');
  }

  return String.fromCharCode(charCode + 1);
}

/**
 * 生成下一个周快照版本号
 */
function generateNextSnapshotVersion() {
  const yearSuffix = getYearSuffix();
  const weekNum = getWeekNumber();
  const weekPrefix = `${yearSuffix}w${weekNum}`;

  const existingTags = getSnapshotsForWeek(yearSuffix, weekNum);
  const nextLetter = getNextLetter(existingTags, weekPrefix);

  return `${weekPrefix}${nextLetter}`;
}

/**
 * 获取当前周快照的基础标签
 * 查找最近的正式 release 标签 (v*)
 */
function getBaseTag() {
<<<<<<< HEAD
  try {
    const tags = execSync('git tag -l "v*" --sort=-creatordate', { encoding: 'utf-8' }).trim().split('\n');
    return tags[0] || null;
=======
  // 先查找所有周快照标签
  const weeklyTags = getWeeklySnapshotTags();
  
  // 如果有周快照，返回最后一个
  if (weeklyTags.length > 0) {
    return weeklyTags[weeklyTags.length - 1];
  }
  
  // 如果没有周快照，查找最近的正式 release
  const releaseTags = callCommand('git tag -l "v*" --sort=-creatordate').split('\n').filter(Boolean);
  return releaseTags[0] || null;
}

/**
 * 获取本周之前的最后一个周快照标签
 * 用于计算本周第一个快照的基础标签
 */
function getLastWeeklySnapshot() {
  try {
    const weeklyTags = getWeeklySnapshotTags();
    return weeklyTags.length > 0 ? weeklyTags[weeklyTags.length - 1] : null;
>>>>>>> 721b2a9 (fix: 修复了每周快照 CHANGELOG 增量识别错误的问题)
  } catch {
    return null;
  }
}

/**
 * 主函数
 */
function main() {
  try {
    const nextVersion = generateNextSnapshotVersion();
    const baseTag = getBaseTag();

    console.log(nextVersion);

    // 如果需要更详细的输出
    if (process.argv.includes('--verbose')) {
      const yearSuffix = getYearSuffix();
      const weekNum = getWeekNumber();
      console.error(`年份后两位: ${yearSuffix}`);
      console.error(`周数: ${weekNum}`);
      console.error(`基础标签: ${baseTag || '无'}`);
      console.error(`下一个快照版本: ${nextVersion}`);
    }
  } catch (error) {
    console.error('生成周快照版本号失败:', error.message);
    process.exit(1);
  }
}

// 导出函数供其他模块使用
export {
  getYearSuffix,
  getWeekNumber,
  getWeeklySnapshotTags,
  getSnapshotsForWeek,
  getNextLetter,
  generateNextSnapshotVersion,
  getBaseTag,
};

// 检查是否直接运行此脚本
const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main();
}
