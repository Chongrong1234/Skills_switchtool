/**
 * 用 esbuild 把 CLI 打成单文件 release/cli/ssw.mjs(零依赖,服务器上 Node≥18 即可运行)。
 * commander 是 CJS,ESM 输出需要注入 createRequire 以支持其内部 dynamic require。
 * 版本号用 define 注入 __SSW_VERSION__(见 src/version.ts):单文件拷到服务器后
 * 没有 ../package.json 可读,版本必须在构建期固化进产物。
 */
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: ['dist/cli.js'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: 'release/cli/ssw.mjs',
  define: {
    __SSW_VERSION__: JSON.stringify(version),
  },
  banner: {
    // shebang 由 esbuild 自动保留输入文件首行;这里只注入 CJS 兼容层
    js: [
      "import { createRequire } from 'node:module';",
      'const require = createRequire(import.meta.url);',
    ].join('\n'),
  },
});
console.log(`已生成 release/cli/ssw.mjs(v${version})`);
