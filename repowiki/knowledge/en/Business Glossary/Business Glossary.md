---
kind: business_term
name: Business Glossary
category: business_term
scope:
    - '**'
---

### St3s
- Definition：The product name of this inventory tracker application (displayed in the title bar, manifest, and login overlay).
- Aliases：st3s

### Main Depot
- Definition：The fixed internal location id `depot` representing the central warehouse stock; depot stock is derived as Total minus Building (and any other locations).
- Aliases：depot、LOC_DEPOT

### Company Building
- Definition：The fixed internal location id `building` representing on-hand stock at the end-user site; carrier alerts fire when building stock falls below the carrier trigger.
- Aliases：building、LOC_BUILDING

### Carrier Alert
- Definition：A red alert state triggered when an item's building stock drops to or below its `carrierTrigger` threshold, indicating a transfer from Main Depot to the Company Building is needed.
- Aliases：carrier、CARRIER

### Procurement Alert
- Definition：A yellow alert state triggered when an item's total stock (sum across all locations) drops to or below its `purchasingTrigger`, indicating a supplier order should be placed.
- Aliases：procure、ORDER、PURCHASE ALERT

### Carrier Manifest
- Definition：A printable/copyable list generated from all items in Carrier Alert state, showing how many units to bring from Main Depot to Company Building for each SKU.
- Aliases：manifest

### Scan Out
- Definition：The workflow that removes stock from the Company Building by scanning a QR code (via jsQR camera decoding) or entering a SKU, then logs the movement to the `transactions` collection.
- Aliases：scan-out

### BS Comm
- Definition：The legacy ERP system whose exported column names (e.g. 'Total Stock (BS Comm)', 'Building Stock (On-Hand)') are recognized by the import mapper; the README formula equates BS Comm Total with the app's Total Stock.
- Aliases：bs comm

### Archive
- Definition：A soft-delete view mode where items have `archived=true`; archived items are hidden from the default table but can be restored or permanently deleted via bulk actions.
- Aliases：archived
