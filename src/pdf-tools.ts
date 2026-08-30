import { fileStem, finalizeOutputFile, workingOutputPath } from "./output-utils"
import { insertPDFPage } from "./pdf-compat"

export type ParsedPageRange = {
  indexes: number[]
  label: string
}

type ParsePageRangeOptions = {
  preserveOrder?: boolean
}

function rangeLabel(indexes: number[]): string {
  const pages = indexes.map(index => index + 1)
  const parts: string[] = []
  let start = pages[0]
  let previous = pages[0]
  for (let index = 1; index <= pages.length; index += 1) {
    const current = pages[index]
    if (current === previous + 1) {
      previous = current
      continue
    }
    parts.push(start === previous ? String(start) : `${start}-${previous}`)
    start = current
    previous = current
  }
  return parts.join(",")
}

export function parsePageRange(input: string, pageCount: number, options: ParsePageRangeOptions = {}): ParsedPageRange {
  const normalized = input.replace(/，/g, ",").trim()
  if (!normalized) throw new Error("请输入页码范围，例如 1-3, 8, 10-15。")
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error("PDF 没有可处理的页面。")

  const indexes: number[] = []
  const used = new Set<number>()
  for (const rawPart of normalized.split(",")) {
    const part = rawPart.trim()
    if (!part) throw new Error("页码范围中存在空项目，请检查逗号。")
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part)
    if (!match) throw new Error(`“${part}”不是合法页码，请使用 1-3, 8 这种格式。`)
    const start = Number(match[1])
    const end = match[2] ? Number(match[2]) : start
    if (start < 1 || end < 1) throw new Error("页码从 1 开始。")
    if (start > end) throw new Error(`页码范围“${part}”的起始页不能大于结束页。`)
    if (end > pageCount) throw new Error(`页码 ${end} 越界，此 PDF 共 ${pageCount} 页。`)
    for (let page = start; page <= end; page += 1) {
      const pageIndex = page - 1
      if (used.has(pageIndex)) throw new Error(`页码 ${page} 重复。`)
      used.add(pageIndex)
      indexes.push(pageIndex)
    }
  }
  if (!options.preserveOrder) indexes.sort((left, right) => left - right)
  return { indexes, label: rangeLabel(indexes) }
}

export function parsePDFSplitRanges(input: string, pageCount: number): ParsedPageRange[] {
  const normalized = input.replace(/[，、；;]/g, ",").trim()
  if (!normalized) throw new Error("请输入拆分范围，例如 1-3、4-6、7-10。")
  const used = new Set<number>()
  const ranges: ParsedPageRange[] = []
  for (const rawPart of normalized.split(",")) {
    const part = rawPart.trim()
    if (!part) throw new Error("拆分范围中存在空项目，请检查分隔符。")
    const range = parsePageRange(part, pageCount, { preserveOrder: true })
    for (const index of range.indexes) {
      if (used.has(index)) throw new Error(`页码 ${index + 1} 在拆分范围中重复。`)
      used.add(index)
    }
    ranges.push(range)
  }
  if (used.size !== pageCount) {
    const missing = Array.from({ length: pageCount }, (_, index) => index + 1).filter(page => !used.has(page - 1))
    throw new Error(`拆分范围必须覆盖全部 ${pageCount} 页；缺少第 ${missing.join(",")} 页。只需要提取部分页面时，请使用“提取指定页面”。`)
  }
  return ranges
}

function openPDF(path: string): PDFDocument {
  const document = PDFDocument.fromFilePath(path)
  if (!document) throw new Error("无法打开 PDF，文件可能损坏或格式无效。")
  if (document.isLocked) throw new Error("此 PDF 已加密并锁定，当前操作需要先解锁。")
  if (document.pageCount < 1) throw new Error("PDF 没有页面。")
  return document
}

async function documentFromPage(page: PDFPage): Promise<PDFDocument> {
  const data = await page.data
  if (!data) throw new Error("无法读取 PDF 页面数据。")
  const document = PDFDocument.fromData(data)
  if (!document) throw new Error("无法从页面创建 PDF 文档。")
  return document
}

async function writePDF(
  document: PDFDocument,
  stem: string,
): Promise<string> {
  const workingPath = await workingOutputPath(stem, "pdf")
  const success = await document.write(workingPath)
  if (!success) throw new Error("PDF 写入失败。")
  return finalizeOutputFile(workingPath, stem, "pdf")
}

export async function mergePDFs(paths: string[]): Promise<string> {
  if (paths.length < 2) throw new Error("合并 PDF 至少需要选择两个 PDF 文件。")
  let outputDocument: PDFDocument | null = null
  let insertionIndex = 0
  for (const path of paths) {
    const source = openPDF(path)
    for (let pageIndex = 0; pageIndex < source.pageCount; pageIndex += 1) {
      const page = source.pageAt(pageIndex)
      if (!page) throw new Error(`无法读取 ${fileStem(path)} 的第 ${pageIndex + 1} 页。`)
      if (!outputDocument) {
        outputDocument = await documentFromPage(page)
        insertionIndex = 1
      } else {
        insertPDFPage(outputDocument, page, insertionIndex)
        insertionIndex += 1
      }
    }
  }
  if (!outputDocument) throw new Error("没有可合并的 PDF 页面。")
  return writePDF(outputDocument, `${fileStem(paths[0])}_merged_${paths.length}`)
}

export type PDFSplitMode = "each" | "ranges"

export async function splitPDFPages(
  path: string,
  mode: PDFSplitMode,
  input?: string,
): Promise<string[]> {
  const source = openPDF(path)
  const groups: ParsedPageRange[] = mode === "each"
    ? Array.from({ length: source.pageCount }, (_, index) => ({ indexes: [index], label: String(index + 1) }))
    : parsePDFSplitRanges(input ?? "", source.pageCount)
  const outputPaths: string[] = []

  try {
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const group = groups[groupIndex]
      const firstPage = source.pageAt(group.indexes[0])
      if (!firstPage) throw new Error(`无法读取拆分分组 ${groupIndex + 1} 的起始页。`)
      const outputDocument = await documentFromPage(firstPage)
      for (let pageIndex = 1; pageIndex < group.indexes.length; pageIndex += 1) {
        const sourceIndex = group.indexes[pageIndex]
        const page = source.pageAt(sourceIndex)
        if (!page) throw new Error(`无法读取第 ${sourceIndex + 1} 页。`)
        insertPDFPage(outputDocument, page, pageIndex)
      }
      const suffix = mode === "each"
        ? `split_${groupIndex + 1}`
        : `split_${groupIndex + 1}_pages_${group.label.replace(/,/g, "_")}`
      outputPaths.push(await writePDF(outputDocument, `${fileStem(path)}_${suffix}`))
    }
    return outputPaths
  } catch (error) {
    for (const outputPath of outputPaths) {
      if (await FileManager.exists(outputPath)) await FileManager.remove(outputPath)
    }
    throw error
  }
}

export async function extractPDFPages(path: string, input: string): Promise<string> {
  const source = openPDF(path)
  const range = parsePageRange(input, source.pageCount)
  const firstPage = source.pageAt(range.indexes[0])
  if (!firstPage) throw new Error("无法读取选择的起始页。")
  const outputDocument = await documentFromPage(firstPage)
  for (let index = 1; index < range.indexes.length; index += 1) {
    const sourceIndex = range.indexes[index]
    const page = source.pageAt(sourceIndex)
    if (!page) throw new Error(`无法读取第 ${sourceIndex + 1} 页。`)
    insertPDFPage(outputDocument, page, index)
  }
  return writePDF(outputDocument, `${fileStem(path)}_pages_${range.label.replace(/,/g, "_")}`)
}

export async function reorderPDFPages(path: string, input: string): Promise<string> {
  const source = openPDF(path)
  const range = parsePageRange(input, source.pageCount, { preserveOrder: true })
  if (range.indexes.length !== source.pageCount) {
    throw new Error(`重排必须包含全部 ${source.pageCount} 页，当前只包含 ${range.indexes.length} 页。需要提取部分页面时，请使用“提取指定页面”。`)
  }
  const firstPage = source.pageAt(range.indexes[0])
  if (!firstPage) throw new Error("无法读取重排的起始页。")
  const outputDocument = await documentFromPage(firstPage)
  for (let index = 1; index < range.indexes.length; index += 1) {
    const sourceIndex = range.indexes[index]
    const page = source.pageAt(sourceIndex)
    if (!page) throw new Error(`无法读取第 ${sourceIndex + 1} 页。`)
    insertPDFPage(outputDocument, page, index)
  }
  return writePDF(outputDocument, `${fileStem(path)}_reordered`)
}

export async function deletePDFPages(path: string, input: string): Promise<string> {
  const document = openPDF(path)
  const range = parsePageRange(input, document.pageCount)
  if (range.indexes.length === document.pageCount) {
    throw new Error("不能删除全部页面；PDF 至少需要保留一页。")
  }
  for (const index of [...range.indexes].sort((left, right) => right - left)) {
    document.removePageAt(index)
  }
  return writePDF(document, `${fileStem(path)}_deleted_${range.label.replace(/,/g, "_")}`)
}

export function estimatedExtractPageCount(path: string, input: string): number {
  const document = openPDF(path)
  return parsePageRange(input, document.pageCount).indexes.length
}

export function estimatedDeletePageCount(path: string, input: string): number {
  const document = openPDF(path)
  const removed = parsePageRange(input, document.pageCount).indexes.length
  if (removed === document.pageCount) throw new Error("不能删除全部页面；PDF 至少需要保留一页。")
  return document.pageCount - removed
}

export function pdfPageCount(path: string): number {
  return openPDF(path).pageCount
}

export async function rotatePDFPages(): Promise<never> {
  throw new Error("当前 Scripting 官方 PDFPage API 未提供页面旋转属性或方法，本阶段无法在不引入第三方库的条件下安全实现。")
}

export async function exportPDFPagesToImages(): Promise<never> {
  throw new Error("当前 Scripting 官方 PDFPage API 未提供页面光栅化/缩略图方法，本阶段无法在不引入第三方库的条件下导出页面图片。")
}
