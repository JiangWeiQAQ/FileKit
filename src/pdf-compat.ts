type RuntimeInsertPageMethod = (page: PDFPage, index: number) => void

function isRuntimeInsertPageMethod(value: unknown): value is RuntimeInsertPageMethod {
  return typeof value === "function"
}

/**
 * Current Scripting runtime compatibility workaround.
 *
 * The public declaration and documentation expose `insertPageAt(page, atIndex)`,
 * while some shipped runtimes bind the same native selector as `insertPageAtAt`.
 * Keep that runtime difference here so PDF feature modules only use one stable API.
 */
export function insertPDFPage(document: PDFDocument, page: PDFPage, index: number): void {
  const declaredMethod: unknown = Reflect.get(document, "insertPageAt")
  if (isRuntimeInsertPageMethod(declaredMethod)) {
    declaredMethod.call(document, page, index)
    return
  }

  const runtimeAlias: unknown = Reflect.get(document, "insertPageAtAt")
  if (isRuntimeInsertPageMethod(runtimeAlias)) {
    runtimeAlias.call(document, page, index)
    return
  }

  throw new Error("当前 Scripting runtime 未提供可用的 PDF 页面插入方法。")
}
