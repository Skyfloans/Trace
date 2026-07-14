export class QueryParameters {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  addArray(values: unknown[]): string {
    return this.add(values);
  }
}
