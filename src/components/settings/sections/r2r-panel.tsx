import { useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import { invoke } from "@tauri-apps/api/core"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { SettingsDraft, DraftSetter } from "../settings-types"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

type Status =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ok"; documents?: number }
  | { kind: "error"; message: string }

/**
 * R2R serves semantic search from a single index over the whole corpus, so the
 * pages don't have to be embedded one by one from the app. Everything above
 * this — search results, the MCP tools, the clipper — is unchanged; only where
 * the vectors live moves.
 *
 * The engine listens on loopback of the machine holding the vault, so the check
 * runs there (through the backend), not in the browser.
 */
export function R2RPanel({ draft, setDraft }: Props) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<Status>({ kind: "idle" })

  const check = useCallback(async () => {
    setStatus({ kind: "checking" })
    try {
      const res = await invoke<{ ok?: boolean; documents?: number; error?: string }>("r2r_status", {
        baseUrl: draft.r2rBaseUrl.trim(),
      })
      if (res?.ok) setStatus({ kind: "ok", documents: res.documents })
      else setStatus({ kind: "error", message: res?.error ?? "unreachable" })
    } catch (err) {
      setStatus({ kind: "error", message: (err as Error).message })
    }
  }, [draft.r2rBaseUrl])

  return (
    <div className="rounded-md border p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium">
            {t("settings.sections.embedding.r2r.enableLabel", "Semantic search engine (R2R)")}
          </div>
          <div className="text-xs text-muted-foreground">
            {t(
              "settings.sections.embedding.r2r.enableHint",
              "Answer semantic search from an R2R engine indexing the whole vault, instead of embedding pages from this app.",
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setDraft("r2rEnabled", !draft.r2rEnabled)}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            draft.r2rEnabled ? "bg-primary" : "bg-muted"
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
              draft.r2rEnabled ? "translate-x-4.5" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      {draft.r2rEnabled && (
        <div className="space-y-2">
          <Label htmlFor="r2r-base-url">
            {t("settings.sections.embedding.r2r.baseUrlLabel", "Engine address")}
          </Label>
          <div className="flex gap-2">
            <Input
              id="r2r-base-url"
              value={draft.r2rBaseUrl}
              placeholder="http://127.0.0.1:7272"
              onChange={(e) => setDraft("r2rBaseUrl", e.target.value)}
            />
            <Button type="button" variant="outline" onClick={check} disabled={status.kind === "checking"}>
              {t("settings.sections.embedding.r2r.check", "Check")}
            </Button>
          </div>
          {status.kind === "ok" && (
            <p className="text-xs text-green-600 dark:text-green-500">
              {t("settings.sections.embedding.r2r.reachable", "Reachable")}
              {status.documents !== undefined
                ? ` — ${status.documents} ${t("settings.sections.embedding.r2r.documents", "documents indexed")}`
                : ""}
            </p>
          )}
          {status.kind === "error" && (
            <p className="text-xs text-destructive">
              {t("settings.sections.embedding.r2r.unreachable", "Not reachable")}: {status.message}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
