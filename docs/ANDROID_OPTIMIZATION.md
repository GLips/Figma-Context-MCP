# Android UI 开发数据优化

## 概述

本工具现在支持针对 Android UI 开发的数据精简功能,可以大幅减少数据量(约 60-70%),同时保留所有 Android 开发所需的关键信息。

## 使用方法

在调用 `get_figma_data` 工具时,添加 `optimizeForAndroid: true` 参数:

```typescript
{
  "fileKey": "your-file-key",
  "nodeId": "121:113", // 可选
  "optimizeForAndroid": true
}
```

## 优化内容

### 自动过滤的节点类型

1. **不可见节点** (`visible: false`)
   - 所有标记为不可见的元素及其子节点都会被移除

2. **切片节点** (`type: "SLICE"`)
   - 仅用于导出的切片节点会被移除

### 保留的关键数据

优化后保留以下 Android UI 开发必需的数据:

#### 节点基础信息
- `id` - 节点唯一标识
- `name` - 节点名称(可能包含开发注释)
- `type` - 节点类型

#### 布局信息
- `layout` - 布局属性(位置、尺寸、约束等)

#### 文本内容
- `text` - 文本内容
- `textStyle` - 文本样式(字体、大小、颜色等)

#### 视觉样式
- `fills` - 填充颜色/渐变
- `strokes` - 描边颜色
- `strokeWeight` - 描边宽度
- `effects` - 视觉效果(阴影、模糊等)
- `opacity` - 不透明度
- `borderRadius` - 圆角半径

#### 组件信息
- `componentId` - 组件ID(用于识别复用组件)
- `componentProperties` - 组件属性

#### 层级结构
- `children` - 子节点(递归优化)

### 移除的数据类型

以下数据在 Android UI 开发中不需要,会被移除:

1. **设计工具元数据**
   - `lastModified`, `thumbnailUrl`, `version`
   - `role`, `editorType`, `linkAccess`
   - `schemaVersion`, `remote`, `documentationLinks`

2. **交互和原型数据**
   - `interactions`, `prototypeStartNodeID`
   - `flowStartingPoints`, `prototypeDevice`
   - `transitionNodeID`, `transitionDuration`, `transitionEasing`

3. **渲染相关**
   - `absoluteRenderBounds`(保留 `absoluteBoundingBox`)
   - 过度精确的数值(自动四舍五入到2位小数)

4. **样式系统**
   - `styles` 对象引用(已有具体值)
   - `styleOverrideTable`, `characterStyleOverrides`

5. **实例覆盖**
   - `overrides` - Figma 组件实例覆盖信息

6. **导出设置**
   - `exportSettings`(除非需要下载图片资源)

## 数据精度优化

所有数值型数据会被四舍五入到2位小数,例如:
- `0.60000002384185791` → `0.6`
- `1923.0` → `1923`

这不会影响 Android 开发精度,但能显著减少数据量。

## 示例对比

### 优化前
```json
{
  "id": "121:114",
  "name": "gender_can_not_motify_tip_text",
  "type": "TEXT",
  "scrollBehavior": "SCROLLS",
  "blendMode": "PASS_THROUGH",
  "visible": true,
  "fills": [...],
  "strokes": [],
  "strokeWeight": 0.0,
  "strokeAlign": "CENTER",
  "styles": { "fill": "2:157" },
  "absoluteBoundingBox": {
    "x": 1923.0,
    "y": 481.0,
    "width": 413.0,
    "height": 31.0
  },
  "absoluteRenderBounds": {...},
  "constraints": {...},
  "characters": "Cannot modify after select gender",
  "characterStyleOverrides": [],
  "styleOverrideTable": {},
  "lineTypes": ["NONE"],
  "lineIndentations": [0],
  "style": {...},
  "layoutVersion": 4,
  "effects": [],
  "interactions": []
}
```

### 优化后
```json
{
  "id": "121:114",
  "name": "gender_can_not_motify_tip_text",
  "type": "TEXT",
  "layout": "layout_xyz123",
  "text": "Cannot modify after select gender",
  "textStyle": "style_abc456",
  "fills": "fill_def789"
}
```

## 最佳实践

1. **识别开发注释**
   - 节点名称中的注释(如 `"Android使用GameTextView实现"`)会被保留
   - 使用这些注释来指导具体的 Android 实现

2. **图片资源处理**
   - 包含 `imageRef` 的节点表示需要下载的图片资源
   - 矢量图形会被标记为 `IMAGE-SVG` 类型

3. **布局映射**
   - `FRAME` → Android `ConstraintLayout` / `LinearLayout`
   - `TEXT` → Android `TextView` / `GameTextView`
   - `RECTANGLE` → Android `View` with background
   - `INSTANCE` → Android 自定义组件/复用组件

4. **样式引用**
   - 所有样式存储在 `globalVars.styles` 中
   - 节点通过引用ID来使用样式,避免重复

## 性能提升

- **数据量减少**: 约 60-70%
- **解析速度**: 显著提升
- **Token 消耗**: 大幅降低(适合大模型处理)
- **可读性**: 更清晰的数据结构

## 注意事项

1. 此优化专门针对 Android UI 开发,不适用于:
   - 完整的设计审查
   - 交互原型分析
   - 设计系统文档

2. 如需完整数据,请不要设置 `optimizeForAndroid` 参数

3. 某些复杂效果可能被简化,如需100%还原,请查看原始 Figma 文件

