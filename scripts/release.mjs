#!/usr/bin/env node
/**
 * 一键发布(防"合并后忘打 tag 漏发 Release"——v1.3.0/v1.4.0~1.4.4 曾漏):
 *   1. 工作区必须干净(发布内容 = 已提交内容);
 *   2. package.json 版本号必须未打过 tag(防重复发布);
 *   3. 全量测试(坏代码不发);
 *   4. 打 v<version> tag;5. push main + tag(tag 触发 release.yml 三平台构建并传 GitHub Release)。
 * 用法:npm run release
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', ...(isWin && cmd === npmCmd ? { shell: true } : {}), ...opts });
const out = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();

const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const tag = `v${version}`;

if (out('git', ['status', '--porcelain'])) {
  console.error('✗ 工作区有未提交改动,请先提交再发布');
  process.exit(1);
}
if (out('git', ['tag', '-l', tag])) {
  console.error(`✗ ${tag} 已存在:请先提升 package.json 版本号(版本号只改 package.json)`);
  process.exit(1);
}

console.log(`→ 全量测试...`);
run(npmCmd, ['test']);
console.log(`→ 打 tag ${tag}`);
run('git', ['tag', tag]);
console.log(`→ 推送 main 与 ${tag}`);
run('git', ['push', 'origin', 'main']);
run('git', ['push', 'origin', tag]);
console.log(`✓ 已推送。release.yml 将跑测试并构建三平台产物,产物见 GitHub Release。`);
