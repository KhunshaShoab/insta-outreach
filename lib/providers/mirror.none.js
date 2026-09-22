// Mirror adapter: disabled. Keeps the capability resolvable when SHEETS_ENABLED=false.
export function create() {
  return {
    columns: [],
    async upsertRows() {
      return { updated: 0, appended: 0, skipped: true };
    }
  };
}
