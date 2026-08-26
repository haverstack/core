---
'@haverstack/conformance-fixtures': minor
---

Add change-feed fixtures: `changeFeedFixtures` and `changeFeedSequenceFixtures`, with the `ChangeFeedFixture`, `ChangeFeedSequenceFixture`, `ChangeFeedActivity` and `ChangeFeedFrame` types they are written in. Discovery gains fixtures for a server advertising a feed, including one that neither resumes nor includes records.

A connection is pinned as an ordered stream of frames plus the mutations made while it is open, since most of what the endpoint owes a client is what a *mutation* makes an open connection say. The group covers a frame per kind, `ready` leading every connection, `reset` in place of a partial resume, exact filtering, a record the session cannot read producing no frame, and the purge that carries nothing about the record even when the connection asked for one.
