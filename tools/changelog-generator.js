#!/usr/bin/env node
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const repo = 'MaaAssistantArknights/MaaAssistantArknights'; // Owner/RepoName
const curDir = path.resolve(__dirname);
const contributorsPath = path.join(curDir, 'contributors.json');
const changelogPath = path.join(curDir, '..', 'CHANGELOG.md');

let withHash = false;
let withCommitizen = false;
let committerIsAuthor = false;
let mergeAuthor = false;
let withMerge = false;

let contributors = {};
let rawCommitsInfo = {};

const IGNORE_PREFIXES = /^(?:build|ci|style|debug)\s*(?:\([^)]*\))*:\s*/;

// 中文关键词映射到分类
const translations = {
  '修复': 'fix',
  '新增': 'feat',
  '更新': 'perf',
  '改进': 'perf',
  '优化': 'perf',
  '重构': 'perf',
  '文档': 'docs',
  '其他': 'other',
};

const translationsResort = {
  '新增 | New': 'feat',
  '改进 | Improved': 'perf',
  '修复 | Fix': 'fix',
  '文档 | Docs': 'docs',
  '其他 | Other': 'other',
};

function parseCategory(message) {
  // 1. 检查 commitizen 前缀
  if (IGNORE_PREFIXES.test(message)) {
    return null;
  }

  const m = message.match(/^(?<prefix>\w+)(?:\([\w\-]+\))?:\s*/);
  if (m) {
    const prefix = m.groups.prefix.toLowerCase();
    if (prefix === 'feat') return 'feat';
    if (prefix === 'fix') return 'fix';
    if (['perf', 'refactor', 'rft'].includes(prefix)) return 'perf';
    if (['docs', 'doc'].includes(prefix)) return 'docs';
    return 'other';
  }

  // 2. 中文关键词匹配
  for (const [key, cat] of Object.entries(translations)) {
    if (message.includes(key)) {
      return cat;
    }
  }

  return 'other';
}

function individualCommits(commits, indent = '') {
  if (!commits || Object.keys(commits).length === 0) {
    return { message: '', contributors: [] };
  }

  let retMessage = '';
  let retContributor = [];

  for (const [commitHash, commitInfo] of Object.entries(commits)) {
    if (commitInfo.skip) continue;

    let commitMessage = commitInfo.message;

    // 剥掉 commitizen 前缀，除非保留
    if (!withCommitizen) {
      commitMessage = commitMessage.replace(/^(?<prefix>\w+)(?:\([\w\-]+\))?:\s*/, '');
    }

    // 递归处理 merge branch
    const { message: mes, contributors: ctrs } = individualCommits(commitInfo.branch || {}, indent + '   ');

    // 收集作者
    if (mergeAuthor || !commitInfo.branch || Object.keys(commitInfo.branch).length === 0) {
      const allAuthors = [
        commitInfo.author,
        ...(commitInfo.coauthors || []),
        committerIsAuthor ? commitInfo.committer : null,
      ].filter(Boolean);
      allAuthors.forEach(ctr => {
        if (!ctrs.includes(ctr)) {
          ctrs.push(ctr);
        }
      });
    }

    ctrs.forEach(ctr => {
      if (ctr !== 'web-flow' && !retContributor.includes(ctr)) {
        retContributor.push(ctr);
      }
    });

    // 拼接 commit message
    retMessage += indent + '* ' + commitMessage;
    retMessage += ctrs
      .filter(ctr => ctr !== 'web-flow')
      .map(ctr => ` @${ctr}`)
      .join('');
    retMessage += withHash ? ` (${commitHash})\n` : '\n';

    if (withMerge) {
      retMessage += mes;
    }
  }

  return { message: retMessage, contributors: retContributor };
}

function updateCommits(commitMessage, sortedCommits, updateDict) {
  const category = parseCategory(commitMessage);
  if (!category) return;
  Object.assign(sortedCommits[category], updateDict);
}

function updateMessage(sortedCommits, retContributor) {
  let retMessage = '';
  for (const [key, category] of Object.entries(translationsResort)) {
    if (Object.keys(sortedCommits[category]).length > 0) {
      const { message: mes, contributors: ctrs } = individualCommits(sortedCommits[category], '');
      if (mes) {
        retMessage += `\n### ${key}\n\n${mes}`;
      }
      ctrs.forEach(ctr => {
        if (!retContributor.includes(ctr)) {
          retContributor.push(ctr);
        }
      });
    }
  }
  return retMessage;
}

function printCommits(commits) {
  const sortedCommits = {
    perf: {},
    feat: {},
    fix: {},
    docs: {},
    other: {},
  };
  for (const [commitHash, commitInfo] of Object.entries(commits)) {
    updateCommits(commitInfo.message, sortedCommits, { [commitHash]: commitInfo });
  }
  return updateMessage(sortedCommits, []);
}

function buildCommitsTree(commitHash) {
  if (!(commitHash in rawCommitsInfo)) {
    return {};
  }
  const commitInfo = rawCommitsInfo[commitHash];
  if (commitInfo.visited) {
    return {};
  }
  commitInfo.visited = true;

  const res = {
    [commitHash]: {
      hash: commitInfo.hash,
      author: commitInfo.author,
      committer: commitInfo.committer,
      coauthors: commitInfo.coauthors || [],
      message: commitInfo.message,
      branch: {},
      skip: commitInfo.skip || false,
    },
  };

  // 递归父 commit
  Object.assign(res, buildCommitsTree(commitInfo.parent[0]));

  if (commitInfo.parent.length === 2) {
    // merge 分支处理
    if (commitInfo.message.startsWith('Release') || commitInfo.message.startsWith('Merge')) {
      Object.assign(res, buildCommitsTree(commitInfo.parent[1]));
    } else {
      Object.assign(res[commitHash].branch, buildCommitsTree(commitInfo.parent[1]));
    }
    if (
      commitInfo.message.startsWith('Merge') &&
      Object.keys(res[commitHash].branch).length === 0
    ) {
      delete res[commitHash];
    }
  }

  return res;
}

function retryUrlopen(url, options = {}) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const maxAttempts = 5;

    function attempt() {
      attempts++;
      const req = https.request(url, options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode === 403 && res.headers['x-ratelimit-remaining'] === '0') {
            const resetTime = parseInt(res.headers['x-ratelimit-reset'] || '0', 10);
            const now = Date.now() / 1000;
            const waitTime = Math.max(resetTime - now, 10) * 1000;
            if (attempts < maxAttempts) {
              setTimeout(attempt, waitTime);
            } else {
              reject(new Error('Rate limit exceeded'));
            }
          } else if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', (err) => {
        if (attempts < maxAttempts) {
          setTimeout(attempt, 1000);
        } else {
          reject(err);
        }
      });

      req.end();
    }

    attempt();
  });
}

async function convertContributorsName(name, commitHash, nameType) {
  if (name in contributors) {
    return contributors[name];
  }
  try {
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    const options = {
      headers: {
        'User-Agent': 'Node.js',
      },
    };
    if (token) {
      options.headers.Authorization = `Bearer ${token}`;
    }
    const data = await retryUrlopen(`https://api.github.com/repos/${repo}/commits/${commitHash}`, options);
    const userData = JSON.parse(data);
    const userId = userData[nameType].login;
    contributors[name] = userId;
    return userId;
  } catch (e) {
    console.error(`Cannot get ${nameType}: ${name}. (${e.message})`);
    return name;
  }
}

function callCommand(command) {
  try {
    return execSync(command, { encoding: 'utf-8' }).trim();
  } catch (e) {
    try {
      return execSync(command, { encoding: 'gbk' }).trim();
    } catch {
      return '';
    }
  }
}

async function main(tagName = null, latest = null) {
  try {
    const data = fs.readFileSync(contributorsPath, 'utf-8');
    contributors = JSON.parse(data);
  } catch {
    contributors = {};
  }

  if (!latest) {
    latest = callCommand('git describe --tags --match "v*" --abbrev=0');
  }
  if (!tagName) {
    tagName = callCommand('git describe --tags --match "v*"');
  }

  console.log('From:', latest, ', To:', tagName, '\n');

  const gitCommand = `git log ${latest}..HEAD --pretty=format:"%H%n%aN%n%cN%n%s%n%P%n"`;
  const rawGitlogs = callCommand(gitCommand);

  rawCommitsInfo = {};
  if (rawGitlogs.trim()) {
    const rawCommitInfos = rawGitlogs.split('\n\n').filter(Boolean);
    for (const rawCommitInfo of rawCommitInfos) {
      const [commitHash, author, committer, message, ...parentParts] = rawCommitInfo.split('\n');
      const parent = parentParts.join(' ').split(/\s+/).filter(Boolean);
      const convertedAuthor = await convertContributorsName(author, commitHash, 'author');
      const convertedCommitter = await convertContributorsName(committer, commitHash, 'committer');
      rawCommitsInfo[commitHash] = {
        hash: commitHash.slice(0, 8),
        author: convertedAuthor,
        committer: convertedCommitter,
        message: message,
        parent: parent,
      };
    }

    // coauthor
    const gitCoauthorCommand = `git log ${latest}..HEAD --pretty=format:"%H%n" --grep="Co-authored-by"`;
    const coauthorHashes = callCommand(gitCoauthorCommand).split('\n').filter(Boolean);
    for (const commitHash of coauthorHashes) {
      if (!(commitHash in rawCommitsInfo)) continue;
      const addition = callCommand(`git log ${commitHash} --no-walk --pretty=format:"%b"`);
      const coauthors = [];
      const coauthorRegex = /Co-authored-by: (.*?) <.*?>/g;
      let match;
      while ((match = coauthorRegex.exec(addition)) !== null) {
        const coauthor = match[1];
        if (coauthor in contributors) {
          coauthors.push(contributors[coauthor]);
        } else if (Object.values(contributors).includes(coauthor)) {
          coauthors.push(coauthor);
        } else {
          console.log(`Cannot get coauthor: ${coauthor}.`);
        }
      }
      rawCommitsInfo[commitHash].coauthors = coauthors;
    }

    // skip changelog
    const gitSkipCommand = `git log ${latest}..HEAD --pretty=format:"%H%n" --grep="\\[skip changelog\\]"`;
    const skipHashes = callCommand(gitSkipCommand).split('\n').filter(Boolean);
    for (const commitHash of skipHashes) {
      if (!(commitHash in rawCommitsInfo)) continue;
      const rawGitShow = callCommand(`git show -s --format=%B%n ${commitHash}`);
      if (rawGitShow.includes('[skip changelog]')) {
        rawCommitsInfo[commitHash].skip = true;
      }
    }

    // build changelog
    const firstHash = Object.keys(rawCommitsInfo)[0];
    const res = printCommits(buildCommitsTree(firstHash));
    const changelogContent = '## ' + tagName + '\n' + res;
    console.log(changelogContent);
    fs.writeFileSync(changelogPath, changelogContent, 'utf8');

    fs.writeFileSync(contributorsPath, JSON.stringify(contributors, null, 2));
  } else {
    console.log('No commits found.');
    const githubOutput = process.env.GITHUB_OUTPUT;
    if (githubOutput) {
      fs.appendFileSync(githubOutput, 'cancel_run=true\n');
    }
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  let tagName = null;
  let latest = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--tag' || arg === '-t') {
      tagName = args[++i];
    } else if (arg === '--base' || arg === '--latest' || arg === '-b') {
      latest = args[++i];
    } else if (arg === '-wh' || arg === '--with-hash') {
      withHash = true;
    } else if (arg === '-wc' || arg === '--with-commitizen') {
      withCommitizen = true;
    } else if (arg === '-ma' || arg === '--merge-author') {
      mergeAuthor = true;
    } else if (arg === '-ca' || arg === '--committer-is-author') {
      committerIsAuthor = true;
    } else if (arg === '-wm' || arg === '--with-merge') {
      withMerge = true;
    }
  }

  return { tagName, latest };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { tagName, latest } = parseArgs();
  main(tagName, latest).catch(console.error);
}

export { main };
