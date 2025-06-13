#!/usr/bin/env node

import { runFromCli } from './imageConverter.js';

// 从命令行参数中获取参数，排除前两个参数（node 和脚本路径）
// Get command line arguments, excluding the first two parameters (node and script path)
const args = process.argv.slice(2);

// 显示帮助信息
// Display help information
if (args.includes('--help') || args.includes('-h') || args.length === 0) {
  console.log(`
图片转 WebP 工具 - 将图片批量转换为 WebP 格式
WebP Image Converter - Batch convert images to WebP format

用法 (Usage):
  node imageConverterCli.js <目录路径 (directory path)> [选项 (options)]

选项 (Options):
  --quality, -q <0-100>   WebP 压缩质量，默认为 80
                          WebP compression quality, default is 80
  --recursive, -r         递归处理子目录
                          Process subdirectories recursively
  --no-keep-original, -d  不保留原始图片
                          Don't keep original images
  --verbose, -v           显示详细日志
                          Display detailed logs
  --help, -h              显示此帮助信息
                          Display this help information

示例 (Examples):
  node imageConverterCli.js ./images -q 85 -r -v
  `);
  process.exit(0);
}

// 运行转换
// Run conversion
runFromCli(args).catch(error => {
  console.error('执行失败:', error);
  console.error('Execution failed:', error);
  process.exit(1);
}); 