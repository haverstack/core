---
'@haverstack/core': minor
---

`generateId()` carries into the next millisecond when a millisecond's suffix space is spent, instead of throwing. The suffix opens on a random draw and increments from there, so the room a millisecond has left was itself random — a draw near the top of the range could exhaust it after a single further ID, and minting failed with `IdGenerationOverflowError` while the millisecond looked far from full. The prefix now advances and a fresh suffix is drawn, so IDs stay unique, strictly ascending, and well-formed, and minting never fails for want of room.

`IdGenerationOverflowError` is removed; nothing can throw it.
