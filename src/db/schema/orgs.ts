import { pgTable, text, timestamp, uuid, varchar, boolean, jsonb, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Organizations — the top-level tenant.
 * Per Vol II: "Support parent companies, multiple locations, departments, buyers,
 * approvers, finance contacts, and custom catalogs."
 */
export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 200 }).notNull(),
    slug: varchar('slug', { length: 80 }).notNull().unique(),
    type: varchar('type', { length: 50 }).notNull().default('company'),
    // e.g. 'school', 'hospital', 'hotel', 'government', 'enterprise', 'small_business'
    status: varchar('status', { length: 20 }).notNull().default('active'),
    // 'active' | 'suspended' | 'archived'

    // Optional profile fields
    taxId: varchar('tax_id', { length: 50 }),
    website: varchar('website', { length: 500 }),
    phone: varchar('phone', { length: 50 }),

    // Settings
    settings: jsonb('settings').$type<OrgSettings>().notNull().default(sql`'{}'::jsonb`),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slugIdx: index('orgs_slug_idx').on(t.slug),
    statusIdx: index('orgs_status_idx').on(t.status),
  }),
);

export type OrgSettings = {
  defaultCurrency?: string;
  defaultTimezone?: string;
  allowPrivateStore?: boolean;
  contractPricingEnabled?: boolean;
};

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;

/**
 * Locations — physical sites within an organization.
 * A single org can have many locations (e.g. a school district has many schools).
 */
export const locations = pgTable(
  'locations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 200 }).notNull(),
    code: varchar('code', { length: 50 }), // e.g. store number
    address1: varchar('address1', { length: 200 }),
    address2: varchar('address2', { length: 200 }),
    city: varchar('city', { length: 100 }),
    region: varchar('region', { length: 100 }),
    postalCode: varchar('postal_code', { length: 30 }),
    country: varchar('country', { length: 2 }).notNull().default('US'),
    isPrimary: boolean('is_primary').notNull().default(false),
    status: varchar('status', { length: 20 }).notNull().default('active'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index('locations_org_idx').on(t.orgId),
  }),
);

export type Location = typeof locations.$inferSelect;
export type NewLocation = typeof locations.$inferInsert;

/**
 * Departments — organizational units within a location.
 */
export const departments = pgTable(
  'departments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
    name: varchar('name', { length: 200 }).notNull(),
    code: varchar('code', { length: 50 }),
    status: varchar('status', { length: 20 }).notNull().default('active'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index('departments_org_idx').on(t.orgId),
  }),
);

export type Department = typeof departments.$inferSelect;
export type NewDepartment = typeof departments.$inferInsert;
