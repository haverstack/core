---
'@haverstack/core': minor
---

Hold every aspect write (`setParent`, `setUnlisted`, `editAssociations`, `setAssociations`, `editAccess`, `setAccess`) to the version `Stack` read. A soft delete landing between the read and the write is now refused with `409` instead of writing to the tombstone, and a concurrent content patch causes a retry. Over `APIAdapter` these writes now always send `If-Match`.
