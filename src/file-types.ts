import { Path } from "scripting"
import type { FileInfo, FileKind, FileOperation } from "./types"

const IMAGE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "heic",
  "heif",
  "webp",
  "tif",
  "tiff",
  "bmp",
  "svg",
])

const OPERATIONS: Record<FileKind, FileOperation[]> = {
  pdf: [
    { id: "pdf-merge", title: "合并 PDF", systemImage: "square.stack.3d.up", implemented: true },
    { id: "pdf-extract", title: "提取指定页面", systemImage: "doc.on.doc", implemented: true },
    { id: "pdf-delete", title: "删除指定页面", systemImage: "trash", implemented: true },
    { id: "pdf-reorder", title: "重排页面", systemImage: "arrow.up.arrow.down", implemented: true },
    { id: "pdf-split", title: "拆分 PDF", systemImage: "rectangle.split.3x1", implemented: true },
    { id: "pdf-rotate", title: "旋转页面", systemImage: "rotate.right", implemented: false },
    { id: "pdf-to-images", title: "页面导出为图片", systemImage: "photo.on.rectangle", implemented: false },
  ],
  image: [
    { id: "image-convert", title: "转换图片格式", systemImage: "arrow.triangle.2.circlepath", implemented: true },
    { id: "image-compress", title: "压缩图片", systemImage: "arrow.down.right.and.arrow.up.left", implemented: true },
    { id: "image-resize", title: "调整尺寸", systemImage: "aspectratio", implemented: true },
    { id: "image-remove-metadata", title: "删除 EXIF / metadata", systemImage: "eye.slash", implemented: true },
    { id: "images-to-pdf", title: "转换为 PDF", systemImage: "doc.richtext", implemented: true },
  ],
  docx: [
    { id: "docx-info", title: "查看文档信息", systemImage: "info.circle", implemented: true },
    { id: "docx-text", title: "提取文字", systemImage: "text.alignleft", implemented: true },
    { id: "docx-images", title: "提取图片", systemImage: "photo.on.rectangle", implemented: true },
    { id: "docx-replace", title: "查找并替换文字", systemImage: "text.badge.checkmark", implemented: true },
  ],
  xlsx: [
    { id: "xlsx-info", title: "查看工作簿信息", systemImage: "info.circle", implemented: true },
    { id: "xlsx-to-csv", title: "导出 Sheet 为 CSV", systemImage: "tablecells", implemented: true },
    { id: "xlsx-clean", title: "删除完全空白行和列", systemImage: "rectangle.compress.vertical", implemented: true },
  ],
  pptx: [
    { id: "pptx-info", title: "查看演示文稿信息", systemImage: "info.circle", implemented: true },
    { id: "pptx-text", title: "提取全部幻灯片文字", systemImage: "text.alignleft", implemented: true },
    { id: "pptx-images", title: "提取图片", systemImage: "photo.on.rectangle", implemented: true },
    { id: "pptx-replace", title: "查找并替换文字", systemImage: "text.badge.checkmark", implemented: true },
  ],
  txt: [
    { id: "text-base64-encode", title: "Base64 编码", systemImage: "lock", implemented: true },
    { id: "text-base64-decode", title: "Base64 解码", systemImage: "lock.open", implemented: true },
    { id: "text-url-encode", title: "URL 编码", systemImage: "link", implemented: true },
    { id: "text-url-decode", title: "URL 解码", systemImage: "link", implemented: true },
    { id: "text-deduplicate-lines", title: "文本行去重", systemImage: "text.line.first.and.arrowtriangle.forward", implemented: true },
  ],
  csv: [
    { id: "csv-to-json", title: "转换为 JSON", systemImage: "curlybraces", implemented: true },
  ],
  json: [
    { id: "json-format", title: "格式化 JSON", systemImage: "text.alignleft", implemented: true },
    { id: "json-minify", title: "压缩 JSON", systemImage: "arrow.down.right.and.arrow.up.left", implemented: true },
    { id: "json-validate", title: "校验 JSON", systemImage: "checkmark.seal", implemented: true },
    { id: "json-to-csv", title: "转换为 CSV", systemImage: "tablecells", implemented: true },
  ],
  html: [
    { id: "html-text", title: "提取纯文本", systemImage: "text.alignleft", implemented: true },
  ],
  markdown: [
    { id: "markdown-to-html", title: "转换为 HTML", systemImage: "chevron.left.forwardslash.chevron.right", implemented: false },
    { id: "markdown-to-pdf", title: "转换为 PDF", systemImage: "doc.richtext", implemented: false },
  ],
  unknown: [
    { id: "unknown-inspect", title: "检查文件", systemImage: "doc.text.magnifyingglass", implemented: false },
  ],
}

export function detectFileKind(path: string): FileKind {
  const extension = fileExtension(path)
  if (IMAGE_EXTENSIONS.has(extension)) return "image"

  switch (extension) {
    case "pdf":
    case "docx":
    case "xlsx":
    case "pptx":
    case "txt":
    case "csv":
    case "json":
    case "html":
      return extension
    case "htm":
      return "html"
    case "md":
    case "markdown":
      return "markdown"
    default:
      return "unknown"
  }
}

export function fileExtension(path: string): string {
  return Path.extname(path).replace(/^\./, "").toLowerCase()
}

export function formatName(kind: FileKind, extension: string): string {
  switch (kind) {
    case "image":
      return extension ? `图片 · ${extension.toUpperCase()}` : "图片"
    case "markdown":
      return "Markdown"
    case "unknown":
      return extension ? extension.toUpperCase() : "未知格式"
    default:
      return kind.toUpperCase()
  }
}

export function fileIcon(kind: FileKind): string {
  switch (kind) {
    case "pdf": return "doc.richtext"
    case "image": return "photo"
    case "docx": return "doc.text"
    case "xlsx": return "tablecells"
    case "pptx": return "rectangle.on.rectangle.angled"
    case "txt": return "doc.plaintext"
    case "csv": return "tablecells"
    case "json": return "curlybraces"
    case "html": return "chevron.left.forwardslash.chevron.right"
    case "markdown": return "text.document"
    case "unknown": return "doc"
  }
}

export function operationsFor(kind: FileKind): FileOperation[] {
  return OPERATIONS[kind]
}

const PRIMARY_OPERATION_IDS = new Set([
  "image-compress", "image-convert", "image-resize", "images-to-pdf",
  "pdf-merge", "pdf-extract", "pdf-delete", "pdf-reorder", "pdf-split",
  "docx-text", "docx-images", "docx-replace",
  "xlsx-to-csv", "xlsx-clean",
  "pptx-text", "pptx-images", "pptx-replace",
])

export function primaryOperationsFor(kind: FileKind): FileOperation[] {
  return operationsFor(kind).filter(operation => operation.implemented && PRIMARY_OPERATION_IDS.has(operation.id))
}

export function moreOperationsFor(kind: FileKind): FileOperation[] {
  return operationsFor(kind).filter(operation => operation.implemented && !PRIMARY_OPERATION_IDS.has(operation.id))
}

export async function inspectFiles(paths: string[]): Promise<FileInfo[]> {
  const files: FileInfo[] = []
  for (const path of paths) {
    const stat = await FileManager.stat(path)
    const extension = fileExtension(path)
    const kind = detectFileKind(path)
    files.push({
      path,
      name: Path.basename(path),
      extension,
      kind,
      format: formatName(kind, extension),
      size: stat.size,
    })
  }
  return files
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[unitIndex]}`
}
