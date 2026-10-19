---
'@haverstack/adapter-api': minor
---

Read the server URL's parsed scheme: `https:` is required unless the host is loopback or `allowInsecure` is set, however the scheme is spelled, and a URL that is not `http(s)` at all is refused before anything is sent.
