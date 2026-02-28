'use strict';

// lib/schemas.js
// All Zod validation schemas, grouped by domain.
// Import individual schemas in route files as needed.

const { z } = require('zod');

// ── Common primitives ─────────────────────────────────────────────────────────

const UUID      = z.string().uuid();
const Email     = z.string().email().toLowerCase().trim();
const PosNum    = z.coerce.number().nonnegative();
const PosInt    = z.coerce.number().int().nonnegative();

// ── Auth ──────────────────────────────────────────────────────────────────────

const LoginSchema = z.object({
    email:    Email,
    password: z.string().min(1, 'Password is required'),
});

const SwitchCompanySchema = z.object({
    company_id: UUID,
});

// ── Items ─────────────────────────────────────────────────────────────────────

const CreateItemSchema = z.object({
    code:              z.string().trim().min(1),
    name:              z.string().trim().min(1),
    description:       z.string().trim().optional(),
    unit_of_measure:   z.string().trim().default('EA'),
    cost_method:       z.enum(['avg','fifo']).default('avg'),
    standard_cost:     PosNum.default(0),
    sale_price:        PosNum.default(0),
    reorder_point:     PosInt.default(0),
    reorder_qty:       PosInt.default(0),
    lead_time_days:    PosInt.default(0),
    category:          z.string().trim().optional(),
    upc_code:          z.string().trim().optional(),
    weight_lb:         PosNum.optional(),
    country_of_origin: z.string().trim().optional(),
});

const PatchItemSchema = z.object({
    name:              z.string().trim().min(1).optional(),
    description:       z.string().trim().optional(),
    unit_of_measure:   z.string().trim().optional(),
    cost_method:       z.enum(['avg','fifo']).optional(),
    standard_cost:     PosNum.optional(),
    sale_price:        PosNum.optional(),
    reorder_point:     PosInt.optional(),
    reorder_qty:       PosInt.optional(),
    lead_time_days:    PosInt.optional(),
    category:          z.string().trim().optional(),
    is_active:         z.boolean().optional(),
    upc_code:          z.string().trim().optional(),
    weight_lb:         PosNum.optional(),
    country_of_origin: z.string().trim().optional(),
}).refine(d => Object.keys(d).length > 0, { message: 'At least one field required' });

// ── Adjustments ───────────────────────────────────────────────────────────────

const AdjLineSchema = z.object({
    item_id:       UUID,
    qty_actual:    z.coerce.number(),
    cost_per_unit: PosNum.optional(),
    notes:         z.string().trim().optional(),
});

const CreateAdjustmentSchema = z.object({
    warehouse_id:    UUID,
    adjustment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    reason:          z.string().trim().optional(),
    notes:           z.string().trim().optional(),
    lines:           z.array(AdjLineSchema).min(1),
    created_by:      UUID.optional(),
});

// ── Customers ─────────────────────────────────────────────────────────────────

const AddressSchema = z.object({
    line1:  z.string().optional(),
    line2:  z.string().optional(),
    city:   z.string().optional(),
    state:  z.string().optional(),
    zip:    z.string().optional(),
    country:z.string().optional(),
}).optional();

const CreateCustomerSchema = z.object({
    code:                    z.string().trim().min(1),
    name:                    z.string().trim().min(1),
    email:                   Email.optional(),
    phone:                   z.string().trim().optional(),
    billing_address:         AddressSchema,
    shipping_address:        AddressSchema,
    payment_terms_days:      PosInt.default(30),
    credit_limit:            PosNum.default(0),
    currency:                z.string().length(3).default('USD'),
    notes:                   z.string().trim().optional(),
    tax_exempt:              z.boolean().default(false),
    tax_exempt_certificate:  z.string().trim().optional(),
    tax_exempt_expiry:       z.string().optional(),
    state_code:              z.string().length(2).toUpperCase().optional(),
    vip_tier:                z.enum(['standard','silver','gold','platinum']).default('standard'),
});

const PatchCustomerSchema = z.object({
    name:                   z.string().trim().min(1).optional(),
    email:                  Email.optional(),
    phone:                  z.string().trim().optional(),
    billing_address:        AddressSchema,
    shipping_address:       AddressSchema,
    payment_terms_days:     PosInt.optional(),
    credit_limit:           PosNum.optional(),
    currency:               z.string().length(3).optional(),
    notes:                  z.string().trim().optional(),
    is_active:              z.boolean().optional(),
    tax_exempt:             z.boolean().optional(),
    tax_exempt_certificate: z.string().trim().optional(),
    tax_exempt_expiry:      z.string().optional(),
    state_code:             z.string().length(2).toUpperCase().optional(),
    vip_tier:               z.enum(['standard','silver','gold','platinum']).optional(),
}).refine(d => Object.keys(d).filter(k => d[k] !== undefined).length > 0,
    { message: 'At least one field required' });

// ── Sales Orders ──────────────────────────────────────────────────────────────

const SOLineSchema = z.object({
    item_id:      UUID,
    qty_ordered:  z.coerce.number().positive(),
    unit_price:   PosNum.optional(),
    discount_pct: PosNum.max(100).default(0),
    description:  z.string().trim().optional(),
});

const CreateSOSchema = z.object({
    customer_id:          UUID,
    warehouse_id:         UUID,
    price_list_id:        UUID.optional(),
    order_date:           z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    requested_ship_date:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    tax_rate:             PosNum.max(1).default(0),
    notes:                z.string().trim().optional(),
    lines:                z.array(SOLineSchema).min(1),
    created_by:           UUID.optional(),
});

// ── Shipments ─────────────────────────────────────────────────────────────────

const ShipLineSchema = z.object({
    order_line_id: UUID,
    qty_shipped:   z.coerce.number().positive(),
});

const CreateShipmentSchema = z.object({
    sales_order_id:   UUID,
    ship_date:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    carrier:          z.string().trim().optional(),
    tracking_number:  z.string().trim().optional(),
    notes:            z.string().trim().optional(),
    lines:            z.array(ShipLineSchema).min(1),
    created_by:       UUID.optional(),
});

// ── Payments ──────────────────────────────────────────────────────────────────

const PaymentAppSchema = z.object({
    invoice_id:     UUID,
    amount_applied: PosNum,
});

const CreatePaymentSchema = z.object({
    customer_id:      UUID,
    payment_date:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    amount:           z.coerce.number().positive(),
    method:           z.enum(['check','ach','wire','credit_card','cash']).default('check'),
    reference_number: z.string().trim().optional(),
    notes:            z.string().trim().optional(),
    applications:     z.array(PaymentAppSchema).default([]),
});

// ── Vendors ───────────────────────────────────────────────────────────────────

const CreateVendorSchema = z.object({
    code:               z.string().trim().min(1),
    name:               z.string().trim().min(1),
    email:              Email.optional(),
    phone:              z.string().trim().optional(),
    billing_address:    AddressSchema,
    payment_terms_days: PosInt.default(30),
    currency:           z.string().length(3).default('USD'),
    notes:              z.string().trim().optional(),
});

// ── Purchase Orders ───────────────────────────────────────────────────────────

const POLineSchema = z.object({
    item_id:     UUID,
    qty_ordered: z.coerce.number().positive(),
    unit_cost:   PosNum.optional(),
    description: z.string().trim().optional(),
});

const CreatePOSchema = z.object({
    vendor_id:    UUID,
    warehouse_id: UUID,
    order_date:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    expected_date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    notes:        z.string().trim().optional(),
    lines:        z.array(POLineSchema).min(1),
    created_by:   UUID.optional(),
});

// ── Receipts ──────────────────────────────────────────────────────────────────

const RcvLineSchema = z.object({
    purchase_order_line_id: UUID,
    qty_received:           z.coerce.number().positive(),
    actual_cost:            PosNum.optional(),
});

const CreateReceiptSchema = z.object({
    purchase_order_id: UUID,
    receipt_date:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    vendor_ref:        z.string().trim().optional(),
    notes:             z.string().trim().optional(),
    lines:             z.array(RcvLineSchema).min(1),
    created_by:        UUID.optional(),
});

// ── Vendor Invoices ───────────────────────────────────────────────────────────

const CreateVendorInvoiceSchema = z.object({
    vendor_id:             UUID,
    purchase_order_id:     UUID.optional(),
    receipt_id:            UUID.optional(),
    invoice_date:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    subtotal:              z.coerce.number().positive(),
    tax_amount:            PosNum.default(0),
    notes:                 z.string().trim().optional(),
    vendor_invoice_number: z.string().trim().optional(),
});

// ── AP Payments ───────────────────────────────────────────────────────────────

const APPaymentAppSchema = z.object({
    vendor_invoice_id: UUID,
    amount_applied:    PosNum,
});

const CreateAPPaymentSchema = z.object({
    vendor_id:        UUID,
    payment_date:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    amount:           z.coerce.number().positive(),
    method:           z.enum(['check','ach','wire','credit_card','cash']).default('check'),
    reference_number: z.string().trim().optional(),
    notes:            z.string().trim().optional(),
    applications:     z.array(APPaymentAppSchema).default([]),
});

// ── Pricing ───────────────────────────────────────────────────────────────────

const LockPriceSchema = z.object({
    customerId:   UUID,
    itemId:       UUID,
    lockedPrice:  PosNum,
    reason:       z.string().trim().optional(),
    lockedBy:     UUID.optional(),
});

const UnlockPriceSchema = z.object({
    customerId: UUID,
    itemId:     UUID,
});

const UpdateCostSchema = z.object({
    itemId:   UUID,
    newCost:  z.coerce.number().nonnegative(),
    notes:    z.string().trim().optional(),
});

const ConfirmCostSchema = z.object({
    newCost:      z.coerce.number().nonnegative(),
    newSalePrice: PosNum.optional(),
    notes:        z.string().trim().optional(),
    changedBy:    UUID.optional(),
});

// ── Tax ───────────────────────────────────────────────────────────────────────

const UpdateTaxRateSchema = z.object({
    tax_rate:  z.coerce.number().min(0).max(1),
    is_active: z.boolean().optional(),
});

module.exports = {
    // Auth
    LoginSchema, SwitchCompanySchema,
    // Items
    CreateItemSchema, PatchItemSchema,
    // Adjustments
    CreateAdjustmentSchema,
    // Customers
    CreateCustomerSchema, PatchCustomerSchema,
    // Sales
    CreateSOSchema, CreateShipmentSchema, CreatePaymentSchema,
    // Purchasing
    CreateVendorSchema, CreatePOSchema, CreateReceiptSchema,
    CreateVendorInvoiceSchema, CreateAPPaymentSchema,
    // Pricing
    LockPriceSchema, UnlockPriceSchema, UpdateCostSchema, ConfirmCostSchema,
    // Tax
    UpdateTaxRateSchema,
};
