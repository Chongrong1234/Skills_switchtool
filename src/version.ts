/**
 * 版本号单一来源:package.json。
 * esbuild 打包单文件 CLI 时由 scripts/build-cli.mjs 用 define 注入 __SSW_VERSION__;
 * 其余场景(tsx 跑 src/、node 跑 dist/)运行时读 ../package.json
 * —— src/ 与 dist/ 都恰好在仓库根下一层,同一条相对路径成立。
 */
import { readFileSync } from 'node:fs';

// 打包注入点:非打包运行时该标识符不存在,typeof 守卫保证不抛 ReferenceError
declare const __SSW_VERSION__: string | undefined;

function resolveVersion(): string {
  if (typeof __SSW_VERSION__ !== 'undefined') return __SSW_VERSION__;
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = resolveVersion();
