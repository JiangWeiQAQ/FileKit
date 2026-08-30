export type FileKind =
  | "pdf"
  | "image"
  | "docx"
  | "xlsx"
  | "pptx"
  | "txt"
  | "csv"
  | "json"
  | "html"
  | "markdown"
  | "unknown"

export type FileInfo = {
  path: string
  name: string
  extension: string
  kind: FileKind
  format: string
  size: number
}

export type FileOperation = {
  id: string
  title: string
  systemImage: string
  implemented: boolean
}

export type JSONPrimitive = string | number | boolean | null
export type JSONValue = JSONPrimitive | JSONObject | JSONValue[]
export type JSONObject = { [key: string]: JSONValue }

export type BridgeResponse<T extends JSONValue = JSONValue> = {
  success: boolean
  message: string
  files: string[]
  data: T | null
}
