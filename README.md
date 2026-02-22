# Tick Tock Inc. — ERP · Inventory Module

Wholesale distributor ERP for watch & accessories inventory management.

## Stack
- **Database**: PostgreSQL (`ticktock`)
- **API**: Node.js + Express on `http://localhost:3001`
- **Frontend**: Single HTML file (`web/inventory.html`) — no build step

## Project Structure
```
ticktock/
  db/migrations/001_inventory.sql   # Schema + seed data
  api/
    package.json
    .env                            # DATABASE_URL, PORT
    src/server.js                   # Express API
  web/inventory.html                # ERP dashboard
  README.md
```

## Quick Start

### 1. Database
```bash
createdb ticktock
psql ticktock < db/migrations/001_inventory.sql
```

### 2. API
```bash
cd api
npm install
npm start
```

### 3. Frontend
Open `web/inventory.html` in any browser. The dashboard falls back to mock data if the API is offline.

## API Endpoints
| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Health check + DB ping |
| GET | /api/items | All items |
| GET | /api/items/:id | Single item |
| POST | /api/items | Create item |
| PATCH | /api/items/:id | Update item |
| GET | /api/warehouses | All warehouses |
| GET | /api/stock | All stock availability |
| GET | /api/stock/dashboard | Summary stats |
| GET | /api/stock/reorder-alerts | Items below reorder point |
| GET | /api/stock/:itemId/availability | Per-warehouse availability |
| GET | /api/stock/:itemId/history | Movement history |
| GET | /api/adjustments | All adjustments |
| POST | /api/adjustments | Create draft adjustment |
| POST | /api/adjustments/:id/post | Post adjustment to stock ledger |

## DB Schema
- `users` — system users (admin / warehouse / sales)
- `warehouses` — storage locations (MAIN, OVERFLOW)
- `items` — product catalog (WCH-001…ACC-001)
- `stock_ledger` — **append-only** movement log
- `stock_reservations` — committed stock
- `stock_adjustments` + `stock_adjustment_lines` — cycle count adjustments
- `audit_log` — **append-only** audit trail

### Views
- `v_stock_on_hand` — SUM(qty) per item per warehouse
- `v_stock_availability` — on_hand / committed / available
- `v_reorder_alerts` — items at or below reorder point
