import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// The build contract is docs/plans/2026-09-11-vitrina-public-shelves.md in the
// monorepo, section 3.2, and these tables are that listing verbatim.
//
// One document per book rather than one document per shelf: a whole shelf in
// one row would sit against the 1 MiB document limit and the 8192 element
// array limit, and every edit would rewrite every book. Catalogue books store
// only their id; the browser resolves the record from library.json or
// catalog.json, so nothing from the catalogue is copied per person.
//
// tests/support/fakedb.mjs parses this file for its index and field lists, so
// a core that reads an index or writes a field not declared here fails
// make validate the way it would fail on a deployment.
export default defineSchema({
  profiles: defineTable({
    clerkSubject: v.string(),
    handle: v.union(v.string(), v.null()),
    published: v.boolean(),
    suspendedAt: v.union(v.number(), v.null()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_subject", ["clerkSubject"]).index("by_handle", ["handle"]),

  entries: defineTable({
    clerkSubject: v.string(),
    key: v.string(),
    catalogId: v.union(v.number(), v.null()),
    shelf: v.union(v.string(), v.null()),
    note: v.union(v.string(), v.null()),
    listedAs: v.union(v.string(), v.null()),
    added: v.union(v.string(), v.null()),
    record: v.union(v.any(), v.null()),
    updatedAt: v.number(),
  }).index("by_owner", ["clerkSubject"]).index("by_owner_key", ["clerkSubject", "key"]),

  shelfMeta: defineTable({ clerkSubject: v.string(), count: v.number() }).index("by_subject", ["clerkSubject"]),
  heldHandles: defineTable({ handle: v.string(), until: v.number() }).index("by_handle", ["handle"]),
  erasures: defineTable({ clerkSubject: v.string(), at: v.number() }).index("by_subject", ["clerkSubject"]),
  suspendedSubjects: defineTable({ clerkSubject: v.string(), since: v.number() }).index("by_subject", ["clerkSubject"]),
  rateEvents: defineTable({ bucket: v.string(), at: v.number() })
    .index("by_bucket_at", ["bucket", "at"]).index("by_at", ["at"]),
});
