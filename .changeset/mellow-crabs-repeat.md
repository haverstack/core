---
'@haverstack/core': minor
---

Refuse a record-level `access: 'group'` permission whose `groupId` names a Record outside the `_group` family. Only a `_group` Record carries a roster; without the check, an app modelling its own `member`/`admin` relationship links turned every Record a permission was pointed at into an ACL, and a Record migrated out of `_group` kept resolving after it stopped being a group. Type-level grants already applied this rule — record-level permissions now match. Access that depended on the old behavior stops resolving: point the permission at a real `_group` Record.
