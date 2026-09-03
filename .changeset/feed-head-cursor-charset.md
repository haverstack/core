---
'@haverstack/adapter-api': patch
---

Discard a `ready` frame `seq` that falls outside the framable base64url charset, as frame ids already are. Echoing one into `Last-Event-ID` on the reconnect after a `reset` had `fetch` refuse every attempt, wedging a feed that could have resumed from the present.
