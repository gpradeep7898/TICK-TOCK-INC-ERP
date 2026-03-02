'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const cors    = require('cors');
const path    = require('path');

// ─── Config & DB ─────────────────────────────────────────────────────────────
const { PORT, APP_VERSION } = require('./config/env');
const { query } = require('./db/pool');
const SERVER_START = Date.now();

// ─── Middleware ───────────────────────────────────────────────────────────────
const { requireAuth }                   = require('./middleware/auth');
const { errorHandler, notFoundHandler } = require('./middleware/error');
const { apiLimiter, writeLimiter }      = require('./middleware/rateLimiter');

// ─── Route modules ────────────────────────────────────────────────────────────
const authRouter        = require('./routes/auth.routes');
const itemsRouter       = require('./routes/items.routes');
const stockRouter       = require('./routes/stock.routes');
const adjustmentsRouter = require('./routes/adjustments.routes');
const salesRouter       = require('./routes/sales.routes');
const purchasingRouter  = require('./routes/purchasing.routes');
const pricingRouter     = require('./routes/pricing.routes');
const taxRouter         = require('./routes/tax.routes');
const backupRouter      = require('./routes/backup.routes');
const migrationRouter   = require('./routes/migration.routes');
const printRouter       = require('./routes/print.routes');
const financialsRouter  = require('./routes/financials.routes');
const dashboardRouter   = require('./routes/dashboard.routes');
const companiesRouter   = require('./modules/companies/companies.routes');
const reportsRouter     = require('./routes/reports.routes');
const transfersRouter   = require('./routes/transfers.routes');
const pickListsRouter   = require('./routes/picklists.routes');
const shippingRouter    = require('./routes/shipping.routes');
const glRouter          = require('./routes/gl.routes');
const demandRouter      = require('./routes/demand.routes');
const crmRouter         = require('./routes/crm.routes');
const adminRouter       = require('./routes/admin.routes');

// ─── App setup ────────────────────────────────────────────────────────────────
const app = express();

app.use(cors());
app.use(express.json());

// Request logger
app.use((req, _res, next) => {
    console.log(`${new Date().toISOString()}  ${req.method}  ${req.path}`);
    next();
});

// ─── Static pages ─────────────────────────────────────────────────────────────
const WEB_DIR = path.join(__dirname, '..', '..', 'web');
app.use(express.static(WEB_DIR));
app.get('/',            (_req, res) => res.sendFile(path.join(WEB_DIR, 'inventory.html')));
app.get('/sales',       (_req, res) => res.sendFile(path.join(WEB_DIR, 'sales.html')));
app.get('/purchasing',  (_req, res) => res.sendFile(path.join(WEB_DIR, 'purchasing.html')));
app.get('/financials',  (_req, res) => res.sendFile(path.join(WEB_DIR, 'financials.html')));
app.get('/login',       (_req, res) => res.sendFile(path.join(WEB_DIR, 'login.html')));

// ─── Public health (no auth) ──────────────────────────────────────────────────
async function healthHandler(_req, res) {
    try {
        await query('SELECT 1');
        res.json({ status: 'ok', db: 'connected', version: APP_VERSION,
                   uptime: Math.floor((Date.now() - SERVER_START) / 1000),
                   ts: new Date().toISOString() });
    } catch (err) { res.status(503).json({ status: 'error', message: err.message }); }
}
app.get('/health',     healthHandler);
app.get('/api/health', async (_req, res) => {
    try {
        await query('SELECT 1');
        res.json({ success: true, data: { status: 'ok', db: 'connected', version: APP_VERSION,
                   uptime: Math.floor((Date.now() - SERVER_START) / 1000),
                   ts: new Date().toISOString() } });
    } catch (err) { res.status(503).json({ success: false, error: err.message }); }
});

// ─── Rate limit all /api/* routes ─────────────────────────────────────────────
app.use('/api', apiLimiter);

// ─── Auth routes (public) ────────────────────────────────────────────────────
app.use('/api/auth', authRouter);

// ─── Global auth gate — all /api/* routes below require a valid JWT ──────────
app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/auth/') || req.path === '/health') return next();
    requireAuth(req, res, next);
});

// ─── Write rate limit — POST/PUT/PATCH/DELETE on authenticated routes ─────────
app.use('/api', (req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        return writeLimiter(req, res, next);
    }
    next();
});

// ─── Protected API routes ────────────────────────────────────────────────────
app.use('/api/companies',           companiesRouter);
app.use('/api/items',               itemsRouter);
app.use('/api',                     stockRouter);       // /api/warehouses + /api/stock/*
app.use('/api/adjustments',         adjustmentsRouter);
app.use('/api',                     salesRouter);       // /api/customers /api/sales-orders /api/shipments /api/invoices /api/payments /api/ar-aging
app.use('/api',                     purchasingRouter);  // /api/vendors /api/purchase-orders /api/receipts /api/vendor-invoices /api/vendor-payments /api/ap-aging /api/reorder-suggestions
app.use('/api/pricing',             pricingRouter);
app.use('/api/tax',                 taxRouter);
app.use('/api/backup',              backupRouter);
app.use('/api/migration',           migrationRouter);
app.use('/api/print',               printRouter);
app.use('/api/financials',          financialsRouter);
app.use('/api/dashboard',           dashboardRouter);
app.use('/api/reports',             reportsRouter);
app.use('/api/transfers',           transfersRouter);
app.use('/api/picklists',           pickListsRouter);
app.use('/api/shipping',            shippingRouter);
app.use('/api/gl',                  glRouter);
app.use('/api/demand',              demandRouter);
app.use('/api/crm',                 crmRouter);
app.use('/api/admin',               adminRouter);

// ─── Error handling ───────────────────────────────────────────────────────────
app.use(errorHandler);
app.use(notFoundHandler);

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n  Tick Tock Inc. API`);
    console.log(`  ─────────────────────────────`);
    console.log(`  Listening on http://localhost:${PORT}`);
    console.log(`  DB: ${process.env.DATABASE_URL}\n`);
});
