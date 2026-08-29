---
'@haverstack/adapter-api': patch
---

Stop the change-feed client reconnecting against a refusal that will repeat.

`isFatalFeedError` ended the reconnect loop only for an unrenewable
credential (401) and an authorization refusal (403). Every other refusal the
server faulted the request for — a malformed cursor or filter answered
`400 bad_request`, say — was treated as transient, so `subscribeChanges()`
retried it with backoff indefinitely, settling into an attempt roughly every
15 seconds and reporting the same error to `onError` each time. The
subscriber was never told to stop, and `onReset` never fired, so the
application had nothing to reconcile from either.

The predicate now decides on the wire status: a `4xx` ends the loop, since
the reconnect sends the same request and would be refused the same way. A
`5xx` still reconnects, which is what keeps `timeout` — the answer a server
gives while shedding query load — from turning a busy server into a
permanently dead subscription.
