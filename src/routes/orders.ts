import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import {
  carts,
  cartItems,
  orders,
  orderItems,
  orderEvents,
  shipments,
  approvals,
  invoices,
  invoiceLines,
  products,
  productVariants,
  documents,
  artworks,
  artworkVersions,
  messages,
  notifications,
  productFavorites,
} from '../db/schema/index.js'
import { and, asc, desc, eq, sql, inArray } from 'drizzle-orm';
import { getCtx } from '../plugins/request-context.js';
import { BadRequestError, NotFoundError, ForbiddenError } from '../plugins/error-handler.js';
import { recordAuditSafe } from '../services/audit.js';

/* =============================================================
 *  CART
 * ============================================================= */

const AddToCartBody = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid().optional(),
  quantity: z.number().int().min(1).max(10000).default(1),
  customization: z.record(z.unknown()).default({}),
  size: z.string().optional(),
  color: z.string().optional(),
  assignedToUserId: z.string().uuid().optional(),
  assignedToName: z.string().optional(),
  lineNote: z.string().optional(),
});

const UpdateCartItemBody = z.object({
  quantity: z.number().int().min(0).max(10000).optional(),
  customization: z.record(z.unknown()).optional(),
  assignedToUserId: z.string().uuid().optional(),
  assignedToName: z.string().optional(),
  lineNote: z.string().optional(),
});

async function getOrCreateOpenCart(orgId: string, userId: string) {
  const [existing] = await db
    .select()
    .from(carts)
    .where(and(eq(carts.orgId, orgId), eq(carts.userId, userId), eq(carts.status, 'open')))
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(carts)
    .values({ orgId, userId, status: 'open' })
    .returning();
  return created!;
}

export async function cartRoutes(app: FastifyInstance) {
  /** Get current open cart with items */
  app.get('/cart', { preHandler: app.requireAuth }, async (req) => {
    const ctx = getCtx(req);
    if (!ctx.userId || !ctx.orgId) throw new BadRequestError('Not signed in');
    const cart = await getOrCreateOpenCart(ctx.orgId, ctx.userId);
    const items = await db
      .select()
      .from(cartItems)
      .where(eq(cartItems.cartId, cart.id))
      .orderBy(asc(cartItems.createdAt));
    return { cart, items };
  });

  /** Add item to cart */
  app.post('/cart/items', { preHandler: app.requireAuth }, async (req) => {
    const ctx = getCtx(req);
    if (!ctx.userId || !ctx.orgId) throw new BadRequestError('Not signed in');
    const body = AddToCartBody.parse(req.body);

    const [product] = await db
      .select()
      .from(products)
      .where(eq(products.id, body.productId))
      .limit(1);
    if (!product) throw new NotFoundError('Product not found');

    const cart = await getOrCreateOpenCart(ctx.orgId, ctx.userId);

    // Snapshot price (could be overridden by variant)
    let unitPrice = product.listPrice;
    let size = body.size;
    let color = body.color;
    let sku = product.sku;
    if (body.variantId) {
      const [variant] = await db
        .select()
        .from(productVariants)
        .where(eq(productVariants.id, body.variantId))
        .limit(1);
      if (variant) {
        unitPrice = variant.listPrice ?? product.listPrice;
        size = size ?? variant.size ?? undefined;
        color = color ?? variant.color ?? undefined;
        sku = variant.sku;
      }
    }

    const [item] = await db
      .insert(cartItems)
      .values({
        cartId: cart.id,
        productId: product.id,
        variantId: body.variantId,
        sku,
        productName: product.name,
        size,
        color,
        quantity: body.quantity,
        unitPrice,
        customization: body.customization as any,
        lineNote: body.lineNote,
        assignedToUserId: body.assignedToUserId,
        assignedToName: body.assignedToName,
      })
      .returning();

    // Recalc totals
    await recalcCart(cart.id);

    recordAuditSafe(req, {
      action: 'cart.item_added',
      targetType: 'product',
      targetId: product.id,
      metadata: { cartId: cart.id, qty: body.quantity },
    });
    return { item };
  });

  /** Update cart item */
  app.patch('/cart/items/:id', { preHandler: app.requireAuth }, async (req) => {
    const ctx = getCtx(req);
    if (!ctx.userId) throw new BadRequestError('Not signed in');
    const { id } = req.params as { id: string };
    const body = UpdateCartItemBody.parse(req.body);

    const [item] = await db.select().from(cartItems).where(eq(cartItems.id, id)).limit(1);
    if (!item) throw new NotFoundError('Item not found');

    const [cart] = await db.select().from(carts).where(eq(carts.id, item.cartId)).limit(1);
    if (!cart || cart.userId !== ctx.userId) throw new ForbiddenError('Not your cart');

    if (body.quantity === 0) {
      await db.delete(cartItems).where(eq(cartItems.id, id));
    } else {
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (body.quantity !== undefined) updates.quantity = body.quantity;
      if (body.customization !== undefined) updates.customization = body.customization as any;
      if (body.assignedToUserId !== undefined) updates.assignedToUserId = body.assignedToUserId;
      if (body.assignedToName !== undefined) updates.assignedToName = body.assignedToName;
      if (body.lineNote !== undefined) updates.lineNote = body.lineNote;
      await db.update(cartItems).set(updates as any).where(eq(cartItems.id, id));
    }
    await recalcCart(cart.id);
    return { ok: true };
  });

  /** Remove cart item */
  app.delete('/cart/items/:id', { preHandler: app.requireAuth }, async (req) => {
    const ctx = getCtx(req);
    if (!ctx.userId) throw new BadRequestError('Not signed in');
    const { id } = req.params as { id: string };
    const [item] = await db.select().from(cartItems).where(eq(cartItems.id, id)).limit(1);
    if (!item) throw new NotFoundError('Item not found');
    const [cart] = await db.select().from(carts).where(eq(carts.id, item.cartId)).limit(1);
    if (!cart || cart.userId !== ctx.userId) throw new ForbiddenError('Not your cart');
    await db.delete(cartItems).where(eq(cartItems.id, id));
    await recalcCart(cart.id);
    return { ok: true };
  });

  /** Clear cart */
  app.delete('/cart', { preHandler: app.requireAuth }, async (req) => {
    const ctx = getCtx(req);
    if (!ctx.userId || !ctx.orgId) throw new BadRequestError('Not signed in');
    const cart = await getOrCreateOpenCart(ctx.orgId, ctx.userId);
    await db.delete(cartItems).where(eq(cartItems.cartId, cart.id));
    await recalcCart(cart.id);
    return { ok: true };
  });
}

async function recalcCart(cartId: string) {
  const items = await db.select().from(cartItems).where(eq(cartItems.cartId, cartId));
  let subtotal = 0;
  for (const it of items) {
    subtotal += parseFloat(it.unitPrice) * it.quantity;
  }
  const subtotalStr = subtotal.toFixed(2);
  await db
    .update(carts)
    .set({ subtotal: subtotalStr, total: subtotalStr, updatedAt: new Date() })
    .where(eq(carts.id, cartId));
}

/* =============================================================
 *  ORDERS
 * ============================================================= */

const CheckoutBody = z.object({
  cartId: z.string().uuid().optional(), // if not provided, uses current open cart
  buyerPoNumber: z.string().max(80).optional(),
  shipToLocationId: z.string().uuid().optional(),
  shipToAddress: z.record(z.unknown()).optional(),
  billToLocationId: z.string().uuid().optional(),
  billToAddress: z.record(z.unknown()).optional(),
  customerNotes: z.string().max(2000).optional(),
});

async function generateOrderNumber(): Promise<string> {
  // Simple format: OSU-YYYY-XXXXXX
  const year = new Date().getFullYear();
  const countRows = await db.execute<{ count: number }>(
    sql`SELECT count(*)::int as count FROM orders WHERE order_number LIKE ${'OSU-' + year + '-%'}`,
  );
  const count = (countRows as any)?.[0]?.count ?? 0;
  const seq = String(count + 1).padStart(6, '0');
  return `OSU-${year}-${seq}`;
}

export async function orderRoutes(app: FastifyInstance) {
  /** List orders for current org */
  app.get('/orders', { preHandler: app.requireAuth }, async (req) => {
    const ctx = getCtx(req);
    if (!ctx.orgId) throw new BadRequestError('Not signed in');
    const url = new URL(req.url, `http://${req.headers.host}`);
    const status = url.searchParams.get('status');
    const where = status
      ? and(eq(orders.orgId, ctx.orgId), eq(orders.status, status as any))
      : eq(orders.orgId, ctx.orgId);
    const rows = await db
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        status: orders.status,
        total: orders.total,
        placedAt: orders.placedAt,
        expectedAt: orders.expectedAt,
        shippedAt: orders.shippedAt,
        itemCount: sql<number>`(SELECT count(*) FROM order_items WHERE order_items.order_id = ${orders.id})::int`,
      })
      .from(orders)
      .where(where as any)
      .orderBy(desc(orders.placedAt))
      .limit(100);
    return { orders: rows };
  });

  /** Public tracking lookup */
  app.get('/track/:orderNumber', async (req) => {
    const { orderNumber } = req.params as { orderNumber: string };
    const [order] = await db
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        status: orders.status,
        expectedAt: orders.expectedAt,
        shippedAt: orders.shippedAt,
        deliveredAt: orders.deliveredAt,
      })
      .from(orders)
      .where(eq(orders.orderNumber, orderNumber))
      .limit(1);
    if (!order) throw new NotFoundError('Order not found');
    const ship = await db.select().from(shipments).where(eq(shipments.orderId, order.id)).limit(1);
    const events = await db
      .select()
      .from(orderEvents)
      .where(eq(orderEvents.orderId, order.id))
      .orderBy(asc(orderEvents.occurredAt));
    return { order, shipment: ship[0] ?? null, events };
  });

  /** Order detail */
  app.get('/orders/:id', { preHandler: app.requireAuth }, async (req) => {
    const ctx = getCtx(req);
    if (!ctx.orgId) throw new BadRequestError('Not signed in');
    const { id } = req.params as { id: string };
    const [order] = await db
      .select()
      .from(orders)
      .where(and(eq(orders.id, id), eq(orders.orgId, ctx.orgId)))
      .limit(1);
    if (!order) throw new NotFoundError('Order not found');
    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    const events = await db
      .select()
      .from(orderEvents)
      .where(eq(orderEvents.orderId, order.id))
      .orderBy(asc(orderEvents.occurredAt));
    const ship = await db.select().from(shipments).where(eq(shipments.orderId, order.id));
    const apv = await db.select().from(approvals).where(eq(approvals.orderId, order.id));
    const inv = await db.select().from(invoices).where(eq(invoices.orderId, order.id));
    return { order, items, events, shipments: ship, approvals: apv, invoices: inv };
  });

  /** Checkout (cart → order) */
  app.post('/orders/checkout', { preHandler: app.requireAuth }, async (req) => {
    const ctx = getCtx(req);
    if (!ctx.userId || !ctx.orgId) throw new BadRequestError('Not signed in');
    const body = CheckoutBody.parse(req.body ?? {});

    // Get cart
    const cart = body.cartId
      ? (await db.select().from(carts).where(eq(carts.id, body.cartId)).limit(1))[0]
      : await getOrCreateOpenCart(ctx.orgId, ctx.userId);
    if (!cart) throw new NotFoundError('Cart not found');
    if (cart.userId !== ctx.userId) throw new ForbiddenError('Not your cart');

    const items = await db.select().from(cartItems).where(eq(cartItems.cartId, cart.id));
    if (items.length === 0) throw new BadRequestError('Cart is empty');

    // Compute totals
    let subtotal = 0;
    for (const it of items) {
      subtotal += parseFloat(it.unitPrice) * it.quantity;
    }
    // Stub tax + shipping (would be address-driven in real life)
    const tax = (subtotal * 0.0825).toFixed(2); // 8.25% sample
    const shipping = subtotal > 500 ? '0' : '24.99';
    const total = (subtotal + parseFloat(tax) + parseFloat(shipping)).toFixed(2);

    const orderNumber = await generateOrderNumber();
    const [order] = await db
      .insert(orders)
      .values({
        orgId: ctx.orgId,
        orderNumber,
        placedByUserId: ctx.userId,
        status: 'pending_approval', // simplified: always require approval for now
        buyerPoNumber: body.buyerPoNumber,
        subtotal: subtotal.toFixed(2),
        tax,
        shipping,
        total,
        shipToLocationId: body.shipToLocationId,
        shipToAddress: (body.shipToAddress as any) ?? { label: 'Default' },
        billToLocationId: body.billToLocationId,
        billToAddress: (body.billToAddress as any) ?? { label: 'Default' },
        customerNotes: body.customerNotes,
        placedAt: new Date(),
      })
      .returning();
    if (!order) throw new Error('Order creation failed');

    // Insert order items (snapshot)
    for (const it of items) {
      const lineTotal = (parseFloat(it.unitPrice) * it.quantity).toFixed(2);
      await db.insert(orderItems).values({
        orderId: order.id,
        productId: it.productId,
        variantId: it.variantId,
        sku: it.sku,
        productName: it.productName,
        size: it.size,
        color: it.color,
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        lineTotal,
        customization: it.customization,
        assignedToUserId: it.assignedToUserId,
        assignedToName: it.assignedToName,
        lineNote: it.lineNote,
      });
    }

    // Add approval entry — assign to org_admin
    const [adminMembership] = await db.execute(
      sql`SELECT user_id FROM memberships WHERE org_id = ${ctx.orgId} AND role = 'org_admin' LIMIT 1`,
    );
    const approverUserId = (adminMembership as any)?.user_id ?? ctx.userId;
    await db.insert(approvals).values({
      orderId: order.id,
      approverUserId,
      level: 1,
      status: 'pending',
      requiredBecause: `Order total $${total} requires org_admin approval`,
    });

    // Add order event
    await db.insert(orderEvents).values({
      orderId: order.id,
      status: 'pending_approval',
      actorUserId: ctx.userId,
      actorRole: 'buyer',
      note: `Order placed by user ${ctx.userId}`,
      metadata: { total, itemCount: items.length },
    });

    // Add notification to approver
    await db.insert(notifications).values({
      orgId: ctx.orgId,
      userId: approverUserId,
      kind: 'approval_required',
      title: `Order ${orderNumber} awaiting your approval`,
      body: `$${total} · ${items.length} line items`,
      href: `/portal/orders/${order.id}`,
    });

    // Mark cart as converted
    await db
      .update(carts)
      .set({ status: 'converted', submittedAt: new Date() })
      .where(eq(carts.id, cart.id));

    recordAuditSafe(req, {
      action: 'order.placed',
      targetType: 'order',
      targetId: order.id,
      orgId: ctx.orgId,
      metadata: { orderNumber, total },
    });
    return { order };
  });

  /** Approve order */
  app.post('/orders/:id/approve', { preHandler: app.requireAuth }, async (req) => {
    const ctx = getCtx(req);
    if (!ctx.userId || !ctx.orgId) throw new BadRequestError('Not signed in');
    const { id } = req.params as { id: string };

    const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
    if (!order) throw new NotFoundError('Order not found');
    if (order.orgId !== ctx.orgId) throw new ForbiddenError('Not your order');

    // Find this user's approval entry
    const [apv] = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.orderId, id), eq(approvals.approverUserId, ctx.userId)))
      .limit(1);
    if (!apv) throw new ForbiddenError('No approval assigned to you');
    if (apv.status !== 'pending') throw new BadRequestError('Already decided');

    await db
      .update(approvals)
      .set({ status: 'approved', decidedAt: new Date() })
      .where(eq(approvals.id, apv.id));

    // Update order status
    await db
      .update(orders)
      .set({ status: 'approved', updatedAt: new Date() })
      .where(eq(orders.id, id));
    await db.insert(orderEvents).values({
      orderId: id,
      status: 'approved',
      actorUserId: ctx.userId,
      actorRole: 'org_admin',
      note: 'Order approved',
    });

    // Notify buyer
    await db.insert(notifications).values({
      orgId: order.orgId,
      userId: order.placedByUserId,
      kind: 'order_approved',
      title: `Order ${order.orderNumber} approved`,
      body: 'Your order has been approved and will move into production.',
      href: `/portal/orders/${order.id}`,
    });

    recordAuditSafe(req, { action: 'order.approved', targetType: 'order', targetId: id, orgId: order.orgId });
    return { ok: true };
  });

  /** Reject order */
  app.post('/orders/:id/reject', { preHandler: app.requireAuth }, async (req) => {
    const ctx = getCtx(req);
    if (!ctx.userId) throw new BadRequestError('Not signed in');
    const { id } = req.params as { id: string };
    const { note } = z.object({ note: z.string().max(1000).optional() }).parse(req.body ?? {});

    const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
    if (!order) throw new NotFoundError('Order not found');
    const [apv] = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.orderId, id), eq(approvals.approverUserId, ctx.userId)))
      .limit(1);
    if (!apv) throw new ForbiddenError('No approval assigned to you');

    await db
      .update(approvals)
      .set({ status: 'rejected', decidedAt: new Date(), note })
      .where(eq(approvals.id, apv.id));
    await db
      .update(orders)
      .set({ status: 'cancelled', cancelledAt: new Date(), updatedAt: new Date() })
      .where(eq(orders.id, id));
    await db.insert(orderEvents).values({
      orderId: id,
      status: 'cancelled',
      actorUserId: ctx.userId,
      actorRole: 'org_admin',
      note: note ?? 'Order rejected',
    });
    await db.insert(notifications).values({
      orgId: order.orgId,
      userId: order.placedByUserId,
      kind: 'order_rejected',
      title: `Order ${order.orderNumber} was rejected`,
      body: note ?? 'See order detail for more.',
      href: `/portal/orders/${order.id}`,
    });
    recordAuditSafe(req, { action: 'order.rejected', targetType: 'order', targetId: id, orgId: order.orgId });
    return { ok: true };
  });

  /** Admin: update order status */
  app.post('/orders/:id/status', { preHandler: app.requireAuth }, async (req) => {
    const ctx = getCtx(req);
    const { id } = req.params as { id: string };
    const { status, note, trackingNumber, carrier } = z
      .object({
        status: z.enum(['approved', 'in_production', 'ready_to_ship', 'shipped', 'delivered', 'cancelled', 'on_hold']),
        note: z.string().max(1000).optional(),
        trackingNumber: z.string().max(200).optional(),
        carrier: z.string().max(40).optional(),
      })
      .parse(req.body);

    const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
    if (!order) throw new NotFoundError('Order not found');

    // Per spec: org_admin can update their order; platform_admin can update any
    const [u] = await db.execute(sql`SELECT is_platform_admin FROM users WHERE id = ${ctx.userId}`).catch(() => [[null]] as any);
    const isPlatformAdmin = (u as any)?.[0]?.is_platform_admin ?? false;
    if (!isPlatformAdmin && order.orgId !== ctx.orgId) throw new ForbiddenError('Not your order');

    const updates: Record<string, unknown> = { status, updatedAt: new Date() };
    if (status === 'shipped') {
      updates.shippedAt = new Date();
      // Ensure shipment record exists
      const existing = await db.select().from(shipments).where(eq(shipments.orderId, id)).limit(1);
      if (existing.length === 0 && trackingNumber) {
        await db.insert(shipments).values({
          orderId: id,
          carrier,
          trackingNumber,
          shippedAt: new Date(),
          status: 'in_transit',
        });
      } else if (existing[0] && trackingNumber) {
        await db
          .update(shipments)
          .set({ trackingNumber, carrier, status: 'in_transit', shippedAt: new Date() })
          .where(eq(shipments.id, existing[0].id));
      }
    }
    if (status === 'delivered') updates.deliveredAt = new Date();
    if (status === 'cancelled') updates.cancelledAt = new Date();
    await db.update(orders).set(updates as any).where(eq(orders.id, id));
    await db.insert(orderEvents).values({
      orderId: id,
      status,
      actorUserId: ctx.userId,
      actorRole: isPlatformAdmin ? 'platform_admin' : 'org_admin',
      note: note ?? `Status changed to ${status}`,
      metadata: trackingNumber ? { trackingNumber, carrier } : {},
    });

    // Notify buyer of major changes
    if (['shipped', 'delivered', 'cancelled'].includes(status)) {
      const kind = status === 'shipped' ? 'order_shipped' : status === 'delivered' ? 'order_delivered' : 'order_rejected';
      await db.insert(notifications).values({
        orgId: order.orgId,
        userId: order.placedByUserId,
        kind: kind as any,
        title: `Order ${order.orderNumber} ${status}`,
        body: status === 'shipped' && trackingNumber ? `Tracking: ${trackingNumber}` : '',
        href: `/portal/orders/${order.id}`,
      });
    }
    return { ok: true };
  });

  /** Admin: list ALL orders across orgs */
  app.get('/admin/orders', { preHandler: app.requireAuth }, async (req) => {
    const ctx = getCtx(req);
    const [u] = await db.execute(sql`SELECT is_platform_admin FROM users WHERE id = ${ctx.userId}`).catch(() => [[null]] as any);
    const isPlatformAdmin = (u as any)?.[0]?.is_platform_admin ?? false;
    if (!isPlatformAdmin) throw new ForbiddenError('Platform admin only');

    const url = new URL(req.url, `http://${req.headers.host}`);
    const status = url.searchParams.get('status');
    const where = status ? eq(orders.status, status as any) : undefined;
    const rows = await db
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        orgId: orders.orgId,
        status: orders.status,
        total: orders.total,
        placedAt: orders.placedAt,
        expectedAt: orders.expectedAt,
        placedByUserId: orders.placedByUserId,
      })
      .from(orders)
      .where(where as any)
      .orderBy(desc(orders.placedAt))
      .limit(200);
    return { orders: rows };
  });
}

/* =============================================================
 *  INVOICES
 * ============================================================= */

export async function invoiceRoutes(app: FastifyInstance) {
  app.get('/invoices', { preHandler: app.requireAuth }, async (req) => {
    const ctx = getCtx(req);
    if (!ctx.orgId) throw new BadRequestError('Not signed in');
    const rows = await db
      .select()
      .from(invoices)
      .where(eq(invoices.orgId, ctx.orgId))
      .orderBy(desc(invoices.issuedAt))
      .limit(100);
    return { invoices: rows };
  });

  app.get('/invoices/:id', { preHandler: app.requireAuth }, async (req) => {
    const ctx = getCtx(req);
    if (!ctx.orgId) throw new BadRequestError('Not signed in');
    const { id } = req.params as { id: string };
    const [inv] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, id), eq(invoices.orgId, ctx.orgId)))
      .limit(1);
    if (!inv) throw new NotFoundError('Invoice not found');
    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, id));
    return { invoice: inv, lines };
  });

  /** Admin: issue invoice from an order */
  app.post('/admin/orders/:orderId/invoice', { preHandler: app.requireAuth }, async (req) => {
    const ctx = getCtx(req);
    const { orderId } = req.params as { orderId: string };
    const [u] = await db.execute(sql`SELECT is_platform_admin FROM users WHERE id = ${ctx.userId}`).catch(() => [[null]] as any);
    const isPlatformAdmin = (u as any)?.[0]?.is_platform_admin ?? false;
    if (!isPlatformAdmin) throw new ForbiddenError('Platform admin only');

    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw new NotFoundError('Order not found');
    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));

    const invCountRows = await db.execute<{ count: number }>(
      sql`SELECT count(*)::int as count FROM invoices WHERE invoice_number LIKE ${'INV-' + new Date().getFullYear() + '-%'}`,
    );
    const invCount = (invCountRows as any)?.[0]?.count ?? 0;
    const invNum = `INV-${new Date().getFullYear()}-${String(invCount + 1).padStart(6, '0')}`;

    const [inv] = await db
      .insert(invoices)
      .values({
        invoiceNumber: invNum,
        orderId: order.id,
        orgId: order.orgId,
        status: 'issued',
        subtotal: order.subtotal,
        tax: order.tax,
        total: order.total,
        issuedAt: new Date(),
        dueAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      })
      .returning();
    if (!inv) throw new Error('Invoice creation failed');
    for (const it of items) {
      await db.insert(invoiceLines).values({
        invoiceId: inv.id,
        description: `${it.productName}${it.size ? ` (${it.size})` : ''}${it.color ? ` — ${it.color}` : ''}`,
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        total: it.lineTotal,
      });
    }
    return { invoice: inv };
  });
}

/* =============================================================
 *  DOCUMENTS
 * ============================================================= */

export async function documentRoutes(app: FastifyInstance) {
  app.get('/documents', { preHandler: app.requireAuth }, async (req) => {
    const ctx = getCtx(req);
    if (!ctx.orgId) throw new BadRequestError('Not signed in');
    const url = new URL(req.url, `http://${req.headers.host}`);
    const type = url.searchParams.get('type');
    const where = type
      ? and(eq(documents.orgId, ctx.orgId), eq(documents.type, type as any))
      : eq(documents.orgId, ctx.orgId);
    const rows = await db
      .select()
      .from(documents)
      .where(where as any)
      .orderBy(desc(documents.createdAt))
      .limit(100);
    return { documents: rows };
  });
}

/* =============================================================
 *  ARTWORK
 * ============================================================= */

export async function artworkRoutes(app: FastifyInstance) {
  app.get('/artworks', { preHandler: app.requireAuth }, async (req) => {
    const ctx = getCtx(req);
    if (!ctx.orgId) throw new BadRequestError('Not signed in');
    const rows = await db
      .select()
      .from(artworks)
      .where(eq(artworks.orgId, ctx.orgId))
      .orderBy(desc(artworks.createdAt))
      .limit(100);
    return { artworks: rows };
  });

  app.post('/artworks', { preHandler: app.requireAuth }, async (req) => {
    const ctx = getCtx(req);
    if (!ctx.userId || !ctx.orgId) throw new BadRequestError('Not signed in');
    const body = z
      .object({
        name: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
        notes: z.string().max(2000).optional(),
      })
      .parse(req.body);
    const [art] = await db
      .insert(artworks)
      .values({
        orgId: ctx.orgId,
        name: body.name,
        description: body.description,
        notes: body.notes,
        uploadedByUserId: ctx.userId,
      })
      .returning();
    return { artwork: art };
  });

  app.post('/artworks/:id/versions', { preHandler: app.requireAuth }, async (req) => {
    const ctx = getCtx(req);
    if (!ctx.userId) throw new BadRequestError('Not signed in');
    const { id } = req.params as { id: string };
    const body = z
      .object({
        fileUrl: z.string().url(),
        mimeType: z.string().max(100),
        fileSize: z.number().int().optional(),
        notes: z.string().max(1000).optional(),
      })
      .parse(req.body);

    const [art] = await db.select().from(artworks).where(eq(artworks.id, id)).limit(1);
    if (!art) throw new NotFoundError('Artwork not found');

    const nextVersion = (await db.select({ v: artworkVersions.version }).from(artworkVersions).where(eq(artworkVersions.artworkId, id)).orderBy(desc(artworkVersions.version)).limit(1))[0]?.v ?? 0;
    const [v] = await db
      .insert(artworkVersions)
      .values({
        artworkId: id,
        version: nextVersion + 1,
        fileUrl: body.fileUrl,
        mimeType: body.mimeType,
        fileSize: body.fileSize,
        notes: body.notes,
        uploadedByUserId: ctx.userId,
      })
      .returning();
    await db
      .update(artworks)
      .set({ currentVersion: nextVersion + 1, status: 'pending_review', updatedAt: new Date() })
      .where(eq(artworks.id, id));
    return { version: v };
  });

  app.post('/artworks/:id/approve', { preHandler: app.requireAuth }, async (req) => {
    const ctx = getCtx(req);
    if (!ctx.userId) throw new BadRequestError('Not signed in');
    const { id } = req.params as { id: string };
    const [art] = await db.select().from(artworks).where(eq(artworks.id, id)).limit(1);
    if (!art) throw new NotFoundError('Artwork not found');
    await db
      .update(artworks)
      .set({
        status: 'approved',
        approvedAt: new Date(),
        approvedByUserId: ctx.userId,
        updatedAt: new Date(),
      })
      .where(eq(artworks.id, id));
    return { ok: true };
  });

  app.get('/artworks/:id/versions', { preHandler: app.requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const rows = await db
      .select()
      .from(artworkVersions)
      .where(eq(artworkVersions.artworkId, id))
      .orderBy(asc(artworkVersions.version));
    return { versions: rows };
  });
}

/* =============================================================
 *  MESSAGES
 * ============================================================= */

export async function messageRoutes(app: FastifyInstance) {
  app.get('/messages', { preHandler: app.requireAuth }, async (req) => {
    const ctx = getCtx(req);
    if (!ctx.orgId) throw new BadRequestError('Not signed in');
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.orgId, ctx.orgId))
      .orderBy(desc(messages.createdAt))
      .limit(100);
    return { messages: rows };
  });

  app.post('/messages', { preHandler: app.requireAuth }, async (req) => {
    const ctx = getCtx(req);
    if (!ctx.userId || !ctx.orgId) throw new BadRequestError('Not signed in');
    const body = z
      .object({
        threadId: z.string().uuid().optional(),
        body: z.string().min(1).max(5000),
        relatedToType: z.string().max(40).optional(),
        relatedToId: z.string().uuid().optional(),
      })
      .parse(req.body);

    // Generate threadId if new conversation
    const threadId = body.threadId ?? crypto.randomUUID();
    const [m] = await db
      .insert(messages)
      .values({
        orgId: ctx.orgId,
        threadId,
        fromUserId: ctx.userId,
        isFromOsuep: false,
        body: body.body,
        relatedToType: body.relatedToType,
        relatedToId: body.relatedToId,
      })
      .returning();
    return { message: m, threadId };
  });
}

/* =============================================================
 *  NOTIFICATIONS
 * ============================================================= */

export async function notificationRoutes(app: FastifyInstance) {
  app.get('/notifications', { preHandler: app.requireAuth }, async (req) => {
    const ctx = getCtx(req);
    if (!ctx.userId) throw new BadRequestError('Not signed in');
    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, ctx.userId))
      .orderBy(desc(notifications.createdAt))
      .limit(50);
    return { notifications: rows };
  });

  app.post('/notifications/:id/read', { preHandler: app.requireAuth }, async (req) => {
    const ctx = getCtx(req);
    if (!ctx.userId) throw new BadRequestError('Not signed in');
    const { id } = req.params as { id: string };
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.id, id), eq(notifications.userId, ctx.userId)));
    return { ok: true };
  });

  app.post('/notifications/read-all', { preHandler: app.requireAuth }, async (req) => {
    const ctx = getCtx(req);
    if (!ctx.userId) throw new BadRequestError('Not signed in');
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, ctx.userId), sql`read_at IS NULL`));
    return { ok: true };
  });
}

/* =============================================================
 *  FAVORITES (moved here from catalog for completeness)
 * ============================================================= */

export async function favoriteRoutes(app: FastifyInstance) {
  app.get('/favorites', { preHandler: app.requireAuth }, async (req) => {
    const ctx = getCtx(req);
    if (!ctx.userId) throw new BadRequestError('Not signed in');
    const rows = await db
      .select({
        productId: productFavorites.productId,
        createdAt: productFavorites.createdAt,
      })
      .from(productFavorites)
      .where(eq(productFavorites.userId, ctx.userId))
      .orderBy(desc(productFavorites.createdAt));
    return { favorites: rows };
  });
}
