import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // core 模块测试涉及真实文件系统临时目录,保持串行避免端口/目录竞争
    pool: 'forks',
    testTimeout: 20000,
  },
});
