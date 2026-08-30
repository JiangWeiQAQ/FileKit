import { Path, Script } from "scripting"
import type { BridgeResponse, JSONObject, JSONValue } from "./types"

function failure(message: string): BridgeResponse {
  return { success: false, message, files: [], data: null }
}

function isJSONValue(value: unknown): value is JSONValue {
  if (value === null) return true
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true
  if (Array.isArray(value)) return value.every(isJSONValue)
  if (typeof value !== "object") return false
  return Object.values(value).every(isJSONValue)
}

function parseResponse(output: string): BridgeResponse {
  const lines = output.split("\n").map(line => line.trim()).filter(Boolean)
  const lastLine = lines.at(-1)
  if (!lastLine) return failure("Python 未返回 JSON 结果。")

  let parsed: unknown
  try {
    parsed = JSON.parse(lastLine)
  } catch {
    return failure(`无法解析 Python 返回值：${lastLine}`)
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return failure("Python 返回值不是 JSON 对象。")
  }

  const response = parsed as Record<string, unknown>
  if (
    typeof response.success !== "boolean" ||
    typeof response.message !== "string" ||
    !Array.isArray(response.files) ||
    !response.files.every(file => typeof file === "string") ||
    !(response.data === undefined || isJSONValue(response.data))
  ) {
    return failure("Python 返回值不符合 FileKit Bridge 协议。")
  }

  return {
    success: response.success,
    message: response.message,
    files: response.files,
    data: response.data ?? null,
  }
}

export async function runPythonBridge(
  action: string,
  files: string[] = [],
  options: JSONObject = {},
): Promise<BridgeResponse> {
  const scriptPath = Path.join(Script.directory, "python", "bridge.py")
  if (!(await FileManager.exists(scriptPath))) {
    return failure(`找不到 Python Bridge：${scriptPath}`)
  }

  try {
    const result = await Python.runFile(scriptPath, {
      cwd: Script.directory,
      queryParameters: { action, files, options },
    })
    if (result.exitCode !== 0) {
      return failure(result.output.trim() || `Python 执行失败，退出码 ${result.exitCode}。`)
    }
    return parseResponse(result.output)
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error))
  }
}

export async function shareOutputFiles(paths: string[]): Promise<boolean> {
  if (!paths.length) {
    await Dialog.alert({ title: "没有输出文件", message: "当前操作没有生成可分享的文件。" })
    return false
  }

  for (const path of paths) {
    if (!(await FileManager.exists(path))) {
      await Dialog.alert({ title: "文件不存在", message: path })
      return false
    }
  }

  return ShareSheet.present(paths)
}
