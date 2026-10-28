/**
 * Orders strings by UTF-16 code units, as `<` does. Protocol data never uses
 * `localeCompare`, whose order depends on the host's collation.
 */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
