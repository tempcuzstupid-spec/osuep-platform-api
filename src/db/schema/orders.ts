import { pgTable, text, timestamp, uuid, varchar, boolean, jsonb, integer, numeric, index, uniqueIndex, pgEnum } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './orgs.js';
import { users } from './users.js';
import { products } from './catalog.js';

/* =============================================================
 *  ENUMS
 * ============================================================= */

export const orderStatusEnum = pgEnum('order_status', [
  'draft',           // being built in cart/checkout
  'pending_approval', // waiting for approver
  'approved',         // approved, ready for production
  'in_production',    // decoration underway
  'ready_to_ship',    // packed, awaiting carrier
  'shipped',          // carrier picked up
  'delivered',        // received
  'cancelled',        // cancelled by buyer/admin
  'on_hold',          // paused
]);

export const cartStatusEnum = pgEnum('cart_status', ['open', 'submitted', 'abandoned', 'converted']);

export const approvalStatusEnum = pgEnum('approval_status', ['pending', 'approved', 'rejected', 'skipped']);

export const invoiceStatusEnum = pgEnum('invoice_status', ['draft', 'issued', 'paid', 'overdue', 'void']);

export const documentTypeEnum = pgEnum('document_type', [
  'invoice',
  'packing_slip',
  'proof',
  'contract',
  'quote',
  'tax_form',
  'other',
]);

/* =============================================================
 *  CART
 * ============================================================= */

export const carts = pgTable(
  'carts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    userId: uuid('user_id').notNull(), // cart owner
    status: cartStatusEnum('status').notNull().default('open'),
    name: varchar('name', { length: 200 }), // "Q4 Procurement for North Campus"
    notes: text('notes'),
    // Approval context
    requiresApproval: boolean('requires_approval').notNull().default(false),
    subtotal: numeric('subtotal', { precision: 12, scale: 2 }).notNull().default('0'),
    total: numeric('total', { precision: 12, scale: 2 }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
  },
  (t) => ({
    orgIdx: index('carts_org_idx').on(t.orgId),
    userIdx: index('carts_user_idx').on(t.userId),
    statusIdx: index('carts_status_idx').on(t.status),
  })
);

export const cartItems = pgTable(
  'cart_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cartId: uuid('cart_id').notNull(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id'),
    // Snapshot of product at time of add (price can change later)
    sku: varchar('sku', { length: 80 }).notNull(),
    productName: varchar('product_name', { length: 300 }).notNull(),
    size: varchar('size', { length: 40 }),
    color: varchar('color', { length: 80 }),
    quantity: integer('quantity').notNull().default(1),
    unitPrice: numeric('unit_price', { precision: 12, scale: 2 }).notNull(),
    // Customization per-line (embroidery location, thread colors, text, etc.)
    customization: jsonb('customization').$type<CartItemCustomization>().notNull().default(sql`'{}'::jsonb`),
    lineNote: text('line_note'),
    // For the assigned-to person (employee uniforms)
    assignedToUserId: uuid('assigned_to_user_id'),
    assignedToName: varchar('assigned_to_name', { length: 200 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    cartIdx: index('cart_items_cart_idx').on(t.cartId),
    productIdx: index('cart_items_product_idx').on(t.productId),
  })
);

export type CartItemCustomization = {
  // Embroidery / decoration
  decorationMethod?: 'embroidery' | 'screen_print' | 'heat_transfer' | 'dtf' | 'dtg' | 'vinyl' | 'patches' | 'engraving';
  decorationLocation?: 'left_chest' | 'right_chest' | 'full_back' | 'left_sleeve' | 'right_sleeve' | 'cuff' | 'hem' | 'cap_front' | 'cap_back' | 'cap_side' | 'other';
  decorationLocationNote?: string;
  // Artwork reference
  artworkId?: string;
  artworkVersion?: number;
  // Thread / print colors
  threadColors?: Array<{ name: string; pantone?: string; hex?: string }>;
  // Personalization
  personalizationText?: string;
  personalizationFont?: string;
  // Production
  setupFeeApplied?: boolean;
  rushRequested?: boolean;
  // Freeform
  notes?: string;
};

/* =============================================================
 *  ORDERS
 * ============================================================= */

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    // Human-readable order number (e.g. OSU-2026-000123)
    orderNumber: varchar('order_number', { length: 40 }).notNull().unique(),
    // Placed by
    placedByUserId: uuid('placed_by_user_id').notNull(),
    // For split orgs — who is the on-site contact
    contactUserId: uuid('contact_user_id'),
    // Status
    status: orderStatusEnum('status').notNull().default('draft'),
    // Optional PO number provided by buyer
    buyerPoNumber: varchar('buyer_po_number', { length: 80 }),
    // Cart-derived fields
    subtotal: numeric('subtotal', { precision: 12, scale: 2 }).notNull().default('0'),
    tax: numeric('tax', { precision: 12, scale: 2 }).notNull().default('0'),
    shipping: numeric('shipping', { precision: 12, scale: 2 }).notNull().default('0'),
    total: numeric('total', { precision: 12, scale: 2 }).notNull().default('0'),
    // Locations
    shipToLocationId: uuid('ship_to_location_id'),
    shipToName: varchar('ship_to_name', { length: 200 }),
    shipToAddress: jsonb('ship_to_address').$type<Address>().notNull().default(sql`'{}'::jsonb`),
    billToLocationId: uuid('bill_to_location_id'),
    billToAddress: jsonb('bill_to_address').$type<Address>().notNull().default(sql`'{}'::jsonb`),
    // Notes
    customerNotes: text('customer_notes'),
    internalNotes: text('internal_notes'),
    // Dates
    placedAt: timestamp('placed_at', { withTimezone: true }),
    expectedAt: timestamp('expected_at', { withTimezone: true }),
    shippedAt: timestamp('shipped_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index('orders_org_idx').on(t.orgId),
    statusIdx: index('orders_status_idx').on(t.status),
    placedByIdx: index('orders_placed_by_idx').on(t.placedByUserId),
    numberIdx: uniqueIndex('orders_number_uniq').on(t.orderNumber),
    placedAtIdx: index('orders_placed_at_idx').on(t.placedAt),
  })
);

export type Address = {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  phone?: string;
  email?: string;
  // Optional location label
  label?: string;
  // Special instructions
  deliveryNotes?: string;
};

export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id').notNull(),
    productId: uuid('product_id'),
    variantId: uuid('variant_id'),
    // Snapshots
    sku: varchar('sku', { length: 80 }).notNull(),
    productName: varchar('product_name', { length: 300 }).notNull(),
    productImage: varchar('product_image', { length: 1000 }),
    size: varchar('size', { length: 40 }),
    color: varchar('color', { length: 80 }),
    quantity: integer('quantity').notNull(),
    unitPrice: numeric('unit_price', { precision: 12, scale: 2 }).notNull(),
    setupFee: numeric('setup_fee', { precision: 12, scale: 2 }).notNull().default('0'),
    lineTotal: numeric('line_total', { precision: 12, scale: 2 }).notNull(),
    customization: jsonb('customization').$type<CartItemCustomization>().notNull().default(sql`'{}'::jsonb`),
    // Production state (per Vol V workflow)
    productionStatus: varchar('production_status', { length: 40 }).notNull().default('pending'),
    // 'pending' | 'artwork_review' | 'digitizing' | 'queued' | 'in_production' | 'qa' | 'packed' | 'shipped'
    assignedDecoratorId: varchar('assigned_decorator_id', { length: 80 }),
    // For the assigned-to person
    assignedToUserId: uuid('assigned_to_user_id'),
    assignedToName: varchar('assigned_to_name', { length: 200 }),
    lineNote: text('line_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orderIdx: index('order_items_order_idx').on(t.orderId),
    productIdx: index('order_items_product_idx').on(t.productId),
    prodStatusIdx: index('order_items_prod_status_idx').on(t.productionStatus),
  })
);

/* =============================================================
 *  ORDER EVENTS — append-only log of state transitions
 * ============================================================= */

export const orderEvents = pgTable(
  'order_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id').notNull(),
    status: varchar('status', { length: 40 }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    actorUserId: uuid('actor_user_id'),
    actorRole: varchar('actor_role', { length: 40 }),
    note: text('note'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    orderIdx: index('order_events_order_idx').on(t.orderId),
    occurredAtIdx: index('order_events_occurred_at_idx').on(t.occurredAt),
  })
);

/* =============================================================
 *  SHIPMENTS
 * ============================================================= */

export const shipments = pgTable(
  'shipments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id').notNull(),
    carrier: varchar('carrier', { length: 40 }),
    trackingNumber: varchar('tracking_number', { length: 200 }),
    serviceLevel: varchar('service_level', { length: 40 }),
    shippedAt: timestamp('shipped_at', { withTimezone: true }),
    estimatedAt: timestamp('estimated_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    status: varchar('status', { length: 40 }).notNull().default('pending'),
    // 'pending' | 'in_transit' | 'out_for_delivery' | 'delivered' | 'exception'
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orderIdx: index('shipments_order_idx').on(t.orderId),
    trackingIdx: index('shipments_tracking_idx').on(t.trackingNumber),
  })
);

/* =============================================================
 *  APPROVALS
 * ============================================================= */

export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id').notNull(),
    approverUserId: uuid('approver_user_id').notNull(),
    status: approvalStatusEnum('status').notNull().default('pending'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    note: text('note'),
    // Order of approval (1 = first, 2 = second, etc.) for multi-level chains
    level: integer('level').notNull().default(1),
    // Threshold-based: this approval was required because order total > $X
    requiredBecause: varchar('required_because', { length: 200 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orderIdx: index('approvals_order_idx').on(t.orderId),
    approverIdx: index('approvals_approver_idx').on(t.approverUserId, t.status),
  })
);

/* =============================================================
 *  INVOICES
 * ============================================================= */

export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceNumber: varchar('invoice_number', { length: 40 }).notNull().unique(),
    orderId: uuid('order_id'),
    orgId: uuid('org_id').notNull(),
    status: invoiceStatusEnum('status').notNull().default('draft'),
    subtotal: numeric('subtotal', { precision: 12, scale: 2 }).notNull(),
    tax: numeric('tax', { precision: 12, scale: 2 }).notNull().default('0'),
    total: numeric('total', { precision: 12, scale: 2 }).notNull(),
    amountPaid: numeric('amount_paid', { precision: 12, scale: 2 }).notNull().default('0'),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    pdfUrl: varchar('pdf_url', { length: 1000 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index('invoices_org_idx').on(t.orgId),
    orderIdx: index('invoices_order_idx').on(t.orderId),
    statusIdx: index('invoices_status_idx').on(t.status),
    numberIdx: uniqueIndex('invoices_number_uniq').on(t.invoiceNumber),
  })
);

export const invoiceLines = pgTable(
  'invoice_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceId: uuid('invoice_id').notNull(),
    description: text('description').notNull(),
    quantity: integer('quantity').notNull(),
    unitPrice: numeric('unit_price', { precision: 12, scale: 2 }).notNull(),
    total: numeric('total', { precision: 12, scale: 2 }).notNull(),
  },
  (t) => ({
    invoiceIdx: index('invoice_lines_invoice_idx').on(t.invoiceId),
  })
);

/* =============================================================
 *  DOCUMENTS (general)
 * ============================================================= */

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    type: documentTypeEnum('type').notNull(),
    title: varchar('title', { length: 300 }).notNull(),
    fileUrl: varchar('file_url', { length: 1000 }),
    storageRef: varchar('storage_ref', { length: 500 }), // github-backed, r2, etc.
    mimeType: varchar('mime_type', { length: 100 }),
    fileSize: integer('file_size'),
    // Polymorphic relation
    relatedToType: varchar('related_to_type', { length: 40 }),
    relatedToId: uuid('related_to_id'),
    // Who uploaded
    uploadedByUserId: uuid('uploaded_by_user_id'),
    // Soft delete
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index('documents_org_idx').on(t.orgId),
    typeIdx: index('documents_type_idx').on(t.type),
    relatedIdx: index('documents_related_idx').on(t.relatedToType, t.relatedToId),
  })
);

/* =============================================================
 *  ARTWORK
 * ============================================================= */

export const artworkStatusEnum = pgEnum('artwork_status', [
  'draft',
  'pending_review',
  'approved',
  'rejected',
  'archived',
]);

export const artworks = pgTable(
  'artworks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    description: text('description'),
    status: artworkStatusEnum('status').notNull().default('draft'),
    // Current approved version
    currentVersion: integer('current_version').notNull().default(1),
    // Production notes
    notes: text('notes'),
    uploadedByUserId: uuid('uploaded_by_user_id').notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedByUserId: uuid('approved_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index('artworks_org_idx').on(t.orgId),
    statusIdx: index('artworks_status_idx').on(t.status),
  })
);

export const artworkVersions = pgTable(
  'artwork_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    artworkId: uuid('artwork_id').notNull(),
    version: integer('version').notNull(),
    fileUrl: varchar('file_url', { length: 1000 }).notNull(),
    storageRef: varchar('storage_ref', { length: 500 }),
    mimeType: varchar('mime_type', { length: 100 }).notNull(),
    fileSize: integer('file_size'),
    // Color profile
    colorProfile: varchar('color_profile', { length: 80 }),
    notes: text('notes'),
    uploadedByUserId: uuid('uploaded_by_user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    artworkIdx: index('artwork_versions_artwork_idx').on(t.artworkId),
    uniq: uniqueIndex('artwork_versions_uniq').on(t.artworkId, t.version),
  })
);

/* =============================================================
 *  MESSAGES (org ↔ OSUEP)
 * ============================================================= */

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    threadId: uuid('thread_id').notNull(), // groups related messages
    fromUserId: uuid('from_user_id'),
    isFromOsuep: boolean('is_from_osuep').notNull().default(false),
    body: text('body').notNull(),
    // Polymorphic
    relatedToType: varchar('related_to_type', { length: 40 }),
    relatedToId: uuid('related_to_id'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index('messages_org_idx').on(t.orgId),
    threadIdx: index('messages_thread_idx').on(t.threadId),
  })
);

/* =============================================================
 *  LOCATIONS & DEPARTMENTS (extend existing tables)
 *  Note: already in orgs.ts — just reference for clarity
 * ============================================================= */
// locations, departments already defined in orgs.ts

/* =============================================================
 *  NOTIFICATIONS
 * ============================================================= */

export const notificationKindEnum = pgEnum('notification_kind', [
  'order_placed',
  'order_approved',
  'order_rejected',
  'order_shipped',
  'order_delivered',
  'approval_required',
  'invoice_issued',
  'invoice_overdue',
  'message_received',
  'system',
]);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    userId: uuid('user_id').notNull(),
    kind: notificationKindEnum('kind').notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    body: text('body'),
    href: varchar('href', { length: 1000 }),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('notifications_user_idx').on(t.userId, t.readAt),
    orgIdx: index('notifications_org_idx').on(t.orgId),
  })
);
