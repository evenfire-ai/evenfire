export type QueryResultRow = {
  [key: string]: unknown;
};

export type QueryResultLike<T extends QueryResultRow = QueryResultRow> = {
  rows: T[];
  rowCount: number | null;
};

export type DbClient = {
  query: (text: string, values?: unknown[]) => Promise<QueryResultLike>;
};
