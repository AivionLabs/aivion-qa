import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import type { SchemaAnalysis, SchemaTable, SchemaColumn, SchemaForeignKey, SchemaIndex } from "./types.js";
import { callAi } from "./ai/caller.js";
import { schemaSummariesResultSchema } from "./schemas.js";
import type { QaConfig } from "./types.js";

const SCHEMA_QUERY = `
SELECT
  t.table_name,
  c.column_name,
  c.data_type,
  c.is_nullable,
  c.column_default
FROM information_schema.tables t
JOIN information_schema.columns c ON c.table_name = t.table_name AND c.table_schema = t.table_schema
WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
ORDER BY t.table_name, c.ordinal_position
`;

const FK_QUERY = `
SELECT
  tc.table_name,
  kcu.column_name,
  ccu.table_name AS foreign_table_name,
  ccu.column_name AS foreign_column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
ORDER BY tc.table_name
`;

const PK_QUERY = `
SELECT
  tc.table_name,
  kcu.column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'
ORDER BY tc.table_name
`;

const INDEX_QUERY = `
SELECT
  t.relname AS table_name,
  i.relname AS index_name,
  ix.indisunique AS is_unique,
  array_agg(a.attname ORDER BY k.n) AS column_names
FROM pg_class t
JOIN pg_index ix ON ix.indrelid = t.oid
JOIN pg_class i ON i.oid = ix.indexrelid
JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, n) ON true
JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
JOIN pg_namespace ns ON ns.oid = t.relnamespace
WHERE ns.nspname = 'public' AND NOT ix.indisprimary
GROUP BY t.relname, i.relname, ix.indisunique
ORDER BY t.relname, i.relname
`;

export async function learnSchema(config: QaConfig, qaToolDir: string): Promise<SchemaAnalysis> {
  const dbUrl = process.env[config.db.connectionStringEnv];
  if (!dbUrl) throw new Error(`Env var ${config.db.connectionStringEnv} is not set`);

  const pool = new Pool({ connectionString: dbUrl });

  try {
    console.log("Connecting to database...");
    const [colRows, fkRows, pkRows, idxRows] = await Promise.all([
      pool.query(SCHEMA_QUERY).then(r => r.rows),
      pool.query(FK_QUERY).then(r => r.rows),
      pool.query(PK_QUERY).then(r => r.rows),
      pool.query(INDEX_QUERY).then(r => r.rows),
    ]);

    const tables = buildTables(colRows, fkRows, pkRows, idxRows);
    const schemaHash = hashTables(tables);

    // Check if schema unchanged
    const schemaPath = join(qaToolDir, "schema.json");
    if (existsSync(schemaPath)) {
      const existing = JSON.parse(readFileSync(schemaPath, "utf8")) as SchemaAnalysis;
      if (existing.schemaHash === schemaHash) {
        console.log("Schema unchanged — using cached analysis.");
        return existing;
      }
    }

    console.log(`Analyzing ${tables.length} tables...`);
    const tablesWithSummaries = await addSemanticSummaries(tables, config);

    const analysis: SchemaAnalysis = {
      analyzedAt: new Date().toISOString(),
      schemaHash,
      tables: tablesWithSummaries,
    };

    mkdirSync(qaToolDir, { recursive: true });
    writeFileSync(schemaPath, JSON.stringify(analysis, null, 2));
    console.log(`Schema written to ${schemaPath}`);

    return analysis;
  } finally {
    await pool.end();
  }
}

function buildTables(
  colRows: Record<string, unknown>[],
  fkRows: Record<string, unknown>[],
  pkRows: Record<string, unknown>[],
  idxRows: Record<string, unknown>[],
): SchemaTable[] {
  const tableMap = new Map<string, SchemaTable>();

  for (const row of colRows) {
    const name = row.table_name as string;
    if (!tableMap.has(name)) {
      tableMap.set(name, { name, columns: [], primaryKey: [], foreignKeys: [], indexes: [] });
    }
    const table = tableMap.get(name)!;
    const col: SchemaColumn = {
      name: row.column_name as string,
      type: row.data_type as string,
      nullable: row.is_nullable === "YES",
      hasDefault: row.column_default != null,
    };
    table.columns.push(col);
  }

  for (const row of pkRows) {
    const table = tableMap.get(row.table_name as string);
    if (table) table.primaryKey.push(row.column_name as string);
  }

  for (const row of fkRows) {
    const table = tableMap.get(row.table_name as string);
    if (table) {
      const existing = table.foreignKeys.find(fk => fk.referencedTable === row.foreign_table_name);
      if (existing) {
        existing.columns.push(row.column_name as string);
        existing.referencedColumns.push(row.foreign_column_name as string);
      } else {
        const fk: SchemaForeignKey = {
          columns: [row.column_name as string],
          referencedTable: row.foreign_table_name as string,
          referencedColumns: [row.foreign_column_name as string],
        };
        table.foreignKeys.push(fk);
      }
    }
  }

  for (const row of idxRows) {
    const table = tableMap.get(row.table_name as string);
    if (table) {
      const idx: SchemaIndex = {
        name: row.index_name as string,
        columns: row.column_names as string[],
        unique: row.is_unique as boolean,
      };
      table.indexes.push(idx);
    }
  }

  return Array.from(tableMap.values());
}

async function addSemanticSummaries(tables: SchemaTable[], config: QaConfig): Promise<SchemaTable[]> {
  if (config.ai.mode === "off") {
    console.log("Skipping semantic summaries (ai.mode = off).");
    return tables;
  }

  const schemaText = tables.map(t => {
    const cols = t.columns.map(c => `  ${c.name} ${c.type}${c.nullable ? "" : " NOT NULL"}`).join("\n");
    const fks = t.foreignKeys.map(fk => `  FK: ${fk.columns.join(",")} → ${fk.referencedTable}(${fk.referencedColumns.join(",")})`).join("\n");
    return `Table: ${t.name}\n${cols}${fks ? "\n" + fks : ""}`;
  }).join("\n\n");

  const systemPrompt = `You are a database analyst. Given a Postgres schema, write a one-sentence semantic summary for each table describing its domain purpose (e.g. "Junction table linking users to companies with RBAC roles"). Return JSON: { "summaries": { "<table_name>": "<summary>", ... } }`;

  const userPrompt = `Schema:\n${schemaText}\n\nReturn JSON only.`;

  try {
    const result = await callAi({
      config: config.ai,
      task: "compile",
      systemPrompt,
      userPrompt,
      schema: schemaSummariesResultSchema,
    });

    const summaries = result.data.summaries ?? {};
    return tables.map(t => ({
      ...t,
      semanticSummary: summaries[t.name] ?? undefined,
    }));
  } catch (err) {
    console.warn("Warning: could not generate semantic summaries:", (err as Error).message);
    return tables;
  }
}

function hashTables(tables: SchemaTable[]): string {
  const str = JSON.stringify(tables.map(t => ({ name: t.name, columns: t.columns, foreignKeys: t.foreignKeys })));
  return createHash("sha256").update(str).digest("hex").slice(0, 16);
}
