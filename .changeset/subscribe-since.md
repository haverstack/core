---
'@haverstack/core': minor
---

`SubscribeOptions` gains `since`, a resume cursor forwarded to the adapter as
`SubscribeChangesOptions.since` — the missing half of resumption. The plumbing on
the adapter side already existed (`APIAdapter.subscribeChanges()` has honored
`since` since it shipped, turning it into `Last-Event-ID`), but nothing on
`Stack.subscribe()` or `ScopedStack.subscribe()` could pass one in. A consumer can
now persist the `seq` off a delivered `RecordChange` and hand it back on the next
`subscribe()` call to resume where it left off, rather than getting every change
from the present onward after every restart.

`since` means something only where a relay exists: a stack with no third party
whose writes could have been missed has no cursor it could ever have minted.
Passing `since` to a stack that relays nothing — including through
`ScopedStack.subscribe()`, which never has a relay of its own — now throws
`StackQueryError` rather than silently starting from the present, which would let
the caller believe it resumed when it did not.

`onReset` can now fire on the very first connection, when `since` names a cursor
the far end will not honor (a `resume: false` server, an expired cursor) — that is
a gap too, and the one an app most needs to hear about.
