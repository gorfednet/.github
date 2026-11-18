// /api/event: the analytics event endpoint, same origin as the page.
import { proxyEvent } from '../../shared/plausible.js'

export const onRequest = proxyEvent
