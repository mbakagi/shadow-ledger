# St3s — Dual-Location Inventory Tracker

A lightweight, responsive web application for tracking stock across a **Main Depot** and a **Company Building**.

## Features

- 📊 Dashboard with carrier & procurement alerts
- 📋 Searchable, sortable inventory table with inline editing
- ✏️ Quick ±1 buttons and keyboard-friendly number inputs
- 🚚 Carrier Manifest generator (print & copy)
- 📥 Multi-format import: CSV, Excel (.xlsx), JSON, TSV
- 📤 CSV export
- 🌓 Dark/Light mode toggle
- 📱 Mobile-first responsive design
- 💾 LocalStorage persistence (DB-ready architecture)

## Core Logic

```
Depot Stock = Total Stock (BS Comm) - Building Stock (on-hand)
Carrier Alert → Building Stock ≤ Carrier Trigger → 🔴 RED
Procurement Alert → Total Stock ≤ Purchasing Trigger → 🟡 YELLOW
```

## Quick Start

Open `index.html` in any browser, or serve locally:

```bash
npx serve . -l 3000
```
