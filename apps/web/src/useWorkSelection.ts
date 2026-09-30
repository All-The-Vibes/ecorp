import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  readWorkSelection, rememberWorkSelection, UNAVAILABLE_WORK_SELECTION, workSelectionKey,
} from './workSelection'
import type { WorkSelection, WorkSelectionScope } from './workSelection'

export function useWorkSelection(scope: WorkSelectionScope) {
  const key = scope.corpId && scope.actorId ? workSelectionKey(scope) : ''
  const generation = useMemo(() => ({ key }), [key])
  const currentGeneration = useRef<{ generation: typeof generation; version: number } | null>(null)
  const [saved, setSaved] = useState<{
    generation: typeof generation; version: number; choice: WorkSelection | null
  } | null>(null)
  useLayoutEffect(() => {
    currentGeneration.current = { generation, version: 0 }
    return () => { currentGeneration.current = null }
  }, [generation])
  useEffect(() => {
    if (!key) return
    const choice = readWorkSelection(() => window.sessionStorage, key)
    const current = currentGeneration.current
    if (current?.generation !== generation) return
    const version = ++current.version
    // Until restored, unknown prevents a previous viewer's context or an
    // arbitrary default from appearing. StrictMode may repeat this restore.
    // oxlint-disable-next-line react/set-state-in-effect
    setSaved({ generation, version, choice })
  }, [generation, key])
  const remember = useCallback((choice: WorkSelection): boolean => {
    // A callback captured before another choice or an A -> B -> A scope change
    // cannot replace the current choice when an asynchronous operation returns.
    const current = currentGeneration.current
    if (!key || current?.generation !== generation || saved?.generation !== generation ||
      saved.version !== current.version ||
      !rememberWorkSelection(() => window.sessionStorage, key, choice)) return false
    const same = saved.choice?.missionId === choice.missionId &&
      saved.choice.taskId === choice.taskId && saved.choice.runId === choice.runId
    if (!same) setSaved({ generation, version: ++current.version, choice })
    return true
  }, [generation, key, saved])
  return {
    selection: saved?.generation === generation ? saved.choice : UNAVAILABLE_WORK_SELECTION,
    remember,
  }
}
