import { z } from "zod";

// Intentionally loose. We enforce the skeleton that the runner relies on and
// `.passthrough()` everything else so the LLM's incidental shape variations
// (extra fields, wrapped values, etc.) don't abort the compile.

export const irSchema = z
  .object({
    meta: z
      .object({
        plan: z.string(),
        planHash: z.string().optional(),
        compiledAt: z.string().optional(),
        testUser: z
          .object({
            email: z.string(),
            password: z.string().optional(),
          })
          .passthrough(),
        environments: z.record(z.any()),
        fakeNow: z.string().optional(),
      })
      .passthrough(),
    setup: z
      .object({
        auth: z.object({
          createUser: z.object({ email: z.string(), via: z.string() }),
        }).optional(),
        seedSql: z.array(z.string()).optional(),
        cleanupUserData: z.boolean().optional(),
        signIn: z.enum(["ui", "ticket", "none"]).optional(),
        signInFlow: z.array(z.any()).optional(),
      })
      .passthrough()
      .optional(),
    cases: z.array(
      z
        .object({
          id: z.union([z.string(), z.number()]).transform(String),
          title: z.string(),
          expectedFail: z.object({ bug: z.string() }).optional(),
          inferred: z.array(z.string()).optional(),
          actions: z.array(z.any()).optional(),
          asserts: z.array(z.any()).optional(),
        })
        .passthrough(),
    ).optional(),
    groups: z.array(
      z.object({
        url: z.string(),
        cases: z.array(
          z.object({
            id: z.union([z.string(), z.number()]).transform(String),
            title: z.string(),
            expectedFail: z.object({ bug: z.string() }).optional(),
            inferred: z.array(z.string()).optional(),
            actions: z.array(z.any()).optional(),
            asserts: z.array(z.any()).optional(),
          }).passthrough(),
        ),
      }).passthrough(),
    ).optional(),
    teardown: z
      .object({
        sql: z
          .array(
            z
              .object({
                sql: z.string(),
                params: z.array(z.any()).optional(),
              })
              .passthrough(),
          )
          .optional(),
        auth: z.any().optional(),
        cleanupUserData: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const aiCheckResultSchema = z.object({
  pass: z.boolean(),
  reason: z.string(),
});

export const schemaSummariesResultSchema = z.object({
  summaries: z.record(z.string()),
});
