import { pgTable, text, timestamp, uuid, varchar, boolean, jsonb, integer, numeric, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './orgs';

/**
 * Suppliers — abstracted upstream vendors (SanMar, S&S, Blue Generation, etc.)
 * Per Vol IV: "Supplier names, SKUs, pricing, and internal identifiers remain hidden
 * from customers. Public product records are owned exclusively by One Stop Uniforms."
 *
 * We store supplier metadata internally but never expose it to org_admin/buyer roles
 * beyond the supplier code (e.g. "Supplier A") and feed connection status.
 */
export const suppliers = pgTable(
  'suppliers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Internal-only naming (never exposed in public APIs)
    code: varchar('code', { length: 40 }).notNull().unique(), // e.g. 'SUP-A', 'SUP-B'
    displayName: varchar('display_name', { length: 200 }), // OSUEP staff can name internally
    // Connection metadata
    feedType: varchar('feed_type', { length: 40 }).notNull(), // 'csv_upload', 'api', 'sftp'
    feedConfig: jsonb('feed_config').$type<SupplierFeedConfig>().notNull().default(sql`'{}'::jsonb`),
    status: varchar('status', { length: 20 }).notNull().default('active'),
    // 'active' | 'paused' | 'error' | 'archived'
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastSyncStatus: varchar('last_sync_status', { length: 40 }), // 'success' | 'partial' | 'failed' | null
    lastSyncError: text('last_sync_error'),
    // Counts (cached)
    productCount: integer('product_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    codeIdx: uniqueIndex('suppliers_code_idx').on(t.code),
    statusIdx: index('suppliers_status_idx').on(t.status),
  })
);

export type SupplierFeedConfig = {
  // Either: csv_upload path/url, or api endpoint + auth, or sftp config
  csvUrl?: string;
  apiUrl?: string;
  apiAuth?: { type: 'header' | 'query' | 'basic'; key: string; secretRef: string };
  sftp?: { host: string; user: string; path: string; secretRef: string };
  scheduleCron?: string; // e.g. '0 3 * * *' for daily 3am
};

/**
 * Categories — hierarchical browsing structure.
 * Self-referential parent_id for tree of: Apparel > Polos > Short-sleeve etc.
 */
export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    parentId: uuid('parent_id'),
    slug: varchar('slug', { length: 80 }).notNull().unique(),
    name: varchar('name', { length: 200 }).notNull(),
    description: text('description'),
    // Display
    imageUrl: varchar('image_url', { length: 500 }),
    position: integer('position').notNull().default(0),
    isPublic: boolean('is_public').notNull().default(true), // shown on public store
    // SEO
    seoTitle: varchar('seo_title', { length: 200 }),
    seoDescription: varchar('seo_description', { length: 500 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    parentIdx: index('categories_parent_idx').on(t.parentId),
    slugIdx: uniqueIndex('categories_slug_idx').on(t.slug),
    publicIdx: index('categories_public_idx').on(t.isPublic, t.position),
  })
);

/**
 * Products — PUBLIC catalog records owned by OSUEP.
 * Per spec: "Public product records are owned exclusively by One Stop Uniforms."
 * Customers see this — NEVER the supplier mappings.
 */
export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sku: varchar('sku', { length: 80 }).notNull().unique(), // OSUEP internal SKU
    name: varchar('name', { length: 300 }).notNull(),
    shortDescription: varchar('short_description', { length: 500 }),
    longDescription: text('long_description'),
    // Primary categorization
    categoryId: uuid('category_id'),
    // Brand (publicly shown brand name, e.g. "OSUEP ProWear")
    brand: varchar('brand', { length: 120 }),
    // Visibility & status
    status: varchar('status', { length: 30 }).notNull().default('draft'),
    // 'draft' | 'active' | 'archived' | 'low_stock' | 'discontinued'
    isPublic: boolean('is_public').notNull().default(false),
    // Specs (free-form JSON for material, weight, fit, features)
    specs: jsonb('specs').$type<ProductSpecs>().notNull().default(sql`'{}'::jsonb`),
    // Pricing (list price; buyer orgs will get tiered pricing later)
    listPrice: numeric('list_price', { precision: 12, scale: 2 }).notNull(),
    costBasis: numeric('cost_basis', { precision: 12, scale: 2 }), // OSUEP's cost (not exposed)
    // Embroidery / customization config (per Vol V)
    customizable: boolean('customizable').notNull().default(false),
    customizationConfig: jsonb('customization_config').$type<CustomizationConfig>().notNull().default(sql`'{}'::jsonb`),
    // SEO
    seoTitle: varchar('seo_title', { length: 200 }),
    seoDescription: varchar('seo_description', { length: 500 }),
    // Counts
    viewCount: integer('view_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => ({
    skuIdx: uniqueIndex('products_sku_idx').on(t.sku),
    categoryIdx: index('products_category_idx').on(t.categoryId),
    statusIdx: index('products_status_idx').on(t.status, t.isPublic),
    nameIdx: index('products_name_idx').on(t.name),
  })
);

export type ProductSpecs = {
  material?: string;
  weight?: string;
  fit?: string;
  features?: string[];
  careInstructions?: string;
  // ... freely extended
};

export type CustomizationConfig = {
  methods?: Array<
    | 'embroidery'
    | 'screen_print'
    | 'heat_transfer'
    | 'sublimation'
    | 'woven_label'
  >;
  maxColors?: number;
  maxLocations?: number;
  turnaroundDays?: number;
};

/**
 * Product variants — sizes × colors (the buyable units).
 * A "Polo Shirt" product has variants for {S, M, L, XL} × {navy, white, black}.
 */
export const productVariants = pgTable(
  'product_variants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id').notNull(),
    sku: varchar('sku', { length: 80 }).notNull().unique(),
    size: varchar('size', { length: 40 }),
    color: varchar('color', { length: 80 }),
    colorHex: varchar('color_hex', { length: 7 }), // for swatch display
    // Pricing override (falls back to product.listPrice if null)
    listPrice: numeric('list_price', { precision: 12, scale: 2 }),
    // Stock (cached from supplier feed; null = unknown)
    stockQuantity: integer('stock_quantity'),
    lowStockThreshold: integer('low_stock_threshold').notNull().default(5),
    weightGrams: integer('weight_grams'),
    position: integer('position').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    productIdx: index('product_variants_product_idx').on(t.productId),
    skuIdx: uniqueIndex('product_variants_sku_idx').on(t.sku),
  })
);

/**
 * Product images
 */
export const productImages = pgTable(
  'product_images',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id').notNull(),
    url: varchar('url', { length: 1000 }).notNull(),
    altText: varchar('alt_text', { length: 300 }),
    position: integer('position').notNull().default(0),
    isPrimary: boolean('is_primary').notNull().default(false),
    // Stored in GitHub-backed storage for P0; Cloudflare R2 in P3
    storageRef: varchar('storage_ref', { length: 500 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    productIdx: index('product_images_product_idx').on(t.productId),
    primaryIdx: index('product_images_primary_idx').on(t.productId, t.isPrimary),
  })
);

/**
 * Supplier→Product mappings — INTERNAL ONLY, never exposed to customers.
 * Per Vol IV: "Supplier names, SKUs, pricing, and internal identifiers remain
 * hidden from customers. Public product records are owned exclusively by OSUEP."
 */
export const supplierProductMappings = pgTable(
  'supplier_product_mappings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    supplierId: uuid('supplier_id').notNull(),
    productId: uuid('product_id').notNull(),
    // Supplier's own SKU/code (e.g. SanMar PC61)
    supplierSku: varchar('supplier_sku', { length: 120 }).notNull(),
    // Supplier's name for this item (internal only)
    supplierName: varchar('supplier_name', { length: 300 }),
    // Supplier's cost
    supplierCost: numeric('supplier_cost', { precision: 12, scale: 2 }),
    // Last seen in feed
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    supplierProductIdx: uniqueIndex('supplier_product_uniq').on(t.supplierId, t.productId),
    supplierSkuIdx: uniqueIndex('supplier_sku_uniq').on(t.supplierId, t.supplierSku),
  })
);

/**
 * Supplier feed imports — append-only log of every feed sync for audit + debugging.
 */
export const supplierFeedImports = pgTable(
  'supplier_feed_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    supplierId: uuid('supplier_id').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    status: varchar('status', { length: 20 }).notNull(), // 'running' | 'success' | 'failed' | 'partial'
    rowsProcessed: integer('rows_processed').notNull().default(0),
    rowsCreated: integer('rows_created').notNull().default(0),
    rowsUpdated: integer('rows_updated').notNull().default(0),
    rowsSkipped: integer('rows_skipped').notNull().default(0),
    errorMessage: text('error_message'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    supplierIdx: index('supplier_feed_imports_supplier_idx').on(t.supplierId),
    startedIdx: index('supplier_feed_imports_started_idx').on(t.startedAt),
  })
);

/**
 * Product price rules — per-org overrides, volume discounts, contract pricing.
 * Phase: P1 (basic), expand in P2.
 */
export const productPriceRules = pgTable(
  'product_price_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    productId: uuid('product_id'), // null = applies to all products in this org
    ruleType: varchar('rule_type', { length: 40 }).notNull(),
    // 'volume_break' | 'contract_override' | 'category_markup' | 'flat_discount'
    config: jsonb('config').$type<PriceRuleConfig>().notNull(),
    priority: integer('priority').notNull().default(100),
    isActive: boolean('is_active').notNull().default(true),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index('price_rules_org_idx').on(t.orgId),
    productIdx: index('price_rules_product_idx').on(t.productId),
    activeIdx: index('price_rules_active_idx').on(t.isActive, t.priority),
  })
);

export type PriceRuleConfig =
  | { type: 'volume_break'; tiers: Array<{ minQty: number; percentOff: number }> }
  | { type: 'contract_override'; fixedPrice: number }
  | { type: 'flat_discount'; percentOff: number }
  | { type: 'category_markup'; categoryId: string; percentDelta: number };

/**
 * Product favorites — buyers bookmark items for quick reorder.
 */
export const productFavorites = pgTable(
  'product_favorites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull(),
    userId: uuid('user_id').notNull(),
    productId: uuid('product_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqUserFav: uniqueIndex('product_favorites_uniq').on(t.userId, t.productId),
    orgIdx: index('product_favorites_org_idx').on(t.orgId),
  })
);

export type CatalogTables = {
  suppliers: typeof suppliers;
  categories: typeof categories;
  products: typeof products;
  productVariants: typeof productVariants;
  productImages: typeof productImages;
  supplierProductMappings: typeof supplierProductMappings;
  supplierFeedImports: typeof supplierFeedImports;
  productPriceRules: typeof productPriceRules;
  productFavorites: typeof productFavorites;
};
