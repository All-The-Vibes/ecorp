import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { humanPublicationRequest, idlePublicationRequest } from './humanPublicationRequest'
import type { HumanPublicationRequestView } from './humanPublicationRequest'
import type { MissionOriginApi } from './missionOriginContext'
import type { MissionResultDeliverable, MissionResultScope } from './missionResultContext'

export function useHumanPublicationRequest(
  scope: MissionResultScope | null,
  source: MissionResultDeliverable | null,
  api: MissionOriginApi,
  onSaved: () => void,
) {
  const request = useMemo(() => scope && source ? { scope, source, api, onSaved } : null,
    [scope, source, api, onSaved])
  const active = useRef<{
    request: NonNullable<typeof request>
    controller: ReturnType<typeof humanPublicationRequest>
  } | null>(null)
  const [load, setLoad] = useState<{ request: typeof request; view: HumanPublicationRequestView } | null>(null)
  useEffect(() => {
    if (!request) return
    const controller = humanPublicationRequest(request.scope, request.source, request.api,
      (view) => setLoad({ request, view }), request.onSaved)
    const current = { request, controller }
    active.current = current
    return () => {
      controller.dispose()
      if (active.current === current) active.current = null
    }
  }, [request])
  const preview = useCallback(() => {
    if (active.current?.request === request) active.current.controller.preview()
  }, [request])
  const submit = useCallback(() => {
    if (active.current?.request === request) active.current.controller.submit()
  }, [request])
  return { view: load?.request === request ? load.view : idlePublicationRequest, preview, submit }
}
