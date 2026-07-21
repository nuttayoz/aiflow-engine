export const quoteSchema = (schema: string): string => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
    throw new Error('DATABASE_SCHEMA_INVALID');
  }

  return `"${schema}"`;
};

export const table = (schema: string, name: string): string =>
  `${quoteSchema(schema)}."${name}"`;

export const mutationRows = <TRow>(result: unknown): TRow[] => {
  if (
    Array.isArray(result) &&
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  ) {
    return result[0] as TRow[];
  }

  if (Array.isArray(result)) {
    return result as TRow[];
  }

  throw new Error('DATABASE_MUTATION_RESULT_INVALID');
};
