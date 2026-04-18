import type { SchemaAnalysis, SchemaTable } from "./types.js";

/**
 * FK graph utilities for schema-aware operations. Given a SchemaAnalysis
 * and a root table (usually "users"), compute:
 *
 *   - `computeDeleteOrder(root, exclude)` — topological order for cleanup.
 *   - `findFkPath(from, to)` — shortest FK path between two tables.
 *   - `buildUserScope(graph, userTable, emailCol, target)` — a WHERE-clause
 *     fragment that scopes rows in `target` to the test user.
 */

export interface FkEdge {
  /** "up" = from a child to its parent (child.fromColumn FK → parent.toColumn PK).
   *  "down" = from a parent to one of its children. */
  direction: "up" | "down";
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

export interface FkGraph {
  tables: Map<string, SchemaTable>;
  childrenOf: Map<string, FkEdge[]>;   // edges going "down"
  parentsOf: Map<string, FkEdge[]>;    // edges going "up"
}

export function buildFkGraph(schema: SchemaAnalysis): FkGraph {
  const tables = new Map<string, SchemaTable>();
  const childrenOf = new Map<string, FkEdge[]>();
  const parentsOf = new Map<string, FkEdge[]>();

  for (const t of schema.tables) {
    tables.set(t.name, t);
    childrenOf.set(t.name, []);
    parentsOf.set(t.name, []);
  }

  for (const t of schema.tables) {
    for (const fk of t.foreignKeys) {
      // MVP: single-column FKs only. Composite FKs are rare in modern apps;
      // users with them fall back to raw SQL.
      const fromCol = fk.columns[0];
      const toCol = fk.referencedColumns[0];
      if (!fromCol || !toCol) continue;

      parentsOf.get(t.name)!.push({
        direction: "up",
        fromTable: t.name, fromColumn: fromCol,
        toTable: fk.referencedTable, toColumn: toCol,
      });

      if (!childrenOf.has(fk.referencedTable)) childrenOf.set(fk.referencedTable, []);
      childrenOf.get(fk.referencedTable)!.push({
        direction: "down",
        fromTable: fk.referencedTable, fromColumn: toCol,
        toTable: t.name, toColumn: fromCol,
      });
    }
  }

  return { tables, childrenOf, parentsOf };
}

/**
 * Walk downward from `root`, returning all tables that transitively reference
 * `root`. Result is leaf-first so DELETE statements execute in FK-safe order.
 * `root` is the last entry. Tables in `exclude` are skipped entirely.
 */
export function computeDeleteOrder(
  graph: FkGraph,
  root: string,
  exclude: Set<string> = new Set(),
): string[] {
  if (!graph.tables.has(root)) throw new Error(`Unknown root table: ${root}`);

  // BFS from root, only following "down" edges (parent → child).
  const reachable = new Set<string>([root]);
  const queue: string[] = [root];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const edge of graph.childrenOf.get(cur) ?? []) {
      if (!reachable.has(edge.toTable) && !exclude.has(edge.toTable)) {
        reachable.add(edge.toTable);
        queue.push(edge.toTable);
      }
    }
  }

  // Topological sort on the subgraph induced by `reachable`, parent-first.
  const inDegree = new Map<string, number>();
  for (const t of reachable) inDegree.set(t, 0);
  for (const t of reachable) {
    for (const edge of graph.childrenOf.get(t) ?? []) {
      if (reachable.has(edge.toTable)) {
        inDegree.set(edge.toTable, (inDegree.get(edge.toTable) ?? 0) + 1);
      }
    }
  }

  const ready: string[] = [];
  for (const [t, deg] of inDegree) if (deg === 0) ready.push(t);

  const sorted: string[] = [];
  while (ready.length) {
    const t = ready.shift()!;
    sorted.push(t);
    for (const edge of graph.childrenOf.get(t) ?? []) {
      if (!reachable.has(edge.toTable)) continue;
      const d = (inDegree.get(edge.toTable) ?? 0) - 1;
      inDegree.set(edge.toTable, d);
      if (d === 0) ready.push(edge.toTable);
    }
  }

  if (sorted.length !== reachable.size) {
    // Cycle (e.g. self-ref like users.invited_by → users.id). Return a
    // best-effort reverse-BFS order and let individual DELETEs handle failure.
    return Array.from(reachable).reverse();
  }

  return sorted.reverse(); // leaf-first
}

/**
 * BFS-shortest path in either direction. Returns an ordered list of edges
 * (where `edges[0].fromTable === from` and the last edge's `toTable === to`),
 * or null if no path exists.
 */
export function findFkPath(graph: FkGraph, from: string, to: string): FkEdge[] | null {
  if (from === to) return [];

  const visited = new Set<string>([from]);
  const queue: Array<{ table: string; path: FkEdge[] }> = [{ table: from, path: [] }];

  while (queue.length) {
    const { table, path } = queue.shift()!;
    const edges = [
      ...(graph.parentsOf.get(table) ?? []),
      ...(graph.childrenOf.get(table) ?? []),
    ];
    for (const edge of edges) {
      if (visited.has(edge.toTable)) continue;
      const next = [...path, edge];
      if (edge.toTable === to) return next;
      visited.add(edge.toTable);
      queue.push({ table: edge.toTable, path: next });
    }
  }
  return null;
}

/**
 * Build a WHERE-clause fragment that filters rows in `targetTable` to those
 * belonging to the test user (identified by `users.email = $1`).
 *
 * Uses nested EXISTS subqueries — readable and robust against column-name
 * collisions. Returns null if no FK path exists from target to userTable.
 *
 * Example outputs:
 *   target=users:
 *     users.email = $1
 *   target=user_companies (direct FK to users):
 *     EXISTS (SELECT 1 FROM users WHERE users.id = user_companies.user_id AND users.email = $1)
 *   target=companies (via user_companies):
 *     EXISTS (SELECT 1 FROM user_companies WHERE user_companies.company_id = companies.id
 *             AND EXISTS (SELECT 1 FROM users WHERE users.id = user_companies.user_id AND users.email = $1))
 */
export function buildUserScope(
  graph: FkGraph,
  userTable: string,
  userEmailColumn: string,
  targetTable: string,
): string | null {
  if (targetTable === userTable) {
    return `${userTable}.${userEmailColumn} = $1`;
  }

  const path = findFkPath(graph, targetTable, userTable);
  if (!path) return null;

  const buildExists = (idx: number, outerTable: string): string => {
    const edge = path[idx]!;
    // For both up/down edges, the join condition is always the same shape:
    // inner.<toColumn> = outer.<fromColumn>
    const innerTable = edge.toTable;
    const joinCond = `${innerTable}.${edge.toColumn} = ${outerTable}.${edge.fromColumn}`;
    const innerScope = idx === path.length - 1
      ? `${userTable}.${userEmailColumn} = $1`
      : buildExists(idx + 1, innerTable);
    return `EXISTS (SELECT 1 FROM ${innerTable} WHERE ${joinCond} AND ${innerScope})`;
  };

  return buildExists(0, targetTable);
}
