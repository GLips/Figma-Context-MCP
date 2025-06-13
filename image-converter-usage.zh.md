# WebP 图片转换工具使用指南
# WebP Image Converter User Guide

这个工具可以将指定目录中的图片（JPG、PNG、GIF 等）批量转换为 WebP 格式，以减小文件体积并提高加载速度。
This tool can batch convert images (JPG, PNG, GIF, etc.) in a specified directory to WebP format, reducing file size and improving loading speed.

## 作为命令行工具使用
## Using as a Command Line Tool

安装完成后，可以通过以下命令使用：
After installation, you can use it with the following commands:

```bash
# 使用 npm 脚本
# Using npm script
npm run webp -- <目录路径> [选项]

# 或者使用全局安装的命令
# Or using globally installed command
webp-converter <目录路径> [选项]
```

### 命令行选项
### Command Line Options

- `--quality`, `-q` <0-100>: WebP 压缩质量，默认为 80
  WebP compression quality, default is 80
- `--recursive`, `-r`: 递归处理子目录
  Process subdirectories recursively
- `--no-keep-original`, `-d`: 不保留原始图片
  Don't keep original images
- `--verbose`, `-v`: 显示详细日志
  Display detailed logs
- `--help`, `-h`: 显示帮助信息
  Display help information

### 示例
### Examples

```bash
# 转换 images 目录中的所有图片，质量为 85%，递归处理子目录，显示详细日志
# Convert all images in the images directory with 85% quality, recursively process subdirectories, and display detailed logs
npm run webp -- ./images -q 85 -r -v

# 转换 assets/images 目录中的所有图片，不保留原始图片
# Convert all images in the assets/images directory without keeping original images
npm run webp -- ./assets/images -d
```

## 作为 API 使用
## Using as an API

在代码中可以直接导入并使用 `convertImagesToWebp` 函数：
You can directly import and use the `convertImagesToWebp` function in your code:

```typescript
import { convertImagesToWebp } from 'figma-developer-mcp';

async function convertImages() {
  try {
    const stats = await convertImagesToWebp('./images', {
      quality: 85,
      recursive: true,
      keepOriginal: true,
      verbose: true
    });
    
    console.log(`转换完成，共处理 ${stats.totalFiles} 个文件，转换 ${stats.convertedFiles} 个文件`);
    console.log(`节省空间: ${(stats.totalSizeBefore - stats.totalSizeAfter) / 1024 / 1024} MB`);
    
    // English version
    console.log(`Conversion completed, processed ${stats.totalFiles} files, converted ${stats.convertedFiles} files`);
    console.log(`Saved space: ${(stats.totalSizeBefore - stats.totalSizeAfter) / 1024 / 1024} MB`);
  } catch (error) {
    console.error('转换失败:', error);
    console.error('Conversion failed:', error);
  }
}

convertImages();
```

### 选项说明
### Options Description

`convertImagesToWebp` 函数接受以下选项：
The `convertImagesToWebp` function accepts the following options:

- `quality`: WebP 压缩质量 (0-100)，默认为 80
  WebP compression quality (0-100), default is 80
- `recursive`: 是否递归处理子目录，默认为 false
  Whether to process subdirectories recursively, default is false
- `keepOriginal`: 是否保留原始图片，默认为 true
  Whether to keep original images, default is true
- `verbose`: 是否显示详细日志，默认为 false
  Whether to display detailed logs, default is false

## 注意事项
## Notes

1. 转换后的图片将保存在原目录中，文件名与原图一致，仅扩展名替换为 .webp
   Converted images will be saved in the original directory with the same filename, only the extension is replaced with .webp
2. 如果目录中已存在同名的 WebP 文件，该图片将被跳过
   If a WebP file with the same name already exists in the directory, the image will be skipped
3. 使用 `--no-keep-original` 选项时请谨慎，这将删除原始图片文件
   Please be cautious when using the `--no-keep-original` option as it will delete the original image files 