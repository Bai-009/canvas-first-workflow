import { rm } from 'node:fs/promises';

// 直接由 Node 启动，不依赖可能已经过期的编译产物。
// 只清理项目拥有的输出目录；会话、配置与运行记录不在这里。
for (const directory of ['dist', '.build-tools']) {
  await rm(new URL(`../${directory}/`, import.meta.url), { recursive: true, force: true });
}
