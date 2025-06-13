import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { Logger } from './logger.js';

/**
 * 支持的图片格式
 * Supported image formats
 */
const SUPPORTED_FORMATS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.tiff', '.avif'];

/**
 * 将图片转换为 WebP 格式的选项
 * Options for converting images to WebP format
 */
export interface ConvertToWebpOptions {
  /**
   * WebP 压缩质量 (0-100)，默认为 80
   * WebP compression quality (0-100), default is 80
   */
  quality?: number;
  /**
   * 是否递归处理子目录，默认为 false
   * Whether to process subdirectories recursively, default is false
   */
  recursive?: boolean;
  /**
   * 是否保留原始图片，默认为 true
   * Whether to keep the original images, default is true
   */
  keepOriginal?: boolean;
  /**
   * 是否显示详细日志，默认为 false
   * Whether to display detailed logs, default is false
   */
  verbose?: boolean;
}

/**
 * 转换结果统计
 * Conversion result statistics
 */
interface ConversionStats {
  totalFiles: number;
  convertedFiles: number;
  skippedFiles: number;
  errorFiles: number;
  totalSizeBefore: number;
  totalSizeAfter: number;
}

/**
 * 将目录中的图片转换为 WebP 格式
 * Convert images in a directory to WebP format
 * 
 * @param directoryPath 要处理的目录路径 (Directory path to process)
 * @param options 转换选项 (Conversion options)
 * @returns 转换结果统计 (Conversion statistics)
 */
export async function convertImagesToWebp(
  directoryPath: string,
  options: ConvertToWebpOptions = {}
): Promise<ConversionStats> {
  const {
    quality = 80,
    recursive = false,
    keepOriginal = true,
    verbose = false
  } = options;

  const stats: ConversionStats = {
    totalFiles: 0,
    convertedFiles: 0,
    skippedFiles: 0,
    errorFiles: 0,
    totalSizeBefore: 0,
    totalSizeAfter: 0
  };

  if (!fs.existsSync(directoryPath)) {
    Logger.error(`目录不存在: ${directoryPath}`);
    throw new Error(`Directory does not exist: ${directoryPath}`);
  }

  try {
    await processDirectory(directoryPath, stats, { quality, recursive, keepOriginal, verbose });
    
    // 计算节省的空间和压缩率
    // Calculate saved space and compression ratio
    const savedSize = stats.totalSizeBefore - stats.totalSizeAfter;
    const compressionRatio = stats.totalSizeBefore > 0 
      ? (savedSize / stats.totalSizeBefore * 100).toFixed(2)
      : '0';
    
    Logger.log(`
转换完成:
- 总文件数: ${stats.totalFiles}
- 已转换: ${stats.convertedFiles}
- 已跳过: ${stats.skippedFiles}
- 错误: ${stats.errorFiles}
- 原始大小: ${formatSize(stats.totalSizeBefore)}
- 转换后大小: ${formatSize(stats.totalSizeAfter)}
- 节省空间: ${formatSize(savedSize)} (${compressionRatio}%)

Conversion completed:
- Total files: ${stats.totalFiles}
- Converted: ${stats.convertedFiles}
- Skipped: ${stats.skippedFiles}
- Errors: ${stats.errorFiles}
- Original size: ${formatSize(stats.totalSizeBefore)}
- Size after conversion: ${formatSize(stats.totalSizeAfter)}
- Saved space: ${formatSize(savedSize)} (${compressionRatio}%)
`);
    
    return stats;
  } catch (error) {
    Logger.error('转换过程中发生错误:', error);
    Logger.error('Error during conversion:', error);
    throw error;
  }
}

/**
 * 处理目录中的图片
 * Process images in a directory
 */
async function processDirectory(
  directoryPath: string,
  stats: ConversionStats,
  options: Required<ConvertToWebpOptions>
): Promise<void> {
  const { quality, recursive, keepOriginal, verbose } = options;
  
  const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
  
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    
    if (entry.isDirectory() && recursive) {
      // 递归处理子目录
      // Process subdirectories recursively
      await processDirectory(entryPath, stats, options);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      
      // 检查是否为支持的图片格式
      // Check if it's a supported image format
      if (SUPPORTED_FORMATS.includes(ext) && ext !== '.webp') {
        stats.totalFiles++;
        
        // 如果已经有同名的 WebP 文件，则跳过
        // Skip if a WebP file with the same name already exists
        const baseName = path.basename(entry.name, ext);
        const webpPath = path.join(directoryPath, `${baseName}.webp`);
        
        if (fs.existsSync(webpPath)) {
          if (verbose) {
            Logger.log(`跳过 (已存在 WebP): ${entryPath}`);
            Logger.log(`Skip (WebP already exists): ${entryPath}`);
          }
          stats.skippedFiles++;
          continue;
        }
        
        try {
          // 获取原始文件大小
          // Get original file size
          const originalStats = fs.statSync(entryPath);
          stats.totalSizeBefore += originalStats.size;
          
          // 转换图片
          // Convert image
          if (verbose) {
            Logger.log(`转换中: ${entryPath}`);
            Logger.log(`Converting: ${entryPath}`);
          }
          
          await sharp(entryPath)
            .webp({ quality })
            .toFile(webpPath);
          
          // 获取转换后文件大小
          // Get file size after conversion
          const webpStats = fs.statSync(webpPath);
          stats.totalSizeAfter += webpStats.size;
          
          // 如果不保留原始图片，则删除
          // Delete original image if not keeping it
          if (!keepOriginal) {
            fs.unlinkSync(entryPath);
          }
          
          stats.convertedFiles++;
          
          if (verbose) {
            const originalSize = formatSize(originalStats.size);
            const webpSize = formatSize(webpStats.size);
            const savedPercent = ((originalStats.size - webpStats.size) / originalStats.size * 100).toFixed(2);
            Logger.log(`转换成功: ${entryPath} (${originalSize} → ${webpSize}, 节省 ${savedPercent}%)`);
            Logger.log(`Conversion successful: ${entryPath} (${originalSize} → ${webpSize}, saved ${savedPercent}%)`);
          }
        } catch (error) {
          stats.errorFiles++;
          Logger.error(`转换失败: ${entryPath}`, error);
          Logger.error(`Conversion failed: ${entryPath}`, error);
        }
      }
    }
  }
}

/**
 * 格式化文件大小显示
 * Format file size for display
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * 从命令行运行图片转换
 * Run image conversion from command line
 * @param args 命令行参数 (Command line arguments)
 */
export async function runFromCli(args: string[]): Promise<void> {
  // 简单的命令行参数解析
  // Simple command line argument parsing
  const directoryPath = args[0];
  
  if (!directoryPath) {
    Logger.error('请提供目录路径');
    Logger.error('Please provide a directory path');
    process.exit(1);
  }
  
  const options: ConvertToWebpOptions = {
    quality: 80,
    recursive: false,
    keepOriginal: true,
    verbose: false
  };
  
  // 解析选项
  // Parse options
  for (let i = 1; i < args.length; i++) {
    const arg = args[i].toLowerCase();
    
    if (arg === '--quality' || arg === '-q') {
      const quality = parseInt(args[++i], 10);
      if (!isNaN(quality) && quality >= 0 && quality <= 100) {
        options.quality = quality;
      }
    } else if (arg === '--recursive' || arg === '-r') {
      options.recursive = true;
    } else if (arg === '--no-keep-original' || arg === '-d') {
      options.keepOriginal = false;
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    }
  }
  
  try {
    await convertImagesToWebp(directoryPath, options);
  } catch (error) {
    Logger.error('转换失败:', error);
    Logger.error('Conversion failed:', error);
    process.exit(1);
  }
}

/**
 * 将PNG图片转换为WebP格式
 * Convert PNG images to WebP format
 * 
 * @param imagePaths 要处理的图片路径数组 (Array of image paths to process)
 * @param options 转换选项 (Conversion options)
 * @returns 转换结果统计 (Conversion statistics)
 */
export async function convertPngToWebp(
  imagePaths: string[],
  options: ConvertToWebpOptions = {}
): Promise<ConversionStats> {
  const {
    quality = 80,
    keepOriginal = false,
    verbose = false
  } = options;

  const stats: ConversionStats = {
    totalFiles: 0,
    convertedFiles: 0,
    skippedFiles: 0,
    errorFiles: 0,
    totalSizeBefore: 0,
    totalSizeAfter: 0
  };

  if (imagePaths.length === 0) {
    Logger.log('没有提供图片路径');
    Logger.log('No image paths provided');
    return stats;
  }

  try {
    for (const imagePath of imagePaths) {
      // 检查文件是否存在
      // Check if file exists
      if (!fs.existsSync(imagePath)) {
        Logger.error(`文件不存在: ${imagePath}`);
        Logger.error(`File does not exist: ${imagePath}`);
        stats.errorFiles++;
        continue;
      }

      // 检查是否为PNG文件
      // Check if it's a PNG file
      const ext = path.extname(imagePath).toLowerCase();
      if (ext !== '.png') {
        Logger.log(`跳过非PNG文件: ${imagePath}`);
        Logger.log(`Skipping non-PNG file: ${imagePath}`);
        stats.skippedFiles++;
        continue;
      }

      stats.totalFiles++;

      // 生成WebP文件路径
      // Generate WebP file path
      const dirPath = path.dirname(imagePath);
      const baseName = path.basename(imagePath, ext);
      const webpPath = path.join(dirPath, `${baseName}.webp`);

      // 如果已经有同名的WebP文件，则跳过
      // Skip if a WebP file with the same name already exists
      if (fs.existsSync(webpPath)) {
        if (verbose) {
          Logger.log(`跳过 (已存在WebP): ${imagePath}`);
          Logger.log(`Skip (WebP already exists): ${imagePath}`);
        }
        stats.skippedFiles++;
        continue;
      }

      try {
        // 获取原始文件大小
        // Get original file size
        const originalStats = fs.statSync(imagePath);
        stats.totalSizeBefore += originalStats.size;

        // 转换图片
        // Convert image
        if (verbose) {
          Logger.log(`转换中: ${imagePath}`);
          Logger.log(`Converting: ${imagePath}`);
        }

        await sharp(imagePath)
          .webp({ quality })
          .toFile(webpPath);

        // 获取转换后文件大小
        // Get file size after conversion
        const webpStats = fs.statSync(webpPath);
        stats.totalSizeAfter += webpStats.size;

        // 如果不保留原始图片，则删除
        // Delete original image if not keeping it
        if (!keepOriginal) {
          fs.unlinkSync(imagePath);
        }

        stats.convertedFiles++;

        if (verbose) {
          const originalSize = formatSize(originalStats.size);
          const webpSize = formatSize(webpStats.size);
          const savedPercent = ((originalStats.size - webpStats.size) / originalStats.size * 100).toFixed(2);
          Logger.log(`转换成功: ${imagePath} (${originalSize} → ${webpSize}, 节省 ${savedPercent}%)`);
          Logger.log(`Conversion successful: ${imagePath} (${originalSize} → ${webpSize}, saved ${savedPercent}%)`);
        }
      } catch (error) {
        stats.errorFiles++;
        Logger.error(`转换失败: ${imagePath}`, error);
        Logger.error(`Conversion failed: ${imagePath}`, error);
      }
    }

    // 计算节省的空间和压缩率
    // Calculate saved space and compression ratio
    const savedSize = stats.totalSizeBefore - stats.totalSizeAfter;
    const compressionRatio = stats.totalSizeBefore > 0
      ? (savedSize / stats.totalSizeBefore * 100).toFixed(2)
      : '0';

    Logger.log(`
转换完成:
- 总文件数: ${stats.totalFiles}
- 已转换: ${stats.convertedFiles}
- 已跳过: ${stats.skippedFiles}
- 错误: ${stats.errorFiles}
- 原始大小: ${formatSize(stats.totalSizeBefore)}
- 转换后大小: ${formatSize(stats.totalSizeAfter)}
- 节省空间: ${formatSize(savedSize)} (${compressionRatio}%)

Conversion completed:
- Total files: ${stats.totalFiles}
- Converted: ${stats.convertedFiles}
- Skipped: ${stats.skippedFiles}
- Errors: ${stats.errorFiles}
- Original size: ${formatSize(stats.totalSizeBefore)}
- Size after conversion: ${formatSize(stats.totalSizeAfter)}
- Saved space: ${formatSize(savedSize)} (${compressionRatio}%)
`);

    return stats;
  } catch (error) {
    Logger.error('转换过程中发生错误:', error);
    Logger.error('Error during conversion:', error);
    throw error;
  }
} 