import type { FileNode } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"

const HIDDEN_SOURCE_ENTRY_NAMES = new Set([".cache", ".DS_Store"])
const SENSITIVE_CONFIG_EXTENSIONS = new Set(["env", "json", "toml", "yaml", "yml", "xml"])
const SENSITIVE_CONFIG_DIR_NAMES = new Set([
  ".claude",
  ".codex",
  ".cursor",
  ".gemini",
  ".mcp",
])

export function isHiddenRawSourceEntryName(name: string): boolean {
  return HIDDEN_SOURCE_ENTRY_NAMES.has(name)
}

export interface FilterRawSourceTreeOptions {
  /**
   * Lazy mode (web, huge vaults): a directory whose `children` is
   * `undefined` has NOT been loaded yet — keep it untouched instead of
   * pruning it as "empty". Only directories that were actually loaded
   * and came back empty get pruned. Off by default → desktop behaviour
   * (full recursive tree) is unchanged.
   */
  lazy?: boolean
}

export function filterRawSourceTree(
  nodes: FileNode[],
  options: FilterRawSourceTreeOptions = {},
): FileNode[] {
  const lazy = options.lazy ?? false
  return nodes
    .filter((node) =>
      !isHiddenRawSourceEntryName(node.name) &&
      (node.is_dir || !isSensitiveConfigSourceFile(node.path))
    )
    .map((node) => {
      if (!node.is_dir) return node
      if (lazy && node.children === undefined) return node // unloaded — leave as-is
      return { ...node, children: filterRawSourceTree(node.children ?? [], options) }
    })
    .filter((node) => {
      if (!node.is_dir) return true
      if (lazy && node.children === undefined) return true // unloaded dir — keep
      return Boolean(node.children && node.children.length > 0)
    })
}

export function isSensitiveConfigSourceFile(path: string): boolean {
  const parts = normalizePath(path).split("/").filter(Boolean)
  const name = parts[parts.length - 1] ?? ""
  const ext = name.includes(".") ? name.split(".").pop()?.toLowerCase() : ""
  return Boolean(
    ext &&
      SENSITIVE_CONFIG_EXTENSIONS.has(ext) &&
      parts.some((part) => SENSITIVE_CONFIG_DIR_NAMES.has(part.toLowerCase())),
  )
}
