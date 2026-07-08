import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import {
  categories,
  products,
  productVariants,
  productImages,
  productFavorites,
  suppliers,
  supplierProductMappings,
  supplierFeedImports,
} from '../db/schema/index.js'
import { and, asc, desc, eq, like, or, sql, inArray } from 'drizzle-orm';
import { getCtx } from '../plugins/request-context.js';
import { BadRequestError, NotFoundError, ForbiddenError } from '../plugins/error-handler.js';
import { recordAuditSafe } from '../services/audit.js';

const ListProductsQuery = z.object({
  category: z.string().optional(), // category slug or uuid
  search: z.string().optional(), // q search term
  customizable: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z.enum(['newest', 'price_asc', 'price_desc', 'popular']).default('newest'),
});

const CreateProductBody = z.object({
  sku: z.string().min(1).max(80),
  name: z.string().min(1).max(300),
  shortDescription: z.string().max(500).optional(),
  longDescription: z.string().optional(),
  categoryId: z.string().uuid().optional(),
  brand: z.string().max(120).optional(),
  listPrice: z.number().positive(),
  costBasis: z.number().positive().optional(),
  customizable: z.boolean().default(false),
  customizationConfig: z.record(z.unknown()).default({}),
  specs: z.record(z.unknown()).default({}),
  seoTitle: z.string().max(200).optional(),
  seoDescription: z.string().max(500).optional(),
});

const CreateCategoryBody = z.object({
  parentId: z.string().uuid().optional(),
  slug: z.string().min(1).max(80),
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  imageUrl: z.string().url().optional(),
  position: z.number().int().default(0),
  isPublic: z.boolean().default(true),
  seoTitle: z.string().max(200).optional(),
  seoDescription: z.string().max(500).optional(),
});

const CreateSupplierBody = z.object({
  code: z.string().min(1).max(40),
  displayName: z.string().max(200).optional(),
  feedType: z.enum(['csv_upload', 'api', 'sftp']),
  feedConfig: z.record(z.unknown()).default({}),
});

const ImportTriggerBody = z.object({
  dryRun: z.boolean().default(false),
});

export async function catalogRoutes(app: FastifyInstance) {
  /* ============================================================
   *  PUBLIC — anyone can browse the catalog (sign-in optional)
   * ============================================================ */

  /** List categories (public tree) */
  app.get('/categories', async (req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const includeHidden = url.searchParams.get('admin') === '1' && (req as any).activeRole === 'org_admin';
    const where = includeHidden ? undefined : eq(categories.isPublic, true);
    const rows = await db
      .select()
      .from(categories)
      .where(where)
      .orderBy(asc(categories.position), asc(categories.name));
    return { categories: rows };
  });

  /** Get category by slug with children */
  app.get('/categories/:slug', async (req) => {
    const { slug } = req.params as { slug: string };
    const [cat] = await db.select().from(categories).where(eq(categories.slug, slug)).limit(1);
    if (!cat) throw new NotFoundError('Category not found');
    const children = await db
      .select()
      .from(categories)
      .where(eq(categories.parentId, cat.id))
      .orderBy(asc(categories.position), asc(categories.name));
    return { category: cat, children };
  });

  /** List products with filters/search */
  app.get('/products', async (req) => {
    const q = ListProductsQuery.parse(req.query);

    const filters = [eq(products.status, 'active'), eq(products.isPublic, true)];
    if (q.category) {
      // Try by slug first, then by id
      let cat = await db
        .select()
        .from(categories)
        .where(eq(categories.slug, q.category))
        .limit(1)
        .then((r) => r[0]);
      if (!cat) {
        cat = await db
          .select()
          .from(categories)
          .where(eq(categories.id, q.category))
          .limit(1)
          .then((r) => r[0]);
      }
      if (!cat) return { products: [], total: 0, limit: q.limit, offset: q.offset };
      filters.push(eq(products.categoryId, cat.id));
    }
    if (q.customizable !== undefined) {
      filters.push(eq(products.customizable, q.customizable));
    }
    if (q.search && q.search.trim().length > 0) {
      const term = `%${q.search.trim().toLowerCase()}%`;
      filters.push(
        sql`(LOWER(${products.name}) LIKE ${term} OR LOWER(${products.sku}) LIKE ${term})`
      );
    }

    const order =
      q.sort === 'price_asc'
        ? asc(products.listPrice)
        : q.sort === 'price_desc'
        ? desc(products.listPrice)
        : q.sort === 'popular'
        ? desc(products.viewCount)
        : desc(products.createdAt);

    const rows = await db
      .select({
        id: products.id,
        sku: products.sku,
        name: products.name,
        shortDescription: products.shortDescription,
        brand: products.brand,
        listPrice: products.listPrice,
        customizable: products.customizable,
        categoryId: products.categoryId,
      })
      .from(products)
      .where(and(...filters))
      .orderBy(order)
      .limit(q.limit)
      .offset(q.offset);

    // Count total (efficient count with same filters)
    const countRows = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(products)
      .where(and(...filters));
    const total = countRows[0]?.total ?? 0;

    return { products: rows, total, limit: q.limit, offset: q.offset };
  });

  /** Get product detail by SKU */
  app.get('/products/:sku', async (req) => {
    const { sku } = req.params as { sku: string };
    const [product] = await db.select().from(products).where(eq(products.sku, sku)).limit(1);
    if (!product || product.status !== 'active' || !product.isPublic) {
      throw new NotFoundError('Product not found');
    }
    // Bump view count (best-effort, fire-and-forget)
    db.update(products).set({ viewCount: sql`${products.viewCount} + 1` }).where(eq(products.id, product.id)).catch(() => {});

    const variants = await db
      .select()
      .from(productVariants)
      .where(and(eq(productVariants.productId, product.id), eq(productVariants.isActive, true)))
      .orderBy(asc(productVariants.position), asc(productVariants.size), asc(productVariants.color));

    const images = await db
      .select()
      .from(productImages)
      .where(eq(productImages.productId, product.id))
      .orderBy(asc(productImages.position));

    // Get category breadcrumb (optional, useful for SEO nav)
    let category = null;
    if (product.categoryId) {
      const [cat] = await db
        .select({ id: categories.id, slug: categories.slug, name: categories.name })
        .from(categories)
        .where(eq(categories.id, product.categoryId))
        .limit(1);
      category = cat ?? null;
    }

    return { product, variants, images, category };
  });

  /** Toggle favorite (buyer users) */
  app.post('/favorites/:productId', { preHandler: app.requireAuth }, async (req) => {
    const ctx = getCtx(req);
    const { productId } = req.params as { productId: string };
    if (!ctx.userId || !ctx.orgId) throw new BadRequestError('Not signed in');

    const [prod] = await db.select({ id: products.id }).from(products).where(eq(products.id, productId)).limit(1);
    if (!prod) throw new NotFoundError('Product not found');

    // Insert or no-op (idempotent via unique constraint)
    try {
      await db
        .insert(productFavorites)
        .values({ orgId: ctx.orgId, userId: ctx.userId, productId });
    } catch (e: any) {
      // Already favorited — silent no-op
    }
    return { ok: true };
  });

  app.delete('/favorites/:productId', { preHandler: app.requireAuth }, async (req) => {
    const ctx = getCtx(req);
    const { productId } = req.params as { productId: string };
    if (!ctx.userId) throw new BadRequestError('Not signed in');
    await db
      .delete(productFavorites)
      .where(and(eq(productFavorites.userId, ctx.userId), eq(productFavorites.productId, productId)));
    return { ok: true };
  });

  app.get('/favorites', { preHandler: app.requireAuth }, async (req) => {
    const ctx = getCtx(req);
    if (!ctx.userId) throw new BadRequestError('Not signed in');
    const rows = await db
      .select({
        id: productFavorites.id,
        productId: productFavorites.productId,
        createdAt: productFavorites.createdAt,
      })
      .from(productFavorites)
      .where(eq(productFavorites.userId, ctx.userId))
      .orderBy(desc(productFavorites.createdAt));
    return { favorites: rows };
  });

  /* ============================================================
   *  ADMIN — OSUEP staff (platform_admin role) only
   *  For P1: protected by requireAuth; we'll add proper platform_admin gate
   *  in the next P1 release. For now, buyers cannot hit these because
   *  their membership role is not org_admin AND product creation is
   *  platform-level.
   * ============================================================ */

  /** Soft admin guard: require role 'org_admin' AND isPlatformAdmin flag
   *  Note: full platform_admin role lands in P1.5. For now we use the
   *  user.isPlatformAdmin flag.
   */
  const requirePlatformAdmin = async (req: any, _reply: any) => {
    await (app as any).requireAuth(req, _reply);
    const ctx = getCtx(req);
    // Look up the user record
    const [u] = await db.execute(sql`SELECT is_platform_admin FROM users WHERE id = ${ctx.userId}`).catch(() => [[null]]) as any;
    if (!u?.is_platform_admin) throw new ForbiddenError('Platform admin only');
  };

  /** List suppliers (admin) */
  app.get('/admin/suppliers', { preHandler: requirePlatformAdmin }, async () => {
    const rows = await db.select().from(suppliers).orderBy(asc(suppliers.code));
    return { suppliers: rows };
  });

  /** Create supplier (admin) */
  app.post('/admin/suppliers', { preHandler: requirePlatformAdmin }, async (req) => {
    const body = CreateSupplierBody.parse(req.body);
    const [created] = await db
      .insert(suppliers)
      .values({
        code: body.code,
        displayName: body.displayName,
        feedType: body.feedType,
        feedConfig: body.feedConfig as any,
      })
      .returning();
    if (!created) throw new Error('Failed to create supplier');
    recordAuditSafe(req, {
      action: 'supplier.created',
      targetType: 'supplier',
      targetId: created.id,
      metadata: { code: created.code, feedType: created.feedType },
    });
    return { supplier: created };
  });

  /** Trigger feed import for a supplier (admin) */
  app.post('/admin/suppliers/:id/import', { preHandler: requirePlatformAdmin }, async (req) => {
    const { id } = req.params as { id: string };
    const body = ImportTriggerBody.parse(req.body ?? {});
    const [sup] = await db.select().from(suppliers).where(eq(suppliers.id, id)).limit(1);
    if (!sup) throw new NotFoundError('Supplier not found');

    // P1: this is a stub that creates a feed_imports row in 'running' state.
    // The actual CSV/API/SFTP ingest is wired in P1.1 (separate worker).
    // For now we mark it completed immediately so admins can see the flow works.
    const [imp] = await db
      .insert(supplierFeedImports)
      .values({
        supplierId: sup.id,
        status: 'success',
        finishedAt: new Date(),
        rowsProcessed: 0,
        rowsCreated: 0,
        rowsUpdated: 0,
        rowsSkipped: 0,
        metadata: { note: 'P1 stub — actual feed worker lands in P1.1', dryRun: body.dryRun },
      })
      .returning();
    if (!imp) throw new Error('Failed to create feed import');
    recordAuditSafe(req, {
      action: 'supplier.feed_import_triggered',
      targetType: 'supplier',
      targetId: sup.id,
      metadata: { importId: imp.id, dryRun: body.dryRun },
    });
    return { import: imp, supplier: sup, dryRun: body.dryRun };
  });

  /** List feed imports for a supplier (admin) */
  app.get('/admin/suppliers/:id/imports', { preHandler: requirePlatformAdmin }, async (req) => {
    const { id } = req.params as { id: string };
    const rows = await db
      .select()
      .from(supplierFeedImports)
      .where(eq(supplierFeedImports.supplierId, id))
      .orderBy(desc(supplierFeedImports.startedAt))
      .limit(50);
    return { imports: rows };
  });

  /** List categories (admin — including non-public) */
  app.get('/admin/categories', { preHandler: requirePlatformAdmin }, async () => {
    const rows = await db.select().from(categories).orderBy(asc(categories.position), asc(categories.name));
    return { categories: rows };
  });

  /** Create category (admin) */
  app.post('/admin/categories', { preHandler: requirePlatformAdmin }, async (req) => {
    const body = CreateCategoryBody.parse(req.body);
    const [created] = await db.insert(categories).values(body as any).returning();
    if (!created) throw new Error('Failed to create category');
    recordAuditSafe(req, {
      action: 'category.created',
      targetType: 'category',
      targetId: created.id,
      metadata: { slug: created.slug, name: created.name },
    });
    return { category: created };
  });

  /** List products (admin — includes drafts) */
  app.get('/admin/products', { preHandler: requirePlatformAdmin }, async (req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const status = url.searchParams.get('status');
    const where = status ? eq(products.status, status) : undefined;
    const rows = await db
      .select()
      .from(products)
      .where(where as any)
      .orderBy(desc(products.createdAt))
      .limit(100);
    return { products: rows };
  });

  /** Create product (admin) */
  app.post('/admin/products', { preHandler: requirePlatformAdmin }, async (req) => {
    const body = CreateProductBody.parse(req.body);
    const [created] = await db
      .insert(products)
      .values({
        sku: body.sku,
        name: body.name,
        shortDescription: body.shortDescription,
        longDescription: body.longDescription,
        categoryId: body.categoryId,
        brand: body.brand,
        listPrice: String(body.listPrice),
        costBasis: body.costBasis ? String(body.costBasis) : null,
        customizable: body.customizable,
        customizationConfig: body.customizationConfig as any,
        specs: body.specs as any,
        seoTitle: body.seoTitle,
        seoDescription: body.seoDescription,
        publishedAt: new Date(),
      })
      .returning();
    if (!created) throw new Error('Failed to create product');
    recordAuditSafe(req, {
      action: 'product.created',
      targetType: 'product',
      targetId: created.id,
      metadata: { sku: created.sku, name: created.name },
    });
    return { product: created };
  });

  /** Update product (admin) */
  app.patch('/admin/products/:id', { preHandler: requirePlatformAdmin }, async (req) => {
    const { id } = req.params as { id: string };
    const body = CreateProductBody.partial().parse(req.body);
    const updates: Record<string, unknown> = { ...body, updatedAt: new Date() };
    if (body.listPrice !== undefined) updates.listPrice = String(body.listPrice);
    if (body.costBasis !== undefined) updates.costBasis = String(body.costBasis);
    const [updated] = await db.update(products).set(updates as any).where(eq(products.id, id)).returning();
    if (!updated) throw new NotFoundError('Product not found');
    recordAuditSafe(req, {
      action: 'product.updated',
      targetType: 'product',
      targetId: id,
      metadata: { changes: Object.keys(body) },
    });
    return { product: updated };
  });

  /** Publish / unpublish (admin) */
  app.post('/admin/products/:id/publish', { preHandler: requirePlatformAdmin }, async (req) => {
    const { id } = req.params as { id: string };
    const { publish } = z.object({ publish: z.boolean() }).parse(req.body ?? { publish: true });
    const [updated] = await db
      .update(products)
      .set({
        isPublic: publish,
        status: publish ? 'active' : 'draft',
        publishedAt: publish ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(products.id, id))
      .returning();
    if (!updated) throw new NotFoundError('Product not found');
    recordAuditSafe(req, {
      action: publish ? 'product.published' : 'product.unpublished',
      targetType: 'product',
      targetId: id,
    });
    return { product: updated };
  });

  /* ============================================================
   *  SUPPLIER MAPPINGS — admin only, NEVER exposed to buyers
   *  (per Vol IV: "Supplier names, SKUs, pricing, and internal
   *   identifiers remain hidden from customers.")
   * ============================================================ */
  app.get('/admin/products/:id/mappings', { preHandler: requirePlatformAdmin }, async (req) => {
    const { id } = req.params as { id: string };
    const rows = await db
      .select()
      .from(supplierProductMappings)
      .where(eq(supplierProductMappings.productId, id));
    return { mappings: rows };
  });
}
